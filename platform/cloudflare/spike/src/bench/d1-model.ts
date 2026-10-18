/**
 * D1 data-layer model: rows read / written / statements per endpoint and per background job, EXPLAIN QUERY PLAN proof
 * of primary-key use, and the projected daily D1 usage of a typical personal day against the Workers Free caps.
 *
 *   node --import tsx src/bench/d1-model.ts      (Node 22+/24: node:sqlite)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_READ_CASES, WRITE_CASES } from './endpoints.ts';
import { buildDataset, invoke, type Case, type Setup } from './harness.ts';
import { DAY_LAYOUT, ItemsRepository, PACKED_LAYOUT, type RepoOptions } from '../store/items-repository.ts';
import { datasetToRows } from '../store/load-dataset.ts';
import { SqliteItemStore } from '../store/sqlite-store.ts';
import type { Dataset } from '../dataset/types.ts';
import {
  calendarRefresh,
  csvImport,
  deletePortfolioCascade,
  enrichNewSymbol,
  eodRefresh,
  quoteRefresh,
  t212FirstSync,
  t212Incremental,
  type JobCost,
} from './jobs.ts';
import { NOW } from './harness.ts';
import type { Deps } from '../../../../../services/api/src/deps.js';

/** Workers Free daily caps (docs fetched 2026-10-17). */
export const CAPS = { d1RowsRead: 5_000_000, d1RowsWritten: 100_000, workerRequests: 100_000, queueOps: 10_000, kvWrites: 1_000 };

interface EndpointCost {
  id: string;
  statements: number;
  roundTrips: number;
  rowsRead: number;
  rowsWritten: number;
  status: number;
}

function sqliteSetup(ds: Dataset, layout: RepoOptions): Setup & { sqlite: SqliteItemStore } {
  const sqlite = new SqliteItemStore();
  sqlite.bulkLoad(datasetToRows(ds, layout));
  const repo = new ItemsRepository(sqlite, layout);
  let n = 0;
  const deps: Deps = {
    repo,
    mgmt: repo,
    events: { transactionsChanged: () => Promise.resolve() },
    signer: { signCsvUpload: () => Promise.resolve('') },
    config: { baseCurrency: 'EUR', authMode: 'demo', demoUserId: ds.userId, corsAllowedOrigin: '*' },
    now: () => NOW,
    uuid: () => `spike-${++n}`,
  };
  return { ds, store: undefined as never, repo, deps, sqlite };
}

