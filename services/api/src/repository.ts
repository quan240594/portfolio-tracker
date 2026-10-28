import {
  calendarKeys,
  earningsKeys,
  earningsRunKeys,
  ENTITY,
  fromItem,
  keys,
  parseEarningsRun,
  majorDividend,
  majorEod,
  majorQuote,
  transactionItem,
  type DividendEvent,
  type EarningsRunRecord,
  type EarningsSummary,
  type EodPrice,
  type FxDay,
  type FxRates,
  type ImportStatus,
  type InstrumentProfile,
  type Portfolio,
  type Quote,
  type StoredCalendarEvents,
  type StoredEarningsEvent,
  type StoredSplitEvent,
  type Transaction,
} from '@portfolio/shared';
import { cond, listByPrefix, listTransactions, queryAll, registerUser, trackTickers, type ItemStore } from '@portfolio/platform';

/** What the earnings dates diagnostics read: the upcoming stored dates, the tracked symbols and the records the calendar job left. */
export interface EarningsDatesData {
  /** `createdAt` of the tracked-ticker item of each tracked symbol (null: tracked, since an unknown time); an untracked symbol is absent. */
  tracked: Map<string, string | null>;
  /** Stored earnings dates on or after `today`. */
  upcoming: StoredEarningsEvent[];
  /** The last calendar run, and the last one that read the provider's calendar (see `EarningsRunRecord`). */
  run: EarningsRunRecord | null;
  lastOk: EarningsRunRecord | null;
}

/** Data access used by the route handlers. Implemented by `ItemRepository` (any ItemStore) and by in-memory fakes in tests. */
export interface Repository {
  /** All portfolios of the user (unsorted). */
  listPortfolios(userId: string): Promise<Portfolio[]>;
  getPortfolio(userId: string, portfolioId: string): Promise<Portfolio | null>;
  /** Create-only put; resolves false when the portfolio already exists (e.g. a concurrent default creation). */
  createPortfolio(portfolio: Portfolio): Promise<boolean>;
  /** Renames an existing portfolio; resolves null when it does not exist. */
  renamePortfolio(userId: string, portfolioId: string, name: string, updatedAt: string): Promise<Portfolio | null>;
  deletePortfolio(userId: string, portfolioId: string): Promise<void>;
  /** Transactions of one portfolio, or of all portfolios when `portfolioId` is omitted. */
  listTransactions(userId: string, portfolioId?: string): Promise<Transaction[]>;
  /** Looks a transaction up by id across all portfolios of the user. */
  findTransaction(userId: string, id: string): Promise<Transaction | null>;
  putTransaction(txn: Transaction): Promise<void>;
  deleteTransaction(txn: Transaction): Promise<void>;
  /** Batch delete (the ItemStore chunks and retries unprocessed items). */
  deleteTransactions(txns: readonly Transaction[]): Promise<void>;
  getQuotes(symbols: string[]): Promise<Record<string, Quote>>;
  getProfiles(symbols: string[]): Promise<Record<string, InstrumentProfile>>;
  getFx(base: string): Promise<FxRates | null>;
  /** Daily ECB fixings for `base` between `from` and `to` (inclusive, YYYY-MM-DD), oldest first. */
  getFxHistory(base: string, from: string, to: string): Promise<FxDay[]>;
  getEod(symbol: string, from: string, to: string): Promise<EodPrice[]>;
  getDividendEvents(symbol: string): Promise<DividendEvent[]>;
  /** Stored earnings and split events of `symbols` dated `from`..`to` (inclusive, YYYY-MM-DD); see calendarKeys. */
  getCalendarEvents(symbols: string[], from: string, to: string): Promise<StoredCalendarEvents>;
  /** What the earnings dates diagnostics read for `symbols` (see `EarningsDatesData`). */
  getEarningsDatesData(symbols: string[], today: string): Promise<EarningsDatesData>;
  /** The newest stored earnings summaries of a symbol, newest first (see earningsKeys). */
  getEarningsSummaries(symbol: string, limit: number): Promise<EarningsSummary[]>;
  getEarningsSummary(symbol: string, reportDate: string): Promise<EarningsSummary | null>;
  registerUser(userId: string): Promise<void>;
  /** `currency` may be omitted when unknown (watchlist symbols). */
  trackTickers(tickers: { symbol: string; currency?: string }[]): Promise<void>;
  putImport(status: ImportStatus): Promise<void>;
  getImport(userId: string, importId: string): Promise<ImportStatus | null>;
}

