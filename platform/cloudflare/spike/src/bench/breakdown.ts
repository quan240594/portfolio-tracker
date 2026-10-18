/**
 * Where the CPU goes: decode (store -> objects) vs compute (the shared engine), and what a resumable chunk of the
 * value-history replay costs. Heavy dataset, packed layout + D1-style decode.
 *   node --expose-gc --import tsx src/bench/breakdown.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPositions,
  buildValueHistory,
  calculatePortfolio,
  computeAnalyticsSummary,
  computeBenchmark,
  computeDividendGrowth,
  computeGoal,
  computeGrowth,
  computeHoldingsPerformance,
  computeMetrics,
  computeReturns,
  computeRisk,
  marketSymbols,
  type EodPrice,
} from '../../../../../packages/shared/src/index.js';
import { loadAnalyticsData } from '../../../../../services/api/src/routes/analytics.js';
import { SCENARIOS, buildDataset, setup, NOW } from './harness.ts';

const cpu = async (fn: () => unknown, runs = 25): Promise<number> => {
  for (let i = 0; i < 5; i++) await fn();
  (globalThis as { gc?: () => void }).gc?.();
  const s: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.cpuUsage();
    await fn();
    const d = process.cpuUsage(t);
    s.push((d.user + d.system) / 1000);
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const fmt = (n: number) => Number(n.toFixed(2));

const ds = await buildDataset('heavy');
const out: Record<string, unknown> = { node: process.version };
for (const scenarioId of ['day-plain', 'packed-d1']) {
  const scenario = SCENARIOS.find((x) => x.id === scenarioId)!;
  const s = setup(ds, scenario);
  const ctx = { deps: s.deps, userId: ds.userId, pathParams: {}, query: {} };
  const txns = await s.repo.listTransactions(ds.userId);
  const symbols = marketSymbols([...new Set(txns.map((t) => t.symbol))]);
  const first = txns.reduce((m, t) => (t.date < m ? t.date : m), '9999');
  const today = '2026-10-15';
  const decode = {
    'listTransactions (1,500 rows)': await cpu(() => s.repo.listTransactions(ds.userId)),
    'getEod x30 symbols, 5y': await cpu(() => Promise.all(symbols.map((x) => s.repo.getEod(x, first, today)))),
    'getFxHistory 5y': await cpu(() => s.repo.getFxHistory('EUR', first, today)),
    'getQuotes+getProfiles x30': await cpu(() => Promise.all([s.repo.getQuotes(symbols), s.repo.getProfiles(symbols)])),
    'getDividendEvents x30': await cpu(() => Promise.all(symbols.map((x) => s.repo.getDividendEvents(x)))),
  };
  const data = await loadAnalyticsData(ctx as never, { holdings: true, events: true, eod: true, benchmark: 'IWDA.AS' });
  const compute = {
    'buildPositions (1,500 txns)': await cpu(() => buildPositions(data.transactions)),
    calculatePortfolio: await cpu(() => calculatePortfolio({ transactions: data.transactions, quotes: data.quotes, profiles: data.profiles, fx: data.fx, fxHistory: data.fxHistory, now: NOW })),
    'buildValueHistory ALL (1,826 days)': await cpu(() => buildValueHistory(data.transactions, data.eod as Record<string, EodPrice[]>, data.fx, first, today, data.fxHistory)),
    computeAnalyticsSummary: await cpu(() => computeAnalyticsSummary(data)),
    computeReturns: await cpu(() => computeReturns(data, 'year')),
    computeRisk: await cpu(() => computeRisk(data, 'IWDA.AS')),
    computeBenchmark: await cpu(() => computeBenchmark(data, 'IWDA.AS', 'ALL')),
    computeDividendGrowth: await cpu(() => computeDividendGrowth(data)),
    computeGoal: await cpu(() => computeGoal(data, { targetIncome: 24000, dividendGrowthPct: 5, yieldOnNewMoneyPct: 3.5, monthlyContribution: 1000, years: 15, reinvestDividends: true } as never)),
    'computeGrowth ALL': await cpu(() => computeGrowth(data, 'ALL', ['IWDA.AS'], [])),
    computeMetrics: await cpu(() => computeMetrics(data, 'IWDA.AS')),
    computeHoldingsPerformance: await cpu(() => computeHoldingsPerformance(data, 'ALL')),
    'JSON.stringify(1,500 txns)': await cpu(() => JSON.stringify(data.transactions)),
  };
  // chunked replay: cost of valuing N consecutive days (what a resumable "materialise daily value" job does per invocation)
  const chunks: Record<string, number> = {};
  for (const days of [7, 30, 90, 365]) {
    const from = '2024-01-02';
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const lo = new Date(Date.parse(`${from}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
    const windowEod = Object.fromEntries(Object.entries(data.eod).map(([sym, list]) => [sym, list.filter((p) => p.date >= lo && p.date <= to)]));
    chunks[`${days} days`] = await cpu(() => buildValueHistory(data.transactions, windowEod as Record<string, EodPrice[]>, data.fx, from, to, data.fxHistory));
  }
  out[scenarioId] = { decodeMs: Object.fromEntries(Object.entries(decode).map(([k, v]) => [k, fmt(v)])), computeMs: Object.fromEntries(Object.entries(compute).map(([k, v]) => [k, fmt(v)])), valueHistoryChunkMs: Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, fmt(v)])) };
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `breakdown-node${process.versions.node.split('.')[0]}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
