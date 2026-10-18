/**
 * Background-job cost model on the items table: every job of the app is replayed against a SqliteItemStore (the same
 * SQL D1 runs) and its D1 statements / rows read / rows written are counted, plus the Node CPU of the compute part.
 */
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_PORTFOLIO_ID,
  keys,
  transactionsToCsv,
  type EodPrice,
  type FxDay,
  type ImportStatus,
  type Quote,
  type Transaction,
} from '../../../../../packages/shared/src/index.js';
import { processImportObject } from '../../../../../services/ingest/src/processor.js';
import type { IngestDeps } from '../../../../../services/ingest/src/processor.js';
import type { IngestStore } from '../../../../../services/ingest/src/store.js';
import type { Dataset } from '../dataset/types.ts';
import { ItemsRepository, PACKED_LAYOUT, DAY_LAYOUT, type RepoOptions } from '../store/items-repository.ts';
import { datasetToRows } from '../store/load-dataset.ts';
import type { StoreStats } from '../store/item-store.ts';
import { SqliteItemStore } from '../store/sqlite-store.ts';
import { NOW } from './harness.ts';

export interface JobCost {
  job: string;
  layout: string;
  /** D1 statements (each counts as a subrequest on Workers Free, pessimistically). */
  statements: number;
  /** Round trips: batch() counted once. */
  roundTrips: number;
  rowsRead: number;
  rowsWritten: number;
  /** Node CPU of the non-I/O compute inside the job (parse/validate/map), when measured. */
  cpuMs?: number;
  note?: string;
}

export function freshStore(ds: Dataset, layout: RepoOptions) {
  const store = new SqliteItemStore();
  store.bulkLoad(datasetToRows(ds, layout));
  const repo = new ItemsRepository(store, layout);
  store.resetStats();
  return { store, repo };
}

const cost = (job: string, layout: RepoOptions, s: StoreStats, extra: Partial<JobCost> = {}): JobCost => ({
  job,
  layout: layout === PACKED_LAYOUT ? 'packed' : 'day',
  statements: s.queries,
  roundTrips: s.queries - s.batchedStatements + s.batches,
  rowsRead: s.rowsRead,
  rowsWritten: s.rowsWritten,
  ...extra,
});