async function endpointCosts(ds: Dataset, layout: RepoOptions): Promise<{ costs: EndpointCost[]; plans: SqliteItemStore['plans']; dbBytes: number; rows: number }> {
  const s = sqliteSetup(ds, layout);
  const costs: EndpointCost[] = [];
  for (const c of [...ALL_READ_CASES, ...WRITE_CASES] as Case[]) {
    s.sqlite.resetStats();
    const r = await invoke(s, c);
    const st = s.sqlite.stats;
    costs.push({ id: c.id, status: r.status, statements: st.queries, roundTrips: st.queries - st.batchedStatements + st.batches, rowsRead: st.rowsRead, rowsWritten: st.rowsWritten });
  }
  const pages = (s.sqlite.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (s.sqlite.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return { costs, plans: s.sqlite.plans, dbBytes: pages * pageSize, rows: s.sqlite.rowCount() };
}

/** A typical personal day: ~150 API calls (page loads fan out into several calls). */
export const TYPICAL_DAY: { id: string; count: number }[] = [
  // 12 dashboard loads
  { id: 'portfolios (list)', count: 12 },
  { id: 'portfolio', count: 12 },
  { id: 'holdings', count: 12 },
  { id: 'allocation (assetClass)', count: 12 },
  { id: 'history (1Y)', count: 12 },
  { id: 'analytics/summary', count: 12 },
  // 4 analytics page visits
  { id: 'analytics/growth (1Y)', count: 4 },
  { id: 'analytics/holdings-performance (ALL)', count: 4 },
  { id: 'analytics/metrics', count: 4 },
  { id: 'analytics/returns (year)', count: 4 },
  { id: 'analytics/risk', count: 4 },
  { id: 'analytics/benchmark (ALL)', count: 4 },
  // 4 dividends page visits
  { id: 'dividends', count: 4 },
  { id: 'dividends/overview', count: 4 },
  { id: 'analytics/dividend-growth', count: 4 },
  // 3 calendar, 3 goals (2 previews each), 4 asset detail pages, 2 rebalance, 3 transaction lists
  { id: 'calendar', count: 3 },
  { id: 'goals (GET)', count: 3 },
  { id: 'goals/calculate (POST)', count: 6 },
  { id: 'assets/AAPL', count: 4 },
  { id: 'assets/AAPL/history (ALL)', count: 4 },
  { id: 'assets/AAPL/positions', count: 4 },
  { id: 'rebalance (buy-only)', count: 2 },
  { id: 'transactions (list, all)', count: 3 },
  // writes
  { id: 'POST /transactions (1 buy)', count: 2 },
  { id: 'PUT /goals', count: 1 },
  { id: 'POST /watchlist', count: 1 },
];

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const pct = (n: number, cap: number) => `${((n / cap) * 100).toFixed(2)}%`;

function projectDay(costs: EndpointCost[], jobs: JobCost[], layoutLabel: string) {
  const byId = new Map(costs.map((c) => [c.id, c]));
  const calls = sum(TYPICAL_DAY.map((t) => t.count));
  const apiReads = sum(TYPICAL_DAY.map((t) => t.count * byId.get(t.id)!.rowsRead));
  const apiWrites = sum(TYPICAL_DAY.map((t) => t.count * byId.get(t.id)!.rowsWritten));
  const apiStatements = sum(TYPICAL_DAY.map((t) => t.count * byId.get(t.id)!.statements));
  const find = (prefix: string) => jobs.find((j) => j.job.startsWith(prefix))!;
  const daily = [
    { job: find('price refresh: quotes only'), times: 3 },
    { job: find('price refresh: end-of-day'), times: 1 },
    { job: find('calendar refresh'), times: 1 },
    { job: jobs.find((j) => j.job.startsWith('T212 incremental sync (3 new') && j.job.includes('reread-all'))!, times: 1 },
  ];
  const jobReads = sum(daily.map((d) => d.job.rowsRead * d.times));
  const jobWrites = sum(daily.map((d) => d.job.rowsWritten * d.times));
  // budget ledger (see report): one upsert per request/job invocation
  const ledgerWrites = calls + daily.reduce((n, d) => n + d.times, 0);
  const reads = apiReads + jobReads;
  const writes = apiWrites + jobWrites + ledgerWrites;
  return {
    layout: layoutLabel,
    apiCalls: calls,
    apiRowsRead: apiReads,
    apiRowsWritten: apiWrites,
    apiStatements,
    jobRowsRead: jobReads,
    jobRowsWritten: jobWrites,
    ledgerWrites,
    totalRowsRead: reads,
    totalRowsWritten: writes,
    readsOfCap: pct(reads, CAPS.d1RowsRead),
    writesOfCap: pct(writes, CAPS.d1RowsWritten),
    readHeadroomX: Number((CAPS.d1RowsRead / reads).toFixed(1)),
    writeHeadroomX: Number((CAPS.d1RowsWritten / writes).toFixed(1)),
  };
}

const ds = await buildDataset('heavy');
const baseline = await buildDataset('baseline');
const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), node: process.version, caps: CAPS };

const layouts: [string, RepoOptions][] = [
  ['day', DAY_LAYOUT],
  ['packed', PACKED_LAYOUT],
];
const planReport: Record<string, { sql: string; plan: string[] }> = {};
const endpoint: Record<string, EndpointCost[]> = {};
const storage: Record<string, { rows: number; megabytes: number }> = {};
for (const [label, layout] of layouts) {
  const r = await endpointCosts(ds, layout);
  endpoint[label] = r.costs;
  storage[label] = { rows: r.rows, megabytes: Number((r.dbBytes / 1e6).toFixed(1)) };
  for (const [k, v] of r.plans) planReport[`${label}: ${k}`] = v;
}
const baselineCosts = (await endpointCosts(baseline, DAY_LAYOUT)).costs;
out.endpoint = endpoint;
out.baselineEndpointDayLayout = baselineCosts;
out.storage = storage;