/**
 * Repository on an ItemStore: the key scheme (see `keys` in @portfolio/shared), item shapes and queries of the main
 * entities, written once for every storage adapter.
 */
export class ItemRepository implements Repository {
  constructor(private readonly store: ItemStore) {}

  listPortfolios(userId: string): Promise<Portfolio[]> {
    return listByPrefix<Portfolio>(this.store, keys.user(userId).PK, keys.portfolioPrefix, { consistent: true });
  }

  async getPortfolio(userId: string, portfolioId: string): Promise<Portfolio | null> {
    const item = await this.store.get(keys.portfolio(userId, portfolioId), { consistent: true });
    return item ? fromItem<Portfolio>(item) : null;
  }

  createPortfolio(portfolio: Portfolio): Promise<boolean> {
    return this.store.put(
      { ...keys.portfolio(portfolio.userId, portfolio.portfolioId), entityType: ENTITY.portfolio, ...portfolio },
      { condition: cond.notExists },
    );
  }

  async renamePortfolio(userId: string, portfolioId: string, name: string, updatedAt: string): Promise<Portfolio | null> {
    const item = await this.store.update(keys.portfolio(userId, portfolioId), { set: { name, updatedAt } }, { condition: cond.exists });
    return item ? fromItem<Portfolio>(item) : null;
  }

  async deletePortfolio(userId: string, portfolioId: string): Promise<void> {
    await this.store.delete(keys.portfolio(userId, portfolioId));
  }

  listTransactions(userId: string, portfolioId?: string): Promise<Transaction[]> {
    return listTransactions(this.store, userId, portfolioId);
  }

  async findTransaction(userId: string, id: string): Promise<Transaction | null> {
    return (await listTransactions(this.store, userId)).find((t) => t.id === id) ?? null;
  }

  async putTransaction(txn: Transaction): Promise<void> {
    if (!(await this.store.put(transactionItem(txn), { condition: cond.notExists }))) {
      throw new Error(`Transaction ${txn.id} already exists`);
    }
  }

  async deleteTransaction(txn: Transaction): Promise<void> {
    await this.store.delete(keys.transaction(txn.userId, txn.portfolioId, txn.date, txn.id));
  }

  deleteTransactions(txns: readonly Transaction[]): Promise<void> {
    return this.store.batchWrite(txns.map((t) => ({ type: 'delete', key: keys.transaction(t.userId, t.portfolioId, t.date, t.id) })));
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const items = await this.store.getMany(symbols.map((s) => keys.quote(s)));
    return Object.fromEntries(items.map((i) => [String(i.symbol), majorQuote(fromItem<Quote>(i))]));
  }

  async getProfiles(symbols: string[]): Promise<Record<string, InstrumentProfile>> {
    const items = await this.store.getMany(symbols.map((s) => keys.profile(s)));
    return Object.fromEntries(items.map((i) => [String(i.symbol), fromItem<InstrumentProfile>(i)]));
  }

  async getFx(base: string): Promise<FxRates | null> {
    const item = await this.store.get(keys.fx(base));
    return item ? fromItem<FxRates>(item) : null;
  }

  async getFxHistory(base: string, from: string, to: string): Promise<FxDay[]> {
    const items = await queryAll(this.store, {
      pk: keys.fxDay(base, from).PK,
      sk: { between: [keys.fxDay(base, from).SK, keys.fxDay(base, to).SK] },
    });
    return items.map((i) => ({
      base: typeof i.base === 'string' ? i.base : base,
      date: typeof i.date === 'string' ? i.date : String(i.SK).slice(keys.fxDayPrefix.length),
      rates: (i.rates ?? {}) as FxDay['rates'],
    }));
  }

