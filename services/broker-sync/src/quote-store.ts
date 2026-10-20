import type { BatchOp, Item, ItemStore } from '@portfolio/platform';
import { ENTITY, T212_QUOTE_STATUS_ENTITY, brokerKeys, fromItem, keys, type Quote, type T212QuoteStatus } from '@portfolio/shared';

/** What the Trading 212 quote refresh stores: the latest quotes and its own status (the back-off and `GET /prices/status` read it). */
export interface QuoteStore {
  /** The stored latest quote of every symbol that has a valid one. */
  latest(symbols: readonly string[]): Promise<Map<string, Quote>>;
  getStatus(userId: string): Promise<T212QuoteStatus | null>;
  /** The quotes and the status of one run as ONE batched write (rows written = quotes + 1). */
  save(quotes: readonly Quote[], status: T212QuoteStatus): Promise<void>;
}

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The same item the price service writes (`PriceRepository.putQuotes`), so the API reads it like any other quote. */
export const quoteItem = (quote: Quote): Item => ({ ...keys.quote(quote.symbol), entityType: ENTITY.quote, ...quote });

function readQuote(item: Item): Quote | undefined {
  const price = numberOf(item.price);
  const previousClose = numberOf(item.previousClose);
  if (typeof item.symbol !== 'string' || price === undefined || previousClose === undefined) return undefined;
  if (typeof item.currency !== 'string' || typeof item.asOf !== 'string') return undefined;
  return { symbol: item.symbol, price, previousClose, currency: item.currency, asOf: item.asOf, source: typeof item.source === 'string' ? item.source : '' };
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

  async save(quotes: readonly Quote[], status: T212QuoteStatus): Promise<void> {
    const statusItem: Item = { ...brokerKeys.quoteStatus(status.userId), entityType: T212_QUOTE_STATUS_ENTITY, ...status };
    const puts: BatchOp[] = [...quotes.map((quote): BatchOp => ({ type: 'put', item: quoteItem(quote) })), { type: 'put', item: statusItem }];
    await this.store.batchWrite(puts);
  }
}