// plan check: every statement must SEARCH the primary key (a SCAN of `items` would read the whole table)
const scans = Object.entries(planReport).filter(([, p]) => p.plan.some((d) => /SCAN items/.test(d)));
out.plans = planReport;
// INSERT ... ON CONFLICT has no query plan output (rows written = rows inserted; the table has no secondary index)
const selects = Object.values(planReport).filter((p) => !/^INSERT/.test(p.sql));
out.planCheck = { statements: Object.keys(planReport).length, selectAndDeleteStatements: selects.length, fullScansOfItems: scans.map(([k]) => k), allSearchPrimaryKey: selects.every((p) => p.plan.some((d) => /SEARCH items USING PRIMARY KEY/.test(d))) };

// negative control: the same lookup without the key (what an unindexed json_extract filter costs)
{
  const s = sqliteSetup(ds, DAY_LAYOUT);
  const plan = (s.sqlite.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM items WHERE json_extract(data, '$.id') = 'heavy-00001'").all() as { detail: string }[]).map((r) => r.detail);
  out.negativeControl = { sql: "SELECT data FROM items WHERE json_extract(data,'$.id') = ?", plan, rowsReadWouldBe: s.sqlite.rowCount() };
}

// jobs
const jobs: JobCost[] = [];
for (const [, layout] of layouts) {
  jobs.push(await quoteRefresh(ds, layout));
  jobs.push(await eodRefresh(ds, layout));
  jobs.push(await enrichNewSymbol(ds, layout));
  jobs.push(await calendarRefresh(ds, layout));
  jobs.push(await t212FirstSync(ds, layout, 300, 'reread-all'));
  jobs.push(await t212FirstSync(ds, layout, 300, 'snapshot'));
  jobs.push(await t212Incremental(ds, layout, 'reread-all', 0));
  jobs.push(await t212Incremental(ds, layout, 'reread-all', 3));
  jobs.push(await t212Incremental(ds, layout, 'snapshot', 3));
  jobs.push(await csvImport(ds, layout));
  jobs.push(await deletePortfolioCascade(ds, layout));
}
out.jobs = jobs;

// daily projections
const projections = [
  projectDay(endpoint.day!, jobs.filter((j) => j.layout === 'day'), 'row per day (DynamoDB parity)'),
  projectDay(endpoint.packed!, jobs.filter((j) => j.layout === 'packed'), 'row per symbol-year (packed)'),
];
out.projection = projections;
out.typicalDay = TYPICAL_DAY;

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'd1-model.json'), JSON.stringify(out, null, 2));

// console summary
const fmt = (n: number) => n.toLocaleString('en');
console.log('\n== storage', JSON.stringify(storage));
console.log('\n== plan check', JSON.stringify(out.planCheck));
for (const [k, p] of Object.entries(planReport).slice(0, 40)) console.log(`  ${k}\n     ${p.plan.join(' | ')}`);
console.log('\n== negative control', JSON.stringify(out.negativeControl));
console.log('\n== endpoints (heavy): stmts / rows read / rows written');
const day = new Map(endpoint.day!.map((c) => [c.id, c]));
for (const c of endpoint.packed!) {
  const d = day.get(c.id)!;
  console.log(`  ${c.id.padEnd(40)} day: ${String(d.statements).padStart(3)} stmts ${fmt(d.rowsRead).padStart(7)} r ${String(d.rowsWritten).padStart(3)} w | packed: ${String(c.statements).padStart(3)} stmts ${fmt(c.rowsRead).padStart(6)} r ${String(c.rowsWritten).padStart(3)} w`);
}
console.log('\n== jobs');
for (const j of jobs) console.log(`  [${j.layout.padEnd(6)}] ${j.job.padEnd(78)} stmts=${String(j.statements).padStart(3)} trips=${String(j.roundTrips).padStart(3)} r=${fmt(j.rowsRead).padStart(6)} w=${fmt(j.rowsWritten).padStart(6)}${j.cpuMs === undefined ? '' : ` cpu=${j.cpuMs.toFixed(1)}ms`}`);
console.log('\n== typical day projection');
console.log(JSON.stringify(projections, null, 2));
