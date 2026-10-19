import { cond, queryAll, type BatchOp, type Item, type ItemStore } from '@portfolio/platform';
import { CALENDAR_ENTITY, ENTITY, calendarKeys, keys, type DividendEvent, type EodPrice, type FxDay, type FxRates, type InstrumentProfile, type Quote, type StoredEarningsEvent, type StoredSplitEvent } from '@portfolio/shared';
import { StoreQuotaLedger } from './limits.js';
import { profileDetails } from './models.js';
import { byText, definedOnly } from './parse.js';

/** Calendar items kept next to the ticker items (the Python `calendar_models.py` layout). */
export const CALENDAR_STATE_ENTITY = 'CALENDAR_STATE';
export const CALENDAR_BUDGET_ENTITY = 'CALENDAR_BUDGET';
export const STATE_SK = 'CAL#STATE';
export const BUDGET_PK = 'CALENDAR';

export const stateKey = (symbol: string) => ({ PK: calendarKeys.tickerPk(symbol), SK: STATE_SK });
export const budgetKey = (provider: string) => ({ PK: BUDGET_PK, SK: `BUDGET#${provider}` });

const TICKER_PREFIX = 'TICKER#';
const FAR_FUTURE = '9999-12-31';

/** Per-symbol calendar marker: when splits/dividends were last checked, or last failed. */
export interface CalendarState {
  splitsCheckedAt?: string;
  dividendsCheckedAt?: string;
  splitsFailedAt?: string;
}

export const quoteItem = (quote: Quote): Item => ({ ...keys.quote(quote.symbol), entityType: ENTITY.quote, ...definedOnly(quote) });
export const eodItem = (eod: EodPrice): Item => ({ ...keys.eod(eod.symbol, eod.date), entityType: ENTITY.eod, ...definedOnly(eod) });
export const profileItem = (profile: InstrumentProfile): Item => ({ ...keys.profile(profile.symbol), entityType: ENTITY.profile, ...definedOnly(profile) });
export const dividendItem = (event: DividendEvent): Item => ({ ...keys.dividendEvent(event.symbol, event.exDate), entityType: ENTITY.dividendEvent, ...definedOnly(event) });
export const fxItem = (fx: FxRates): Item => ({ ...keys.fx(fx.base), entityType: ENTITY.fx, base: fx.base, asOf: fx.asOf, rates: { ...fx.rates } });
export const trackedItem = (symbol: string, now: string): Item => ({ ...keys.trackedTicker(symbol), entityType: ENTITY.trackedTicker, symbol, createdAt: now, updatedAt: now });

/** `FX_DAY` item: the rates sorted by currency, the base excluded. */
export function fxDayItem(day: FxDay): Item {
  const rates = Object.fromEntries(
    Object.entries(day.rates)
      .filter(([currency]) => currency !== day.base)
      .toSorted(([a], [b]) => byText(a, b)),
  );
  return { ...keys.fxDay(day.base, day.date), entityType: ENTITY.fxDay, base: day.base, date: day.date, rates };
}

export const earningsItem = (event: StoredEarningsEvent, updatedAt: string): Item => ({
  ...calendarKeys.earnings(event.symbol, event.date),
  entityType: CALENDAR_ENTITY.earnings,
  ...definedOnly({ ...event, timeOfDay: event.timeOfDay ?? 'unknown', updatedAt }),
});

export const splitItem = (event: StoredSplitEvent, updatedAt: string): Item => ({
  ...calendarKeys.split(event.symbol, event.date),
  entityType: CALENDAR_ENTITY.split,
  ...definedOnly({ ...event, updatedAt }),
});

/** Puts of items with distinct keys (a store batch must not repeat a key; the last item for a key wins). */
function putOps(items: readonly Item[]): BatchOp[] {
  const byKey = new Map<string, Item>();
  for (const item of items) byKey.set(`${item.PK}\u0000${item.SK}`, item);
  return [...byKey.values()].map((item) => ({ type: 'put', item }));
}

const symbolOfPk = (item: Item): string => item.PK.slice(TICKER_PREFIX.length);

/** The symbol of a TRACKED item: its attribute, else the sort key (`TICKER#AAPL`). */
function trackedSymbol(item: Item): string {
  if (typeof item.symbol === 'string' && item.symbol !== '') return item.symbol;
  return item.SK.startsWith(TICKER_PREFIX) ? item.SK.slice(TICKER_PREFIX.length) : '';
}

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Reads and writes the market-data items of the single table through the ItemStore port. */
export class PriceRepository {
  constructor(private readonly store: ItemStore) {}

  /** Every tracked symbol (holdings and watchlist), sorted. */
  async listTracked(): Promise<string[]> {
    const items = await queryAll(this.store, { pk: keys.trackedPk });
    return [...new Set(items.map(trackedSymbol).filter((symbol) => symbol !== ''))].toSorted(byText);
  }

