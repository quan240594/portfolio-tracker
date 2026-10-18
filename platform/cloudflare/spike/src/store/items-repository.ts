/**
 * Repository + ManagementRepository on top of the `items` table (D1 / SQLite model), serving the SAME key scheme as the
 * DynamoDB repositories (services/api/src/repository.ts, management-repository.ts). Route handlers run unchanged.
 *
 * What differs from the DynamoDB implementation, and why (each point is measured in the spike):
 *  - concurrent per-symbol reads in one tick (`getEod`, `getDividendEvents`) are coalesced into ONE `pk IN (...)`
 *    statement: Workers Free allows 50 subrequests (= D1 queries) per invocation and the handlers fan out per symbol;
 *  - price/FX history can be stored one row per symbol-year / FX-year ("packed" layout) instead of one row per day;
 *  - `trackTickers` only writes rows that are missing (Dynamo rewrote `updatedAt` on every call).
 */
import {
  calendarKeys,
  goalKeys,
  keys,
  managementKeys,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
  type DividendEvent,
  type EodPrice,
  type FxDay,
  type FxRates,
  type GoalItem,
  type ImportStatus,
  type InstrumentProfile,
  type Portfolio,
  type PortfolioSettings,
  type Quote,
  type StoredCalendarEvents,
  type StoredEarningsEvent,
  type StoredSplitEvent,
  type Transaction,
  type WatchlistEntry,
} from '../../../../../packages/shared/src/index.js';
import type { Repository } from '../../../../../services/api/src/repository.js';
import type { ManagementRepository } from '../../../../../services/api/src/management-repository.js';
import type { BatchOp, ItemStore, Row } from './item-store.ts';

export type PriceLayout = 'day' | 'symbol-year';

export interface RepoOptions {
  /** `day` = one row per symbol and day (DynamoDB parity); `symbol-year` = one row per symbol and year. */
  priceLayout: PriceLayout;
  /** Same for the ECB fixings: `day` or `year`. */
  fxLayout: 'day' | 'year';
}

export const DAY_LAYOUT: RepoOptions = { priceLayout: 'day', fxLayout: 'day' };
export const PACKED_LAYOUT: RepoOptions = { priceLayout: 'symbol-year', fxLayout: 'year' };

/** Packed price row: one symbol, one calendar year; parallel arrays keep JSON.parse cheap. */
export interface PackedEod {
  s: string;
  c: string;
  d: string[];
  p: number[];
}
/** Packed FX row: one calendar year of ECB fixings. `r[i][j]` = rate of currency `c[j]` on `d[i]`. */
export interface PackedFx {
  b: string;
  c: string[];
  d: string[];
  r: number[][];
}

const eodYearSk = (year: string) => `EOD#${year}`;
const fxYearSk = (year: string) => `DAY#${year}`;
const parse = <T>(row: Row): T => JSON.parse(row.data) as T;

export const toRow = (pk: string, sk: string, entity: object): Row => ({ pk, sk, data: JSON.stringify(entity) });

export function packEod(symbol: string, currency: string, year: string, prices: readonly EodPrice[]): PackedEod {
  const sorted = [...prices].sort((a, b) => a.date.localeCompare(b.date));
  return { s: symbol, c: currency, d: sorted.map((e) => e.date), p: sorted.map((e) => e.close) };
}

export function packFx(base: string, days: readonly FxDay[]): PackedFx {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const c = [...new Set(sorted.flatMap((d) => Object.keys(d.rates)))].sort();
  return { b: base, c, d: sorted.map((d) => d.date), r: sorted.map((d) => c.map((cc) => d.rates[cc] ?? 0)) };
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

/** Collects calls made in the same synchronous burst and runs them as one batch on the next microtask. */
class TickBatcher<Req, Res> {
  private queue: { req: Req; w: Waiter<Res> }[] = [];
  constructor(private readonly run: (reqs: Req[]) => Promise<Res[]>) {}
  add(req: Req): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      this.queue.push({ req, w: { resolve, reject } });
      if (this.queue.length === 1) queueMicrotask(() => void this.flush());
    });
  }
  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    try {
      const out = await this.run(batch.map((b) => b.req));
      batch.forEach((b, i) => b.w.resolve(out[i]!));
    } catch (err) {
      for (const b of batch) b.w.reject(err);
    }
  }
}