const nextTradingDay = (today: string) => {
  const d = new Date(`${today}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
};

/** Intraday quote refresh (what the scheduled refresh does 3 of the 4 daily runs): read TRACKED, write one quote per symbol. */
export async function quoteRefresh(ds: Dataset, layout: RepoOptions): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const tracked = await store.query('TRACKED', { begins: 'TICKER#' });
  const quotes: Quote[] = tracked.map((r) => {
    const symbol = r.sk.slice('TICKER#'.length);
    return { symbol, price: 100, previousClose: 99, currency: 'USD', asOf: `${ds.today}T17:30:00.000Z`, source: 'spike' };
  });
  await repo.chunkedBatch(quotes.map((q) => ({ type: 'put' as const, pk: keys.quote(q.symbol).PK, sk: keys.quote(q.symbol).SK, data: JSON.stringify(q) })));
  return cost('price refresh: quotes only (x3/day)', layout, store.stats, { note: `${quotes.length} tracked symbols` });
}

/** End-of-day run: quotes + the day's close of every symbol + the ECB fixing. */
export async function eodRefresh(ds: Dataset, layout: RepoOptions): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const tracked = await store.query('TRACKED', { begins: 'TICKER#' });
  const day = nextTradingDay(ds.today);
  await repo.chunkedBatch(
    tracked.map((r) => {
      const symbol = r.sk.slice('TICKER#'.length);
      return { type: 'put' as const, pk: keys.quote(symbol).PK, sk: keys.quote(symbol).SK, data: JSON.stringify({ symbol, price: 100, previousClose: 99, currency: 'USD', asOf: day, source: 'spike' }) };
    }),
  );
  await repo.writeEodMany(
    tracked.map((r) => {
      const symbol = r.sk.slice('TICKER#'.length);
      const price: EodPrice = { symbol, date: day, close: 101, currency: 'USD' };
      return { symbol, currency: 'USD', prices: [price] };
    }),
  );
  const fxDay: FxDay = { base: 'EUR', date: day, rates: { USD: 1.17, GBP: 0.87, CHF: 0.93 } };
  await repo.writeFxDays([fxDay]);
  await store.put(keys.fx('EUR').PK, keys.fx('EUR').SK, JSON.stringify({ base: 'EUR', rates: fxDay.rates, asOf: day }));
  return cost('price refresh: end-of-day (x1/day)', layout, store.stats, { note: `${tracked.length} symbols` });
}

/** First purchase of a new symbol: profile, tracking, 5y history backfill (one provider call), dividend history. */
export async function enrichNewSymbol(ds: Dataset, layout: RepoOptions): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const symbol = 'NEW.AS';
  const start = new Date('2021-10-15T00:00:00Z');
  const prices: EodPrice[] = [];
  for (let i = 0; i < 1826; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    if ([0, 6].includes(d.getUTCDay())) continue;
    prices.push({ symbol, date: d.toISOString().slice(0, 10), close: 50 + i / 100, currency: 'EUR' });
  }
  await repo.trackTickers([{ symbol, currency: 'EUR' }]);
  await repo.putProfile({ symbol, name: 'New Co', assetClass: 'STOCK', currency: 'EUR' } as never);
  await repo.writeEod(symbol, 'EUR', prices);
  await repo.putDividendEvents(Array.from({ length: 20 }, (_, i) => ({ symbol, exDate: `${2022 + Math.floor(i / 4)}-0${(i % 4) * 3 + 1}-10`, amount: 0.5, currency: 'EUR' })));
  await repo.putQuote({ symbol, price: 60, previousClose: 59, currency: 'EUR', asOf: `${ds.today}T17:30:00.000Z`, source: 'spike' });
  return cost('enrichment of one new symbol (5y backfill)', layout, store.stats, { note: `${prices.length} price rows backfilled` });
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Trading 212 first full sync: 1,500 mapped transactions written in chunks (the fetching itself is not D1 work). */
export async function t212FirstSync(ds: Dataset, layout: RepoOptions, chunk = 300, validate: 'reread-all' | 'snapshot' = 'reread-all'): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const txns = ds.items.filter((i) => i.entityType === 'TRANSACTION').map((i) => clone(i) as unknown as Record<string, unknown>);
  const mapped: Transaction[] = txns.map((t) => ({ ...(t as unknown as Transaction), portfolioId: 'trading-212-sync', importId: 'trading212', id: `t212-${String(t.id)}` }));
  await repo.createPortfolio({ portfolioId: 'trading-212-sync', userId: ds.userId, name: 'T212 sync', createdAt: ds.today, updatedAt: ds.today });
  store.resetStats();
  let chunks = 0;
  for (let i = 0; i < mapped.length; i += chunk) {
    chunks++;
    const part = mapped.slice(i, i + chunk);
    if (validate === 'reread-all') await repo.listTransactions(ds.userId, 'trading-212-sync'); // oversell + currency validation against stored rows
    await repo.putTransactions(part);
    await store.put(`USER#${ds.userId}`, 'BROKER#trading212#trading-212-sync', JSON.stringify({ status: 'RUNNING', cursors: { orders: part.at(-1)!.date }, counts: { written: i + part.length } }));
  }
  await repo.trackTickers([...new Map(mapped.map((t) => [t.symbol, t.currency])).entries()].map(([symbol, currency]) => ({ symbol, currency })));
  return cost(`T212 first full sync (${mapped.length} txns, chunks of ${chunk}, validate=${validate})`, layout, store.stats, { note: `${chunks} invocations` });
}

/** Daily incremental sync: nothing new (the normal case) or 3 new fills. */
export async function t212Incremental(ds: Dataset, layout: RepoOptions, validate: 'reread-all' | 'snapshot', newTxns: number): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const sample = ds.items.filter((i) => i.entityType === 'TRANSACTION').slice(0, newTxns).map((i) => ({ ...(clone(i) as unknown as Transaction), id: `t212-new-${Math.random()}`, date: ds.today }));
  await store.get(`USER#${ds.userId}`, 'BROKER#trading212#trading-212'); // state + cursors
  if (validate === 'reread-all') await repo.listTransactions(ds.userId); // current implementation validates the merged set
  if (sample.length > 0) {
    await repo.putTransactions(sample);
    await repo.trackTickers([...new Set(sample.map((t) => t.symbol))].map((symbol) => ({ symbol, currency: 'USD' })));
  }
  await store.put(`USER#${ds.userId}`, 'BROKER#trading212#trading-212', JSON.stringify({ status: 'SUCCEEDED', lastSuccessAt: ds.today }));
  return cost(`T212 incremental sync (${newTxns} new, validate=${validate})`, layout, store.stats);
}

