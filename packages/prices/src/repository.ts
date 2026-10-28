import { cond, queryAll, type BatchOp, type Item, type ItemStore } from '@portfolio/platform';
import { CALENDAR_ENTITY, EARNINGS_RUN_ENTITY, ENTITY, earningsRunKeys, HISTORY_OVERRIDE_STATUSES, calendarKeys, isProfileSource, keys, majorDividend, majorEod, majorQuote, mergeProfile, minorUnit, sourceOf, type DividendEvent, type EarningsRunRecord, type EodPrice, type FxDay, type FxRates, type HistoryOverrideStatus, type InstrumentProfile, type ProfileSource, type Quote, type StoredEarningsEvent, type StoredSplitEvent } from '@portfolio/shared';
import { BlockBook, StoreQuotaLedger, type ProviderBlock } from './limits.js';
import { profileDetails } from './models.js';
import { byText, definedOnly } from './parse.js';

/** Calendar items kept next to the ticker items (the Python `calendar_models.py` layout). */
export const CALENDAR_STATE_ENTITY = 'CALENDAR_STATE';
export const CALENDAR_BUDGET_ENTITY = 'CALENDAR_BUDGET';
export const STATE_SK = 'CAL#STATE';
export const BUDGET_PK = 'CALENDAR';

export const stateKey = (symbol: string) => ({ PK: calendarKeys.tickerPk(symbol), SK: STATE_SK });
export const budgetKey = (provider: string) => ({ PK: BUDGET_PK, SK: `BUDGET#${provider}` });

export const ENRICH_STATE_ENTITY = 'ENRICH_STATE';
/** What an attempt counter counts: the enrichment of a symbol (`core`), the lookup of its provider profile (`profile`) or the fetch of its history under the owner's history symbol (`override`). */
export type AttemptKind = 'core' | 'profile' | 'override';
/** How a try ended: `retry` (a transient failure, worth trying again later) or `skipped` (the symbol is unknown or unavailable: trying again changes nothing). */
export type AttemptOutcome = 'retry' | 'skipped';

/** The tries of one day of a symbol. */
export interface Attempts {
  count: number;
  /** Whether the last try ended `skipped`. */
  skipped: boolean;
}
/** The last try recorded for a symbol (see `lastAttempts`). */
export interface LastAttempt {
  day: string;
  attempts: number;
  outcome: AttemptOutcome;
  error: string;
}
/** Marks the day the fixings before the oldest stored one were last looked for (see `runFx`). */
export const fxFrontKey = { PK: 'USAGE', SK: 'FX#front' } as const;
export const healKey = { PK: 'USAGE', SK: 'ENRICH#HEAL' } as const;
/** Marks the one-time repair of stored minor-unit prices (pence) as done. */
export const minorUnitRepairKey = { PK: 'USAGE', SK: 'REPAIR#minor-units-v1' } as const;

/** Rows a repair step read and rewrote. */
export interface RepairRows {
  read: number;
  written: number;
}

const PRICE_FIELDS = ['close', 'price', 'previousClose'] as const;

/** The item with its prices in the major currency, or undefined when its currency is no minor unit (nothing to rewrite). */
function rescaledItem(item: Item): Item | undefined {
  const minor = minorUnit(item.currency);
  if (minor === null) return undefined;
  const out: Record<string, unknown> = { ...item, currency: minor.currency };
  for (const field of PRICE_FIELDS) {
    const value = item[field];
    if (typeof value === 'number') out[field] = value / minor.divisor;
  }
  return out as Item;
}
/** What the search by ISIN found, stored once per ISIN (`listing` null: nothing usable). */
export interface ProxyRecord {
  isin: string;
  /** The (major) currency of the held symbol the listing was chosen for. */
  currency: string;
  listing: string | null;
  checkedOn: string;
}