export class ItemsRepository implements Repository, ManagementRepository {
  private readonly eodBatcher: TickBatcher<{ symbol: string; from: string; to: string }, EodPrice[]>;
  private readonly divBatcher: TickBatcher<string, DividendEvent[]>;

  constructor(
    readonly store: ItemStore,
    readonly layout: RepoOptions = DAY_LAYOUT,
  ) {
    this.eodBatcher = new TickBatcher((reqs) => this.runEod(reqs));
    this.divBatcher = new TickBatcher((symbols) => this.runDividends(symbols));
  }

  // ---- portfolios -------------------------------------------------------------------------------------------------
  async listPortfolios(userId: string): Promise<Portfolio[]> {
    return (await this.store.query(keys.user(userId).PK, { begins: keys.portfolioPrefix })).map((r) => parse<Portfolio>(r));
  }
  async getPortfolio(userId: string, portfolioId: string): Promise<Portfolio | null> {
    const k = keys.portfolio(userId, portfolioId);
    const r = await this.store.get(k.PK, k.SK);
    return r ? parse<Portfolio>(r) : null;
  }
  createPortfolio(p: Portfolio): Promise<boolean> {
    const k = keys.portfolio(p.userId, p.portfolioId);
    return this.store.put(k.PK, k.SK, JSON.stringify(p), { ifNotExists: true });
  }
  async renamePortfolio(userId: string, portfolioId: string, name: string, updatedAt: string): Promise<Portfolio | null> {
    const existing = await this.getPortfolio(userId, portfolioId);
    if (!existing) return null;
    const next = { ...existing, name, updatedAt };
    const k = keys.portfolio(userId, portfolioId);
    await this.store.put(k.PK, k.SK, JSON.stringify(next));
    return next;
  }
  async deletePortfolio(userId: string, portfolioId: string): Promise<void> {
    const k = keys.portfolio(userId, portfolioId);
    await this.store.delete(k.PK, k.SK);
  }

  // ---- transactions -----------------------------------------------------------------------------------------------
  async listTransactions(userId: string, portfolioId?: string): Promise<Transaction[]> {
    const begins = portfolioId === undefined ? keys.transactionPrefix : keys.portfolioTransactionPrefix(portfolioId);
    return (await this.store.query(keys.user(userId).PK, { begins })).map((r) => parse<Transaction>(r));
  }
  /** Scans the user's TXN# range (rows read = all transactions, no Worker CPU for rows that do not match). */
  async findTransaction(userId: string, id: string): Promise<Transaction | null> {
    const rows = await this.store.query(keys.user(userId).PK, { begins: keys.transactionPrefix });
    for (const r of rows) {
      const t = parse<Transaction>(r);
      if (t.id === id) return t;
    }
    return null;
  }
  async putTransaction(t: Transaction): Promise<void> {
    const k = keys.transaction(t.userId, t.portfolioId, t.date, t.id);
    if (!(await this.store.put(k.PK, k.SK, JSON.stringify(t), { ifNotExists: true }))) throw new Error('ConditionalCheckFailed');
  }
  async deleteTransaction(t: Transaction): Promise<void> {
    const k = keys.transaction(t.userId, t.portfolioId, t.date, t.id);
    await this.store.delete(k.PK, k.SK);
  }
  async deleteTransactions(txns: readonly Transaction[]): Promise<void> {
    await this.chunkedBatch(
      txns.map((t) => {
        const k = keys.transaction(t.userId, t.portfolioId, t.date, t.id);
        return { type: 'delete' as const, pk: k.PK, sk: k.SK };
      }),
    );
  }
  /** Writes many transactions in D1-sized batches (`ifNotExists` semantics are per row via upsert: ids are deterministic). */
  async putTransactions(txns: readonly Transaction[]): Promise<void> {
    await this.chunkedBatch(
      txns.map((t) => {
        const k = keys.transaction(t.userId, t.portfolioId, t.date, t.id);
        return { type: 'put' as const, pk: k.PK, sk: k.SK, data: JSON.stringify(t) };
      }),
    );
  }
  /** Statements per `batch()` call. */
  static readonly BATCH = 100;
  async chunkedBatch(ops: readonly BatchOp[], size = ItemsRepository.BATCH): Promise<void> {
    for (let i = 0; i < ops.length; i += size) await this.store.batch(ops.slice(i, i + size));
  }