  async getEod(symbol: string, from: string, to: string): Promise<EodPrice[]> {
    const items = await queryAll(this.store, { pk: keys.tickerPk(symbol), sk: { between: [keys.eod(symbol, from).SK, keys.eod(symbol, to).SK] } });
    return items.map((i) => majorEod(fromItem<EodPrice>(i)));
  }

  async getDividendEvents(symbol: string): Promise<DividendEvent[]> {
    const events = await listByPrefix<DividendEvent>(this.store, keys.tickerPk(symbol), keys.dividendPrefix);
    return events.map((event) => majorDividend(event));
  }

  async getCalendarEvents(symbols: string[], from: string, to: string): Promise<StoredCalendarEvents> {
    const between = (symbol: string, key: typeof calendarKeys.earnings) =>
      queryAll(this.store, { pk: calendarKeys.tickerPk(symbol), sk: { between: [key(symbol, from).SK, key(symbol, to).SK] } });
    const [earnings, splits] = await Promise.all([
      Promise.all(symbols.map((s) => between(s, calendarKeys.earnings))),
      Promise.all(symbols.map((s) => between(s, calendarKeys.split))),
    ]);
    return {
      earnings: earnings.flat().map((i) => fromItem<StoredEarningsEvent>(i)),
      splits: splits.flat().map((i) => fromItem<StoredSplitEvent>(i)),
    };
  }

  async getEarningsDatesData(symbols: string[], today: string): Promise<EarningsDatesData> {
    const ahead = (symbol: string) =>
      queryAll(this.store, { pk: calendarKeys.tickerPk(symbol), sk: { between: [calendarKeys.earnings(symbol, today).SK, calendarKeys.earnings(symbol, '9999-12-31').SK] } });
    const [trackedItems, upcoming, runItems] = await Promise.all([
      symbols.length > 0 ? this.store.getMany(symbols.map((symbol) => keys.trackedTicker(symbol))) : [],
      Promise.all(symbols.map((symbol) => ahead(symbol))),
      this.store.getMany([earningsRunKeys.last, earningsRunKeys.lastOk]),
    ]);
    const runOf = (key: { PK: string; SK: string }) => parseEarningsRun(runItems.find((item) => item.PK === key.PK && item.SK === key.SK));
    return {
      tracked: new Map(trackedItems.map((item) => [item.SK.slice(keys.trackedTicker('').SK.length), typeof item.createdAt === 'string' ? item.createdAt : null])),
      upcoming: upcoming.flat().map((item) => fromItem<StoredEarningsEvent>(item)),
      run: runOf(earningsRunKeys.last),
      lastOk: runOf(earningsRunKeys.lastOk),
    };
  }

  async getEarningsSummaries(symbol: string, limit: number): Promise<EarningsSummary[]> {
    const page = await this.store.query({ pk: earningsKeys.tickerPk(symbol), sk: { beginsWith: earningsKeys.summaryPrefix }, reverse: true, limit });
    return page.items.map((item) => fromItem<EarningsSummary>(item));
  }

  async getEarningsSummary(symbol: string, reportDate: string): Promise<EarningsSummary | null> {
    const item = await this.store.get(earningsKeys.summary(symbol, reportDate));
    return item ? fromItem<EarningsSummary>(item) : null;
  }

  registerUser(userId: string): Promise<void> {
    return registerUser(this.store, userId, new Date().toISOString());
  }

  trackTickers(tickers: { symbol: string; currency?: string }[]): Promise<void> {
    return trackTickers(this.store, tickers, new Date().toISOString());
  }

  async putImport(status: ImportStatus): Promise<void> {
    await this.store.put({ ...keys.import(status.userId, status.importId), entityType: ENTITY.import, ...status });
  }

  async getImport(userId: string, importId: string): Promise<ImportStatus | null> {
    const item = await this.store.get(keys.import(userId, importId), { consistent: true });
    return item ? fromItem<ImportStatus>(item) : null;
  }
}