/** The listing chosen for an ISIN when the provider has no data for the held symbol (see `proxyHistory`). */
export const PROXY_LISTING_ENTITY = 'PROXY_LISTING';
export const proxyKey = (isin: string) => ({ PK: `ISIN#${isin}`, SK: 'PROXY' });
/** The price history symbol the owner set for a held symbol and what became of it (one item per held symbol, written when the owner saves it). */
export interface HistorySymbolRecord {
  symbol: string;
  historySymbol: string;
  status: HistoryOverrideStatus;
  reason: string | null;
  /** When the owner set it. */
  setAt: string;
}

export const HISTORY_SYMBOL_ENTITY = 'HISTORY_SYMBOL';
export const historySymbolKey = (symbol: string) => ({ PK: calendarKeys.tickerPk(symbol), SK: 'HISTSYM' });

export const attemptKey = (symbol: string, kind: AttemptKind) => ({ PK: calendarKeys.tickerPk(symbol), SK: `ENRICH#${kind}` });
const MAX_ERROR_CHARS = 200;

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

/** The source a stored PROFILE item says it comes from (none: a provider profile). */
const sourceOfItem = (item: Item): ProfileSource => sourceOf({ profileSource: isProfileSource(item.profileSource) ? item.profileSource : undefined });

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
      out.set(item.symbol, majorQuote({ symbol: item.symbol, price, previousClose, currency: item.currency, asOf: item.asOf, source: typeof item.source === 'string' ? item.source : '' }));
    }
    return out;
  }

  /** The names of the stored profiles of `symbols` (a symbol without a profile, or whose profile has no name, is absent). */
  async profileNames(symbols: readonly string[]): Promise<Map<string, string>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return new Map(items.filter((item) => typeof item.name === 'string' && item.name.trim() !== '').map((item) => [symbolOfPk(item), String(item.name)]));
  }

  /** The symbols among `symbols` that already have a PROFILE item. */
  async symbolsWithProfile(symbols: readonly string[]): Promise<Set<string>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return new Set(items.map(symbolOfPk));
  }

  /**
   * The symbols among `symbols` the enrichment job has finished: their history is stored. That is every profile that does not say
   * where it comes from (written by the enrichment before sources existed) and every one the job stamped with `enrichedAt`; a
   * Trading 212 baseline or a profile upgraded by the details refresh has a name but no history yet.
   */
  async enrichedSymbols(symbols: readonly string[]): Promise<Set<string>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return new Set(items.filter((item) => typeof item.enrichedAt === 'string' || item.profileSource === undefined).map(symbolOfPk));
  }

  /** The stored profile of `symbol`, or undefined. */
  async getProfile(symbol: string): Promise<InstrumentProfile | undefined> {
    const item = await this.store.get(keys.profile(symbol));
    return item === undefined ? undefined : (item as unknown as InstrumentProfile);
  }

  /** Symbols with a PROFILE whose optional details were never fetched or before `cutoff`, never-fetched first. */
  async staleProfileDetails(symbols: readonly string[], cutoff: string): Promise<string[]> {
    return (await this.staleProfiles(symbols, cutoff)).map(({ symbol }) => symbol);
  }

  /** Like `staleProfileDetails`, with the source of each stored profile. */
  async staleProfiles(symbols: readonly string[], cutoff: string): Promise<{ symbol: string; source: ProfileSource }[]> {
    if (symbols.length === 0) return [];
    const items = await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return items
      .map((item) => ({ fetched: typeof item.detailsAsOf === 'string' ? item.detailsAsOf : '', symbol: symbolOfPk(item), source: sourceOfItem(item) }))
      .filter(({ fetched }) => fetched < cutoff)
      .toSorted((a, b) => byText(a.fetched, b.fetched) || byText(a.symbol, b.symbol))
      .map(({ symbol, source }) => ({ symbol, source }));
  }

  /**
   * Stores what a provider knows about `symbol` on its PROFILE item, never degrading it: a provider profile overrides the Trading
   * 212 baseline and the minimal one field by field (see `mergeProfile`), nothing replaces a real value with a placeholder. The
   * detail fields and `detailsAsOf` of the provider profile are stored with it. Throws when the PROFILE item does not exist.
   * `profile` null = nothing found: only the fetch date is stored.
   */
  async putProfileDetails(symbol: string, profile: InstrumentProfile | null, asOf: string): Promise<void> {
    const existing = await this.store.get(keys.profile(symbol));
    if (existing === undefined) throw new Error(`No PROFILE item for ${symbol}`);
    const stored = existing as unknown as InstrumentProfile;
    if (profile !== null && sourceOfItem(existing) !== 'provider') {
      await this.store.put(profileItem(mergeProfile(stored, { ...profile, profileSource: 'provider', detailsAsOf: asOf })));
      return;
    }
    const updated = await this.store.update(keys.profile(symbol), { set: { ...profileDetails(profile), detailsAsOf: asOf } }, { condition: cond.exists });
    if (updated === undefined) throw new Error(`No PROFILE item for ${symbol}`);
  }

  /**
   * The last write of the enrichment of a new symbol: the provider profile merged over what is stored (a Trading 212 baseline stays
   * the floor), or, when no provider answered, the stored profile (else the minimal one) marked as enriched. `enrichedAt` is the
   * marker that the history is stored; `detailsAsOf` is only set with a provider profile.
   */
  async putEnrichedProfile(symbol: string, provider: InstrumentProfile | null, fallback: InstrumentProfile, day: string): Promise<void> {
    const existing = await this.store.get(keys.profile(symbol));
    const stored = existing === undefined ? undefined : (existing as unknown as InstrumentProfile);
    const incoming: InstrumentProfile = provider === null ? { ...fallback, profileSource: 'minimal', enrichedAt: day } : { ...provider, profileSource: 'provider', detailsAsOf: day, enrichedAt: day };
    await this.store.put(profileItem({ ...mergeProfile(stored, incoming), enrichedAt: day }));
  }

  /** The tries of today per symbol (a counter of another day counts as none). */
  async attemptsOn(kind: AttemptKind, symbols: readonly string[], day: string): Promise<Map<string, Attempts>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => attemptKey(symbol, kind)));
    return new Map(items.filter((item) => item.day === day && typeof item.attempts === 'number').map((item) => [symbolOfPk(item), { count: Number(item.attempts), skipped: item.outcome === 'skipped' }]));
  }

  /** The last recorded try of the enrichment of each symbol, whatever day it was on (what the price coverage report explains a gap with). */
  async lastAttempts(symbols: readonly string[]): Promise<Map<string, LastAttempt>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany(symbols.map((symbol) => attemptKey(symbol, 'core')));
    const found = items.filter((item) => typeof item.day === 'string' && typeof item.attempts === 'number');
    return new Map(found.map((item) => [symbolOfPk(item), { day: String(item.day), attempts: Number(item.attempts), outcome: item.outcome === 'skipped' ? 'skipped' : 'retry', error: typeof item.lastError === 'string' ? item.lastError : '' }]));
  }

  /** The newest `limit` EOD rows of `symbol` in ONE query: their dates (newest first), sources (absent: a market-data provider's row) and whether the owner's history symbol served them. */
  async newestEod(symbol: string, limit: number): Promise<{ date: string; source?: string; override?: true }[]> {
    const page = await this.store.query({ pk: keys.tickerPk(symbol), sk: { beginsWith: keys.eodPrefix }, reverse: true, limit });
    return page.items.map((item) => ({ date: item.SK.slice(keys.eodPrefix.length), ...(typeof item.source === 'string' ? { source: item.source } : {}), ...(item.override === true ? { override: true as const } : {}) }));
  }

  /** The history symbols of the owner for these held symbols, by held symbol. */
  async getHistorySymbols(symbols: readonly string[]): Promise<Map<string, HistorySymbolRecord>> {
    const items = symbols.length === 0 ? [] : await this.store.getMany([...new Set(symbols)].map((symbol) => historySymbolKey(symbol)));
    const out = new Map<string, HistorySymbolRecord>();
    for (const item of items) {
      const status = HISTORY_OVERRIDE_STATUSES.find((candidate) => candidate === item.status);
      if (status === undefined || typeof item.historySymbol !== 'string' || typeof item.setAt !== 'string') continue;
      out.set(symbolOfPk(item), { symbol: symbolOfPk(item), historySymbol: item.historySymbol, status, reason: typeof item.reason === 'string' ? item.reason : null, setAt: item.setAt });
    }
    return out;
  }

  async getHistorySymbol(symbol: string): Promise<HistorySymbolRecord | undefined> {
    return (await this.getHistorySymbols([symbol])).get(symbol);
  }

  async putHistorySymbol(record: HistorySymbolRecord): Promise<void> {
    await this.store.put({ ...historySymbolKey(record.symbol), entityType: HISTORY_SYMBOL_ENTITY, ...definedOnly({ historySymbol: record.historySymbol, status: record.status, reason: record.reason ?? undefined, setAt: record.setAt }) });
  }

  /** Forgets the owner's history symbol of `symbol` (the rows it stored stay, marked as from an override). */
  async clearHistorySymbol(symbol: string): Promise<void> {
    await this.store.delete(historySymbolKey(symbol));
  }

  /** Stores the number of tries of `day`, how the last one ended and why. */
  async putAttempts(kind: AttemptKind, symbol: string, day: string, attempts: number, outcome: AttemptOutcome, error: string): Promise<void> {
    await this.store.put({ ...attemptKey(symbol, kind), entityType: ENRICH_STATE_ENTITY, symbol, day, attempts, outcome, lastError: error.slice(0, MAX_ERROR_CHARS) });
  }

  /** The stored answer of the search by ISIN, or undefined. */
  async getProxyListing(isin: string): Promise<ProxyRecord | undefined> {
    const item = await this.store.get(proxyKey(isin));
    if (item === undefined || typeof item.currency !== 'string' || typeof item.checkedOn !== 'string') return undefined;
    return { isin, currency: item.currency, listing: typeof item.listing === 'string' ? item.listing : null, checkedOn: item.checkedOn };
  }

  async putProxyListing(record: ProxyRecord): Promise<void> {
    await this.store.put({ ...proxyKey(record.isin), entityType: PROXY_LISTING_ENTITY, ...definedOnly({ currency: record.currency, listing: record.listing ?? undefined, checkedOn: record.checkedOn }) });
  }

  /** Whether the not-yet-enriched symbols were already handed to an enrichment job on `day`. */
  async healedOn(day: string): Promise<boolean> {
    return (await this.store.get(healKey))?.day === day;
  }

  async markHealed(day: string): Promise<void> {
    await this.store.put({ ...healKey, entityType: ENRICH_STATE_ENTITY, day });
  }

  /** Whether the one-time minor-unit repair (see `repairMinorUnits`) has completed. */
  async minorUnitRepairDone(): Promise<boolean> {
    return (await this.store.get(minorUnitRepairKey)) !== undefined;
  }

  async markMinorUnitRepair(doneAt: string, rows: RepairRows): Promise<void> {
    await this.store.put({ ...minorUnitRepairKey, entityType: ENRICH_STATE_ENTITY, doneAt, ...rows });
  }

  /**
   * Rewrites the stored EOD rows and the latest quote of `symbol` that are still in a minor unit (pence...) into the major
   * currency: one query over the symbol's EOD rows, one read of its quote and ONE batched write of the rows that change.
   * Idempotent: a row already in a major currency is never touched, so a rerun reads the same rows and writes none.
   */
  async repairMinorUnits(symbol: string): Promise<RepairRows> {
    const [eods, quote] = await Promise.all([
      queryAll(this.store, { pk: keys.tickerPk(symbol), sk: { beginsWith: keys.eodPrefix } }),
      this.store.get(keys.quote(symbol)),
    ]);
    const writes = [...eods, ...(quote === undefined ? [] : [quote])].flatMap((item) => rescaledItem(item) ?? []);
    if (writes.length > 0) await this.store.batchWrite(putOps(writes));
    return { read: eods.length + (quote === undefined ? 0 : 1), written: writes.length };
  }

  /** The "limit reached" blocks still in force among `providers`. */
  blockedProviders(providers: readonly string[], now: Date): Promise<Map<string, ProviderBlock>> {
    return new BlockBook(this.store, () => now).active(providers);
  }

  putProfile(profile: InstrumentProfile): Promise<boolean> {
    return this.store.put(profileItem(profile));
  }

  async putQuotes(quotes: readonly Quote[]): Promise<void> {
    await this.store.batchWrite(putOps(quotes.map((quote) => majorQuote(quote)).flatMap((quote) => [quoteItem(quote), eodItem({ symbol: quote.symbol, date: quote.asOf.slice(0, 10), close: quote.price, currency: quote.currency })])));
  }

  putQuote(quote: Quote): Promise<boolean> {
    return this.store.put(quoteItem(majorQuote(quote)));
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

  /** Date of the oldest stored FX_DAY item of `base`, or null. */
  async earliestFxDay(base: string): Promise<string | null> {
    const page = await this.store.query({ pk: `FX#${base}`, sk: { beginsWith: keys.fxDayPrefix }, limit: 1 });
    const sk = page.items[0]?.SK;
    return sk === undefined ? null : sk.slice(keys.fxDayPrefix.length);
  }

  /** Whether the stored fixings were already checked for a gap before the oldest one on `day` (once a UTC day). */
  async fxFrontCheckedOn(day: string): Promise<boolean> {
    return (await this.store.get(fxFrontKey))?.day === day;
  }

  async markFxFrontChecked(day: string): Promise<void> {
    await this.store.put({ ...fxFrontKey, entityType: ENRICH_STATE_ENTITY, day });
  }

  async putFxDays(days: readonly FxDay[]): Promise<number> {
    const ops = putOps(days.map((day) => fxDayItem(day)));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  async putEods(rows: readonly EodPrice[]): Promise<number> {
    const ops = putOps(rows.map((row) => eodItem(majorEod(row))));
    await this.store.batchWrite(ops);
    return ops.length;
  }

  async putDividends(events: readonly DividendEvent[]): Promise<number> {
    const ops = putOps(events.map((event) => dividendItem(majorDividend(event))));
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

  /** What a calendar run did to the earnings dates: `EARNINGS#LASTRUN` always, `EARNINGS#LASTOK` too when it read the provider's calendar. */
  async putEarningsRun(run: EarningsRunRecord): Promise<void> {
    const base = { entityType: EARNINGS_RUN_ENTITY, ...definedOnly(run) };
    const keysOf = run.status === 'ok' ? [earningsRunKeys.last, earningsRunKeys.lastOk] : [earningsRunKeys.last];
    await this.store.batchWrite(keysOf.map((key): BatchOp => ({ type: 'put', item: { ...key, ...base } })));
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

  /** Calls of `provider` used on the UTC `day`: all of the app's (`USAGE`), and the ones the calendar's own budget counted. */
  async callsUsedOn(provider: string, day: string): Promise<{ used: number; calendarUsed: number }> {
    const found = await this.store.getMany([{ PK: 'USAGE', SK: provider }, budgetKey(provider)]);
    const usedOn = (key: { PK: string; SK: string }): number => {
      const item = found.find((candidate) => candidate.PK === key.PK && candidate.SK === key.SK);
      return item?.day === day && typeof item.used === 'number' ? item.used : 0;
    };
    return { used: usedOn({ PK: 'USAGE', SK: provider }), calendarUsed: usedOn(budgetKey(provider)) };
  }

  /** Sets marker attributes without touching the others. */
  async putState(symbol: string, attrs: CalendarState): Promise<void> {
    await this.store.update(stateKey(symbol), { set: { entityType: CALENDAR_STATE_ENTITY, symbol, ...definedOnly(attrs) } });
  }
}
