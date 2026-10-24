import type { BatchOp, Item, ItemStore } from '@portfolio/platform';
import { ENTITY, T212_QUOTE_STATUS_ENTITY, brokerKeys, fromItem, keys, majorEod, majorQuote, type EodPrice, type Quote, type T212QuoteStatus } from '@portfolio/shared';

/** What the Trading 212 quote refresh stores: the latest quotes and its own status (the back-off and `GET /prices/status` read it). */
export interface QuoteStore {
  /** The stored latest quote of every symbol that has a valid one. */
  latest(symbols: readonly string[]): Promise<Map<string, Quote>>;
  getStatus(userId: string): Promise<T212QuoteStatus | null>;
  /** The symbols among `symbols` that have an EOD row on `day` (one batched read), with its `source` (undefined: a market-data provider's row). */
  eodSources(symbols: readonly string[], day: string): Promise<Map<string, string | undefined>>;
  /** The quotes, the status and the end-of-day rows of one run as ONE batched write (rows written = quotes + 1 + rows). */
  save(quotes: readonly Quote[], status: T212QuoteStatus, eod?: readonly EodPrice[]): Promise<void>;
}

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The same item the price service writes (`PriceRepository.putQuotes`), so the API reads it like any other quote. */
export const quoteItem = (quote: Quote): Item => ({ ...keys.quote(quote.symbol), entityType: ENTITY.quote, ...quote });

/** The same item the price service writes (`eodItem` of `@portfolio/prices`), here with its `source`; always in major units. */
export const eodItem = (row: EodPrice): Item => ({ ...keys.eod(row.symbol, row.date), entityType: ENTITY.eod, ...majorEod(row) });

/** A quote stored in a minor unit before the providers rescaled at the source is read in major units. */
function readQuote(item: Item): Quote | undefined {
  const price = numberOf(item.price);
  const previousClose = numberOf(item.previousClose);
  if (typeof item.symbol !== 'string' || price === undefined || previousClose === undefined) return undefined;
  if (typeof item.currency !== 'string' || typeof item.asOf !== 'string') return undefined;
  return majorQuote({ symbol: item.symbol, price, previousClose, currency: item.currency, asOf: item.asOf, source: typeof item.source === 'string' ? item.source : '' });
}

/** QuoteStore on an ItemStore: the key scheme of the quote and status items, whatever the storage. */
export class ItemQuoteStore implements QuoteStore {
  constructor(private readonly store: ItemStore) {}

  async latest(symbols: readonly string[]): Promise<Map<string, Quote>> {
    if (symbols.length === 0) return new Map();
    const items = await this.store.getMany(symbols.map((symbol) => keys.quote(symbol)));
    const quotes = items.map((item) => readQuote(item)).filter((quote): quote is Quote => quote !== undefined);
    return new Map(quotes.map((quote) => [quote.symbol, quote]));
  }

  async getStatus(userId: string): Promise<T212QuoteStatus | null> {
    const item = await this.store.get(brokerKeys.quoteStatus(userId));
    return item ? fromItem<T212QuoteStatus>(item) : null;
  }

  async eodSources(symbols: readonly string[], day: string): Promise<Map<string, string | undefined>> {
    if (symbols.length === 0) return new Map();
    const items = await this.store.getMany(symbols.map((symbol) => keys.eod(symbol, day)));
    return new Map(items.map((item) => [item.PK.slice(keys.tickerPk('').length), typeof item.source === 'string' ? item.source : undefined]));
  }

  async save(quotes: readonly Quote[], status: T212QuoteStatus, eod: readonly EodPrice[] = []): Promise<void> {
    const statusItem: Item = { ...brokerKeys.quoteStatus(status.userId), entityType: T212_QUOTE_STATUS_ENTITY, ...status };
    const puts: BatchOp[] = [
      ...quotes.map((quote): BatchOp => ({ type: 'put', item: quoteItem(quote) })),
      ...eod.map((row): BatchOp => ({ type: 'put', item: eodItem(row) })),
      { type: 'put', item: statusItem },
    ];
    await this.store.batchWrite(puts);
  }
}
