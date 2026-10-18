/**
 * Feasibility numbers for the two ways of making the heavy analytics cheap on a 10 ms Worker:
 *  (a) MATERIALISE: how much of each endpoint is "build the daily value history" (what a background job would precompute
 *      and store) vs the remaining maths over that series, and how big/costly the stored series is;
 *  (c) HYBRID: how many bytes of RAW rows the browser would download for the heavy dataset (JSON, compact, gzip, brotli),
 *      and the CPU the shared pure engine needs on them (Node V8 CPU as the proxy of a browser).
 *   node --expose-gc --import tsx src/bench/hybrid.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  buildContext,
  computeAnalyticsSummary,
  computeBenchmark,
  computeDividendGrowth,
  computeGrowth,
  computeHoldingsPerformance,
  computeMetrics,
  computeReturns,
  computeRisk,
  type AnalyticsData,
  type EodPrice,
} from '../../../../../packages/shared/src/index.js';
import { loadAnalyticsData } from '../../../../../services/api/src/routes/analytics.js';
import { SCENARIOS, buildDataset, setup } from './harness.ts';

const gc = () => (globalThis as { gc?: () => void }).gc?.();
const fmt = (n: number) => Number(n.toFixed(2));

/** Median / p95 of V8 CPU (user + system), warm. */
function cpu(fn: () => unknown, runs = 25): { median: number; p95: number } {
  for (let i = 0; i < 5; i++) fn();
  gc();
  const s: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.cpuUsage();
    fn();
    const d = process.cpuUsage(t);
    s.push((d.user + d.system) / 1000);
  }
  s.sort((a, b) => a - b);
  return { median: fmt(s[Math.floor(s.length / 2)]!), p95: fmt(s[Math.ceil(0.95 * s.length) - 1]!) };
}

const sizes = (text: string) => ({ bytes: Buffer.byteLength(text), gzip: gzipSync(text).length, brotli: brotliCompressSync(text).length });

const ds = await buildDataset('heavy');
const s = setup(ds, SCENARIOS.find((x) => x.id === 'packed-d1')!);
const ctx = { deps: s.deps, userId: ds.userId, pathParams: {}, query: {} };
const data: AnalyticsData = await loadAnalyticsData(ctx as never, { holdings: true, events: true, eod: true, benchmark: 'IWDA.AS' });

// ---- (a) how much of each analytics call is the value-history replay -------------------------------------------------
const history = cpu(() => buildContext(data));
const ctxBuilt = buildContext(data)!;
const calls: Record<string, () => unknown> = {
  'analytics/summary': () => computeAnalyticsSummary(data),
  'analytics/returns': () => computeReturns(data, 'year'),
  'analytics/risk': () => computeRisk(data, 'IWDA.AS'),
  'analytics/benchmark (ALL)': () => computeBenchmark(data, 'IWDA.AS', 'ALL'),
  'analytics/growth (ALL)': () => computeGrowth(data, 'ALL', ['IWDA.AS'], []),
  'analytics/metrics': () => computeMetrics(data, 'IWDA.AS'),
  'analytics/holdings-performance (ALL)': () => computeHoldingsPerformance(data, 'ALL'),
  'analytics/dividend-growth': () => computeDividendGrowth(data),
};
const split: Record<string, { totalMedian: number; totalP95: number; contextMedian: number; tailMedian: number; tailShare: string }> = {};
for (const [id, fn] of Object.entries(calls)) {
  const t = cpu(fn);
  const ctxShare = id === 'analytics/dividend-growth' ? 0 : history.median;
  const tail = Math.max(0, t.median - ctxShare);
  split[id] = { totalMedian: t.median, totalP95: t.p95, contextMedian: fmt(ctxShare), tailMedian: fmt(tail), tailShare: `${Math.round((tail / t.median) * 100)}%` };
}