  /** Latest stored quote per symbol; corrupt items are ignored. */
  async latestQuotes(symbols: readonly string[]): Promise<Map<string, Quote>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => keys.quote(symbol)));
    const out = new Map<string, Quote>();
    for (const item of items) {
      const price = numberOf(item.price);
      const previousClose = numberOf(item.previousClose);
      if (typeof item.symbol !== 'string' || price === null || previousClose === null || typeof item.currency !== 'string' || typeof item.asOf !== 'string') continue;
      out.set(item.symbol, { symbol: item.symbol, price, previousClose, currency: item.currency, asOf: item.asOf, source: typeof item.source === 'string' ? item.source : '' });
    }
    return out;
  }

  /** The symbols among `symbols` that already have a PROFILE item (the "enriched" marker). */
  async symbolsWithProfile(symbols: readonly string[]): Promise<Set<string>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return new Set(items.map(symbolOfPk));
  }

  /** Symbols with a PROFILE whose optional details were never fetched or before `cutoff`, never-fetched first. */
  async staleProfileDetails(symbols: readonly string[], cutoff: string): Promise<string[]> {
    if (symbols.length === 0) return [];
    const items = await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return items
      .map((item) => ({ fetched: typeof item.detailsAsOf === 'string' ? item.detailsAsOf : '', symbol: symbolOfPk(item) }))
      .filter(({ fetched }) => fetched < cutoff)
      .toSorted((a, b) => byText(a.fetched, b.fetched) || byText(a.symbol, b.symbol))
      .map(({ symbol }) => symbol);
  }

  /**
   * Stores only the optional details (and their fetch date) on the existing PROFILE item, so a refresh can never degrade the
   * name/sector/country written at enrichment. `profile` null = nothing found. Throws when the PROFILE item does not exist.
   */
  async putProfileDetails(symbol: string, profile: InstrumentProfile | null, asOf: string): Promise<void> {
    const updated = await this.store.update(keys.profile(symbol), { set: { ...profileDetails(profile), detailsAsOf: asOf } }, { condition: cond.exists });
    if (updated === undefined) throw new Error(`No PROFILE item for ${symbol}`);
  }

  async putQuotes(quotes: readonly Quote[]): Promise<void> {
    await this.store.batchWrite(putOps(quotes.flatMap((quote) => [quoteItem(quote), eodItem({ symbol: quote.symbol, date: quote.asOf.slice(0, 10), close: quote.price, currency: quote.currency })])));
  }

  putQuote(quote: Quote): Promise<boolean> {
    return this.store.put(quoteItem(quote));
  }

  putProfile(profile: InstrumentProfile): Promise<boolean> {
    return this.store.put(profileItem(profile));
  }

  putFx(fx: FxRates): Promise<boolean> {
    return this.store.put(fxItem(fx));
  }

  /** Date of the newest stored FX_DAY item of `base`, or null. */
  async latestFxDay(base: string): Promise<string | null> {
    const page = await this.store.query({ pk: `FX#${base}`, sk: { beginsWith: keys.fxDayPrefix }, reverse: true, limit: 1 });
    const sk = page.items[0]?.SK;
    return sk === undefined ? null : sk.slice(keys.fxDayPrefix.length);
  }

  async putFxDays(days: readonly FxDay[]): Promise<number> {
    const ops = putOps(days.map((day) => fxDayItem(day)));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  async putEods(rows: readonly EodPrice[]): Promise<number> {
    const ops = putOps(rows.map(eodItem));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  async putDividends(events: readonly DividendEvent[]): Promise<number> {
    const ops = putOps(events.map(dividendItem));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  /** Creates the TRACKED item when absent. Resolves true when it was created. */
  ensureTracked(symbol: string, addedAt: string): Promise<boolean> {
    return this.store.put(trackedItem(symbol, addedAt), { condition: cond.notExists });
  }

  // --- calendar ---

  async putEarnings(events: readonly StoredEarningsEvent[], updatedAt: string): Promise<number> {
    const ops = putOps(events.map((event) => earningsItem(event, updatedAt)));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  async putSplits(events: readonly StoredSplitEvent[], updatedAt: string): Promise<number> {
    const ops = putOps(events.map((event) => splitItem(event, updatedAt)));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  /** Dates of the stored upcoming earnings of `symbol` that are not in `keep` (the company moved its report). */
  async staleEarningsDates(symbol: string, today: string, keep: ReadonlySet<string>): Promise<string[]> {
    const items = await queryAll(this.store, { pk: calendarKeys.tickerPk(symbol), sk: { between: [`${calendarKeys.earningsPrefix}${today}`, `${calendarKeys.earningsPrefix}${FAR_FUTURE}`] } });
    return items
      .map((item) => item.SK.slice(calendarKeys.earningsPrefix.length))
      .filter((date) => !keep.has(date))
      .toSorted(byText);
  }

  async deleteEarnings(symbol: string, dates: readonly string[]): Promise<number> {
    await this.store.batchWrite(dates.map((date) => ({ type: 'delete', key: calendarKeys.earnings(symbol, date) })));
    return dates.length;
  }

  /** Per-symbol `CAL#STATE` markers; symbols without a marker are absent. */
  async getStates(symbols: readonly string[]): Promise<Map<string, CalendarState>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => stateKey(symbol)));
    return new Map(
      items.map((item) => [
        symbolOfPk(item),
        definedOnly<CalendarState>({
          splitsCheckedAt: typeof item.splitsCheckedAt === 'string' ? item.splitsCheckedAt : undefined,
          dividendsCheckedAt: typeof item.dividendsCheckedAt === 'string' ? item.dividendsCheckedAt : undefined,
          splitsFailedAt: typeof item.splitsFailedAt === 'string' ? item.splitsFailedAt : undefined,
        }),
      ]),
    );
  }

  /**
   * Spends `calls` of the provider's calendar budget for `day` (`CALENDAR/BUDGET#{provider}`: `{day, used, tokens?}`). False,
   * with nothing spent, when it would exceed `limit`; a new day starts at zero. The same `token` pays only once per day.
   */
  consumeBudget(provider: string, day: string, calls: number, limit: number, token?: string): Promise<boolean> {
    return new StoreQuotaLedger(this.store).consume(budgetKey(provider), CALENDAR_BUDGET_ENTITY, day, calls, limit, token);
  }

  /** Sets marker attributes without touching the others. */
  async putState(symbol: string, attrs: CalendarState): Promise<void> {
    await this.store.update(stateKey(symbol), { set: { entityType: CALENDAR_STATE_ENTITY, symbol, ...definedOnly(attrs) } });
  }
}