  // ---- market data ------------------------------------------------------------------------------------------------
  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const rows = await this.store.getMany(symbols.map((s) => ({ pk: keys.quote(s).PK, sk: keys.quote(s).SK })));
    return Object.fromEntries(rows.map((r) => [r.pk.slice('TICKER#'.length), parse<Quote>(r)]));
  }
  async getProfiles(symbols: string[]): Promise<Record<string, InstrumentProfile>> {
    const rows = await this.store.getMany(symbols.map((s) => ({ pk: keys.profile(s).PK, sk: keys.profile(s).SK })));
    return Object.fromEntries(rows.map((r) => [r.pk.slice('TICKER#'.length), parse<InstrumentProfile>(r)]));
  }
  async getFx(base: string): Promise<FxRates | null> {
    const k = keys.fx(base);
    const r = await this.store.get(k.PK, k.SK);
    return r ? parse<FxRates>(r) : null;
  }
  async getFxHistory(base: string, from: string, to: string): Promise<FxDay[]> {
    const pk = keys.fxDay(base, from).PK;
    if (this.layout.fxLayout === 'day') {
      const rows = await this.store.query(pk, { from: keys.fxDay(base, from).SK, to: keys.fxDay(base, to).SK });
      return rows.map((r) => {
        const d = parse<{ base?: string; date?: string; rates?: FxDay['rates'] }>(r);
        return { base: d.base ?? base, date: d.date ?? r.sk.slice(keys.fxDayPrefix.length), rates: d.rates ?? {} };
      });
    }
    const rows = await this.store.query(pk, { from: fxYearSk(from.slice(0, 4)), to: fxYearSk(to.slice(0, 4)) });
    const out: FxDay[] = [];
    for (const r of rows) {
      const p = parse<PackedFx>(r);
      for (let i = 0; i < p.d.length; i++) {
        const date = p.d[i]!;
        if (date < from || date > to) continue;
        const rates: Record<string, number> = {};
        const row = p.r[i]!;
        for (let j = 0; j < p.c.length; j++) rates[p.c[j]!] = row[j]!;
        out.push({ base: p.b, date, rates });
      }
    }
    return out;
  }
  getEod(symbol: string, from: string, to: string): Promise<EodPrice[]> {
    return this.eodBatcher.add({ symbol, from, to });
  }
  private async runEod(reqs: { symbol: string; from: string; to: string }[]): Promise<EodPrice[][]> {
    const groups = new Map<string, { from: string; to: string; symbols: Set<string> }>();
    for (const r of reqs) {
      const g = groups.get(`${r.from}|${r.to}`) ?? { from: r.from, to: r.to, symbols: new Set<string>() };
      g.symbols.add(r.symbol);
      groups.set(`${r.from}|${r.to}`, g);
    }
    const bySymbol = new Map<string, EodPrice[]>();
    for (const g of groups.values()) {
      const packed = this.layout.priceLayout === 'symbol-year';
      const range = packed
        ? { from: eodYearSk(g.from.slice(0, 4)), to: eodYearSk(g.to.slice(0, 4)) }
        : { from: keys.eod('', g.from).SK, to: keys.eod('', g.to).SK };
      const rows = await this.store.queryMany([...g.symbols].map((s) => keys.tickerPk(s)), range);
      for (const r of rows) {
        const symbol = r.pk.slice('TICKER#'.length);
        const list = bySymbol.get(`${g.from}|${g.to}|${symbol}`) ?? [];
        if (packed) {
          const p = parse<PackedEod>(r);
          for (let i = 0; i < p.d.length; i++) {
            const date = p.d[i]!;
            if (date >= g.from && date <= g.to) list.push({ symbol: p.s, date, close: p.p[i]!, currency: p.c });
          }
        } else {
          list.push(parse<EodPrice>(r));
        }
        bySymbol.set(`${g.from}|${g.to}|${symbol}`, list);
      }
    }
    return reqs.map((r) => bySymbol.get(`${r.from}|${r.to}|${r.symbol}`) ?? []);
  }
  getDividendEvents(symbol: string): Promise<DividendEvent[]> {
    return this.divBatcher.add(symbol);
  }
  private async runDividends(symbols: string[]): Promise<DividendEvent[][]> {
    const unique = [...new Set(symbols)];
    const rows = await this.store.queryMany(unique.map((s) => keys.tickerPk(s)), { begins: keys.dividendPrefix });
    const by = new Map<string, DividendEvent[]>();
    for (const r of rows) {
      const symbol = r.pk.slice('TICKER#'.length);
      (by.get(symbol) ?? by.set(symbol, []).get(symbol)!).push(parse<DividendEvent>(r));
    }
    return symbols.map((s) => by.get(s) ?? []);
  }
  async getCalendarEvents(symbols: string[], from: string, to: string): Promise<StoredCalendarEvents> {
    const pks = symbols.map((s) => calendarKeys.tickerPk(s));
    const [earnings, splits] = await Promise.all([
      this.store.queryMany(pks, { from: calendarKeys.earnings('', from).SK, to: calendarKeys.earnings('', to).SK }),
      this.store.queryMany(pks, { from: calendarKeys.split('', from).SK, to: calendarKeys.split('', to).SK }),
    ]);
    return { earnings: earnings.map((r) => parse<StoredEarningsEvent>(r)), splits: splits.map((r) => parse<StoredSplitEvent>(r)) };
  }

  // ---- registry / tracking ----------------------------------------------------------------------------------------
  async registerUser(userId: string): Promise<void> {
    const k = keys.userRegistry(userId);
    const now = new Date().toISOString();
    await this.store.put(k.PK, k.SK, JSON.stringify({ userId, createdAt: now, updatedAt: now }), { ifNotExists: true });
  }
  async trackTickers(tickers: { symbol: string; currency?: string }[]): Promise<void> {
    const wanted = tickers.filter((t) => !t.symbol.startsWith('CASH.') && !t.symbol.startsWith('CUSTOM:'));
    if (wanted.length === 0) return;
    const existing = await this.store.getMany(wanted.map((t) => ({ pk: keys.trackedTicker(t.symbol).PK, sk: keys.trackedTicker(t.symbol).SK })));
    const have = new Map(existing.map((r) => [r.sk, parse<{ currency?: string }>(r)]));
    const now = new Date().toISOString();
    const ops: BatchOp[] = [];
    for (const t of wanted) {
      const k = keys.trackedTicker(t.symbol);
      const prev = have.get(k.SK);
      if (prev && (prev.currency || !t.currency)) continue; // nothing new to record: no write
      ops.push({ type: 'put', pk: k.PK, sk: k.SK, data: JSON.stringify({ symbol: t.symbol, ...(t.currency ? { currency: t.currency } : {}), createdAt: now, updatedAt: now }) });
    }
    if (ops.length > 0) await this.chunkedBatch(ops);
  }
  async putImport(s: ImportStatus): Promise<void> {
    const k = keys.import(s.userId, s.importId);
    await this.store.put(k.PK, k.SK, JSON.stringify(s));
  }
  async getImport(userId: string, importId: string): Promise<ImportStatus | null> {
    const k = keys.import(userId, importId);
    const r = await this.store.get(k.PK, k.SK);
    return r ? parse<ImportStatus>(r) : null;
  }

  // ---- management -------------------------------------------------------------------------------------------------
  private async list<T>(userId: string, begins: string): Promise<T[]> {
    return (await this.store.query(`USER#${userId}`, { begins })).map((r) => parse<T>(r));
  }
  async getSettings(userId: string, portfolioId: string): Promise<PortfolioSettings | null> {
    const k = managementKeys.settings(userId, portfolioId);
    const r = await this.store.get(k.PK, k.SK);
    return r ? parse<PortfolioSettings>(r) : null;
  }
  listSettings(userId: string): Promise<PortfolioSettings[]> {
    return this.list(userId, managementKeys.settingsPrefix);
  }
  async putSettings(s: PortfolioSettings): Promise<void> {
    const k = managementKeys.settings(s.userId, s.portfolioId);
    await this.store.put(k.PK, k.SK, JSON.stringify(s));
  }
  listCategories(userId: string, portfolioId?: string): Promise<Category[]> {
    return this.list(userId, managementKeys.categoryPrefix(portfolioId));
  }
  async putCategory(c: Category): Promise<void> {
    const k = managementKeys.category(c.userId, c.portfolioId, c.categoryId);
    await this.store.put(k.PK, k.SK, JSON.stringify(c));
  }
  async deleteCategory(userId: string, portfolioId: string, categoryId: string): Promise<void> {
    const assignments = await this.listAssignments(userId, portfolioId);
    const ops: BatchOp[] = assignments
      .filter((a) => a.categoryId === categoryId)
      .map((a) => ({ type: 'delete' as const, pk: managementKeys.assignment(userId, portfolioId, a.symbol).PK, sk: managementKeys.assignment(userId, portfolioId, a.symbol).SK }));
    const ck = managementKeys.category(userId, portfolioId, categoryId);
    ops.push({ type: 'delete', pk: ck.PK, sk: ck.SK });
    await this.store.batch(ops); // one atomic round trip (Dynamo needed N+1 requests)
  }
  listAssignments(userId: string, portfolioId?: string): Promise<CategoryAssignment[]> {
    return this.list(userId, managementKeys.assignmentPrefix(portfolioId));
  }
  async putAssignments(assignments: readonly CategoryAssignment[]): Promise<void> {
    await this.chunkedBatch(
      assignments.map((a) => ({ type: 'put' as const, pk: managementKeys.assignment(a.userId, a.portfolioId, a.symbol).PK, sk: managementKeys.assignment(a.userId, a.portfolioId, a.symbol).SK, data: JSON.stringify(a) })),
    );
  }
  async deleteAssignments(userId: string, portfolioId: string, symbols: readonly string[]): Promise<void> {
    await this.chunkedBatch(symbols.map((s) => ({ type: 'delete' as const, pk: managementKeys.assignment(userId, portfolioId, s).PK, sk: managementKeys.assignment(userId, portfolioId, s).SK })));
  }
  listCustomAssets(userId: string, portfolioId?: string): Promise<CustomAsset[]> {
    return this.list(userId, managementKeys.customAssetPrefix(portfolioId));
  }
  async getCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<CustomAsset | null> {
    const k = managementKeys.customAsset(userId, portfolioId, assetId);
    const r = await this.store.get(k.PK, k.SK);
    return r ? parse<CustomAsset>(r) : null;
  }
  async putCustomAsset(a: CustomAsset): Promise<void> {
    const k = managementKeys.customAsset(a.userId, a.portfolioId, a.assetId);
    await this.store.put(k.PK, k.SK, JSON.stringify(a));
  }
  async deleteCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<void> {
    const k = managementKeys.customAsset(userId, portfolioId, assetId);
    await this.store.delete(k.PK, k.SK);
  }
  listWatchlist(userId: string): Promise<WatchlistEntry[]> {
    return this.list(userId, managementKeys.watchlistPrefix);
  }
  addWatchlistEntry(e: WatchlistEntry): Promise<boolean> {
    const k = managementKeys.watchlist(e.userId, e.symbol);
    return this.store.put(k.PK, k.SK, JSON.stringify(e), { ifNotExists: true });
  }
  deleteWatchlistEntry(userId: string, symbol: string): Promise<boolean> {
    const k = managementKeys.watchlist(userId, symbol);
    return this.store.delete(k.PK, k.SK, { ifExists: true });
  }
  async getGoal(userId: string, scope: string): Promise<GoalItem | null> {
    const k = goalKeys.goal(userId, scope);
    const r = await this.store.get(k.PK, k.SK);
    return r ? parse<GoalItem>(r) : null;
  }
  async putGoal(g: GoalItem): Promise<void> {
    const k = goalKeys.goal(g.userId, g.portfolioId);
    await this.store.put(k.PK, k.SK, JSON.stringify(g));
  }
  async deleteGoal(userId: string, scope: string): Promise<void> {
    const k = goalKeys.goal(userId, scope);
    await this.store.delete(k.PK, k.SK);
  }
  async deletePortfolioData(userId: string, portfolioId: string): Promise<void> {
    const [categories, assignments, assets] = await Promise.all([
      this.listCategories(userId, portfolioId),
      this.listAssignments(userId, portfolioId),
      this.listCustomAssets(userId, portfolioId),
    ]);
    const del = (k: { PK: string; SK: string }): BatchOp => ({ type: 'delete', pk: k.PK, sk: k.SK });
    await this.chunkedBatch([
      ...assignments.map((a) => del(managementKeys.assignment(userId, portfolioId, a.symbol))),
      ...categories.map((c) => del(managementKeys.category(userId, portfolioId, c.categoryId))),
      ...assets.map((a) => del(managementKeys.customAsset(userId, portfolioId, a.assetId))),
      del(managementKeys.settings(userId, portfolioId)),
      del(goalKeys.goal(userId, portfolioId)),
    ]);
  }

  // ---- background-job writers (not part of the API repositories; used by the job model) ----------------------------
  /** Daily price refresh / backfill of one symbol. */
  writeEod(symbol: string, currency: string, prices: readonly EodPrice[]): Promise<void> {
    return this.writeEodMany([{ symbol, currency, prices }]);
  }
  /**
   * Price refresh / backfill of many symbols with the fewest statements. Day layout: one row per price. Packed layout:
   * ONE multi-get of the touched symbol-year rows, merge in memory, then multi-row upserts.
   */
  async writeEodMany(entries: readonly { symbol: string; currency: string; prices: readonly EodPrice[] }[]): Promise<void> {
    if (this.layout.priceLayout === 'day') {
      await this.chunkedBatch(entries.flatMap((e) => e.prices.map((p) => ({ type: 'put' as const, pk: keys.eod(e.symbol, p.date).PK, sk: keys.eod(e.symbol, p.date).SK, data: JSON.stringify(p) }))));
      return;
    }
    const wanted = entries.flatMap((e) => [...new Set(e.prices.map((p) => p.date.slice(0, 4)))].map((y) => ({ pk: keys.tickerPk(e.symbol), sk: eodYearSk(y) })));
    const existing = await this.store.getMany(wanted);
    const byKey = new Map(existing.map((r) => [`${r.pk}|${r.sk}`, parse<PackedEod>(r)]));
    const ops: BatchOp[] = [];
    for (const k of wanted) {
      const e = entries.find((x) => keys.tickerPk(x.symbol) === k.pk)!;
      const year = k.sk.slice('EOD#'.length);
      const prev = byKey.get(`${k.pk}|${k.sk}`);
      const merged = new Map<string, number>(prev ? prev.d.map((d, i) => [d, prev.p[i]!]) : []);
      for (const p of e.prices) if (p.date.startsWith(year)) merged.set(p.date, p.close);
      const sorted = [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const packed: PackedEod = { s: e.symbol, c: e.currency, d: sorted.map((x) => x[0]), p: sorted.map((x) => x[1]) };
      ops.push({ type: 'put', pk: k.pk, sk: k.sk, data: JSON.stringify(packed) });
    }
    await this.chunkedBatch(ops);
  }
  /** Appends ECB fixings. Packed layout merges into the year row. */
  async writeFxDays(days: readonly FxDay[]): Promise<void> {
    const pk = keys.fx('EUR').PK;
    if (this.layout.fxLayout === 'day') {
      await this.chunkedBatch(days.map((d) => ({ type: 'put' as const, pk, sk: keys.fxDay(d.base, d.date).SK, data: JSON.stringify(d) })));
      return;
    }
    const years = [...new Set(days.map((d) => d.date.slice(0, 4)))].sort();
    const existing = await this.store.getMany(years.map((y) => ({ pk, sk: fxYearSk(y) })));
    const byYear = new Map(existing.map((r) => [r.sk, parse<PackedFx>(r)]));
    const ops: BatchOp[] = [];
    for (const y of years) {
      const prev = byYear.get(fxYearSk(y));
      const merged = new Map<string, FxDay['rates']>();
      if (prev) prev.d.forEach((d, i) => merged.set(d, Object.fromEntries(prev.c.map((c, j) => [c, prev.r[i]![j]!]))));
      for (const d of days) if (d.date.startsWith(y)) merged.set(d.date, d.rates);
      const packed = packFx('EUR', [...merged.entries()].map(([date, rates]) => ({ base: 'EUR', date, rates })));
      ops.push({ type: 'put', pk, sk: fxYearSk(y), data: JSON.stringify(packed) });
    }
    await this.chunkedBatch(ops);
  }
  async putQuote(q: Quote): Promise<void> {
    const k = keys.quote(q.symbol);
    await this.store.put(k.PK, k.SK, JSON.stringify(q));
  }
  async putProfile(p: InstrumentProfile): Promise<void> {
    const k = keys.profile(p.symbol);
    await this.store.put(k.PK, k.SK, JSON.stringify(p));
  }
  async putDividendEvents(events: readonly DividendEvent[]): Promise<void> {
    await this.chunkedBatch(events.map((e) => ({ type: 'put' as const, pk: keys.dividendEvent(e.symbol, e.exDate).PK, sk: keys.dividendEvent(e.symbol, e.exDate).SK, data: JSON.stringify(e) })));
  }
}