// the materialised series a background job would store: [date, value, invested] per day, plus the flow-adjusted returns
const series = ctxBuilt.history.map((p) => [p.date, p.value, p.invested] as const);
const seriesPacked = JSON.stringify({
  d0: ctxBuilt.history[0]!.date,
  v: ctxBuilt.history.map((p) => Math.round(p.value * 100) / 100),
  i: ctxBuilt.history.map((p) => Math.round(p.invested * 100) / 100),
});
const seriesObjects = JSON.stringify(ctxBuilt.history);
const materialised = {
  days: series.length,
  jsonObjects: sizes(seriesObjects),
  jsonPackedArrays: sizes(seriesPacked),
  decodePackedMs: cpu(() => JSON.parse(seriesPacked)),
  note: 'portfolio-level series only; per-holding series (30 holdings) would be 30x this and is NOT materialised, see holdings-performance',
};

// ---- (c) raw rows the browser would need ----------------------------------------------------------------------------
const naive = JSON.stringify(data);
const compactEod = Object.fromEntries(
  Object.entries(data.eod).map(([sym, rows]) => {
    const list = rows as readonly EodPrice[];
    return [sym, { c: list[0]?.currency, d: list.map((r) => r.date), p: list.map((r) => Math.round(r.close * 1e4) / 1e4) }];
  }),
);
const compactData = { ...data, eod: compactEod };
const compact = JSON.stringify(compactData);
const eodOnlyNaive = JSON.stringify(data.eod);
const eodOnlyCompact = JSON.stringify(compactEod);
const decodeCompact = () => {
  const o = JSON.parse(compact) as { eod: Record<string, { c: string; d: string[]; p: number[] }> };
  const eod: Record<string, EodPrice[]> = {};
  for (const [sym, v] of Object.entries(o.eod)) eod[sym] = v.d.map((date, i) => ({ symbol: sym, date, close: v.p[i]!, currency: v.c }));
  return eod;
};
// A Worker that only STORES/SERVES raw rows never parses them: rows are kept as ready-made JSON text and concatenated.
const txnTexts = data.transactions.map((t) => JSON.stringify(t));
const eodTexts = Object.entries(compactEod).map(([sym, v]) => `${JSON.stringify(sym)}:${JSON.stringify(v)}`);
const passThrough = cpu(() => {
  const body = `{"transactions":[${txnTexts.join(',')}],"eod":{${eodTexts.join(',')}}}`;
  return new TextEncoder().encode(body).length;
});

const eodRows = Object.values(data.eod).reduce((n, l) => n + l.length, 0);
const payload = {
  eodRows,
  fxDays: data.fxHistory?.length ?? 0,
  transactions: data.transactions.length,
  dividendEvents: data.dividendEvents.length,
  analyticsDataNaiveJson: sizes(naive),
  analyticsDataCompactJson: sizes(compact),
  eodOnlyNaive: sizes(eodOnlyNaive),
  eodOnlyCompact: sizes(eodOnlyCompact),
  parseNaiveMs: cpu(() => JSON.parse(naive)),
  parseAndDecodeCompactMs: cpu(decodeCompact),
  workerPassThroughConcatMs: passThrough,
  note: 'raw rows of ONE portfolio view incl. one benchmark; the browser keeps them in memory/IndexedDB and re-downloads only new days (deltas)',
};

// ---- (c) engine CPU for a whole analytics page on the parsed data ---------------------------------------------------
const page = cpu(() => {
  computeAnalyticsSummary(data);
  computeReturns(data, 'year');
  computeRisk(data, 'IWDA.AS');
  computeBenchmark(data, 'IWDA.AS', 'ALL');
  computeGrowth(data, 'ALL', ['IWDA.AS'], []);
  computeMetrics(data, 'IWDA.AS');
  computeHoldingsPerformance(data, 'ALL');
}, 15);

const out = {
  node: process.version,
  arch: process.arch,
  dataset: 'heavy (30 holdings, 5 years, 1,500 transactions)',
  buildContextMs: history,
  split,
  materialised,
  payload,
  browserEngine: { wholeAnalyticsPageMsNode: page, note: 'sum of 7 analytics computations on already-parsed data; a mid-range phone is typically 3-5x slower than an M-series core (ASSUMPTION, not measured)' },
};
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `hybrid-node${process.versions.node.split('.')[0]}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