/** Daily calendar refresh: 1 Alpha Vantage CSV (filtered to tracked symbols), 4 EODHD symbol checks, budget + markers. */
export async function calendarRefresh(ds: Dataset, layout: RepoOptions): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const tracked = await store.query('TRACKED', { begins: 'TICKER#' });
  await store.get('CALENDAR', 'BUDGET#alphavantage');
  await store.get('CALENDAR', 'BUDGET#eodhd');
  const states = await store.getMany(tracked.slice(0, 8).map((r) => ({ pk: r.pk.replace('TRACKED', `TICKER#${r.sk.slice(7)}`), sk: 'CAL#STATE' })));
  void states;
  const us = tracked.filter((r) => /^TICKER#[A-Z]{1,5}$/.test(r.sk)).slice(0, 14);
  const ops = us.map((r) => {
    const sym = r.sk.slice('TICKER#'.length);
    return { type: 'put' as const, pk: `TICKER#${sym}`, sk: `EARN#${ds.today}`, data: JSON.stringify({ symbol: sym, date: ds.today, source: 'alphavantage' }) };
  });
  for (let i = 0; i < 4; i++) {
    const sym = tracked[i]!.sk.slice('TICKER#'.length);
    ops.push({ type: 'put', pk: `TICKER#${sym}`, sk: `CAL#STATE`, data: JSON.stringify({ splitsCheckedAt: ds.today }) });
  }
  ops.push({ type: 'put', pk: 'CALENDAR', sk: 'BUDGET#alphavantage', data: JSON.stringify({ day: ds.today, used: 1 }) }, { type: 'put', pk: 'CALENDAR', sk: 'BUDGET#eodhd', data: JSON.stringify({ day: ds.today, used: 8 }) });
  await repo.chunkedBatch(ops);
  return cost('calendar refresh (x1/day)', layout, store.stats, { note: `${ops.length} rows written` });
}

/** The real ingest processor (services/ingest) against the items table, importing a 1,500-row CSV. */
export async function csvImport(ds: Dataset, layout: RepoOptions): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const userId = ds.userId;
  const rows = ds.items.filter((i) => i.entityType === 'TRANSACTION').map((i) => clone(i) as unknown as Transaction);
  const csv = transactionsToCsv(rows.slice(0, 1500));
  const importId = 'imp-1';
  const target = 'imp-target';
  await repo.createPortfolio({ portfolioId: target, userId, name: 'Import target', createdAt: ds.today, updatedAt: ds.today });
  const status: ImportStatus = { importId, userId, portfolioId: target, fileName: 'big.csv', status: 'PENDING', createdAt: ds.today, updatedAt: ds.today };
  await repo.putImport(status);
  const ingestStore: IngestStore = {
    getImport: (u, i) => repo.getImport(u, i),
    markProcessing: async (u, i) => {
      const s = await repo.getImport(u, i);
      if (!s || s.status === 'COMPLETED' || s.status === 'FAILED') return false;
      await repo.putImport({ ...s, status: 'PROCESSING' });
      return true;
    },
    markFailed: async (u, i, rowCount, errors) => repo.putImport({ ...(await repo.getImport(u, i))!, status: 'FAILED', rowCount, errors }),
    markCompleted: async (u, i, rowCount, importedCount) => repo.putImport({ ...(await repo.getImport(u, i))!, status: 'COMPLETED', rowCount, importedCount }),
    portfolioExists: async (u, p) => (await repo.getPortfolio(u, p)) !== null,
    listTransactions: (u) => repo.listTransactions(u),
    putTransactions: (t) => repo.putTransactions(t),
    registerUser: (u) => repo.registerUser(u),
    trackTickers: (t) => repo.trackTickers(t),
  };
  const deps: IngestDeps = {
    store: ingestStore,
    reader: { readText: () => Promise.resolve({ ok: true, content: csv }) } as never,
    events: { transactionsChanged: () => Promise.resolve() },
    now: () => NOW,
  };
  store.resetStats();
  const t0 = performance.now();
  const c0 = process.cpuUsage();
  const outcome = await processImportObject(deps, { bucket: 'b', key: `imports/${userId}/${importId}.csv` });
  const c = process.cpuUsage(c0);
  void t0;
  return cost(`CSV import of ${rows.slice(0, 1500).length} rows (${outcome}, ${(csv.length / 1024).toFixed(0)} KB)`, layout, store.stats, { cpuMs: (c.user + c.system) / 1000, note: 'cpuMs = whole processor incl. csv-parse + zod row validation + oversell replay (Node, cold-ish single run)' });
}

/** Deleting a portfolio with ~750 transactions (cascade). */
export async function deletePortfolioCascade(ds: Dataset, layout: RepoOptions): Promise<JobCost> {
  const { store, repo } = freshStore(ds, layout);
  const txns = await repo.listTransactions(ds.userId, 'trading-212');
  await repo.deleteTransactions(txns);
  await repo.deletePortfolioData(ds.userId, 'trading-212');
  await repo.deletePortfolio(ds.userId, 'trading-212');
  return cost(`delete portfolio with ${txns.length} txns (force)`, layout, store.stats);
}

export const ALL_LAYOUTS: RepoOptions[] = [DAY_LAYOUT, PACKED_LAYOUT];
export { DEFAULT_PORTFOLIO_ID };
