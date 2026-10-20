import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS_PER_DAY } from './jobs/enrich.js';
import { SIM_FUNDS, SIM_LISTED, SIM_START, SIM_SYMBOLS, SIM_US, simulateFreePlan, type FreePlanReport, type SimJob } from './testing/free-plan-sim.js';

/**
 * The owner's portfolio on the free plans (Twelve Data: 8 credits a minute and no `/profile`; EODHD: 20 calls a day and HTTP 402
 * after that; no Alpha Vantage key), driven like the Durable Object alarm queue. Before the quota handling a 26-symbol portfolio
 * left 21 symbols without a profile and burned ~42 alarm steps, ~146 subrequests and ~230 rows in the first hour (every failing
 * symbol was tried in three rounds, each paced 30 s apart): see docs/architecture.md "Instrument classification".
 */
const HOUR = 3_600_000;
const symbolsOf = (urls: string[], pattern: RegExp): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const symbol = pattern.exec(url)?.[1];
    if (symbol !== undefined) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  return counts;
};

const trackedStore = (): MemoryItemStore => new MemoryItemStore().load(SIM_SYMBOLS.map((symbol) => ({ PK: 'TRACKED', SK: `TICKER#${symbol}`, entityType: 'TRACKED_TICKER', symbol })));
const enrichAll = (at: number): SimJob => ({ name: 'enrichTransactions', payload: { userId: 'u', portfolioId: 'p', reason: 'CREATED', symbols: [...SIM_SYMBOLS] }, at });
const refresh = (iso: string): SimJob => ({ name: 'refreshPrices', payload: { trigger: 'scheduled' }, at: Date.parse(iso) });
const requestsOn = (report: FreePlanReport, day: string, pattern: RegExp): string[] =>
  report.requests.filter((request) => new Date(request.at).toISOString().startsWith(day) && pattern.test(request.url)).map((request) => request.url);

describe('free-plan simulation', () => {
  it('burns almost nothing while the quotas are exhausted, however often a sync asks again', async () => {
    // The first sync, then a TransactionsChanged event (a new sync) every 15 minutes for 14 hours.
    const resyncs = Array.from({ length: 56 }, (_, i) => enrichAll(SIM_START + (i + 1) * 15 * 60_000));
    const report = await simulateFreePlan({
      hours: 15,
      store: trackedStore(),
      jobs: [enrichAll(SIM_START), ...resyncs, refresh('2026-10-20T11:00:00Z'), refresh('2026-10-20T16:00:00Z'), refresh('2026-10-20T20:00:00Z')],
    });
    // The daily EODHD quota is used up within the first hour; until the reset an hour costs far less than 100 rows and a handful of
    // requests (the scheduled price refreshes), while 56 jobs sleep.
    const exhausted = report.perHour.slice(1);
    expect(Math.max(...exhausted.map((hour) => hour.rowsWritten))).toBeLessThan(100);
    expect(Math.max(...exhausted.map((hour) => hour.fetches))).toBeLessThan(10);
    // No provider was ever asked beyond its free limits (a 402 / 429 answer would be counted).
    expect(report.limited).toEqual({ twelvedata: 0, eodhd: 0 });
    expect(report.failedJobs).toBe(0);
    // A symbol is tried at most MAX_ATTEMPTS_PER_DAY times a day.
    const histories = symbolsOf(requestsOn(report, '2026-10-20', /time_series|\/api\/eod\//), /(?:symbol=|\/api\/eod\/)([^&?/]+)/);
    expect(Math.max(...histories.values())).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_DAY);
    // The Twelve Data symbols are all done, the exchange-listed ones as far as 20 calls go.
    expect(SIM_US.every((symbol) => report.profiles.has(symbol))).toBe(true);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.missing.every((symbol) => SIM_LISTED.includes(symbol) || SIM_FUNDS.includes(symbol))).toBe(true);
  });

  it('finishes the rest after the quota resets, without a retry storm', async () => {
    const report = await simulateFreePlan({
      hours: 40,
      store: trackedStore(),
      jobs: [enrichAll(SIM_START), enrichAll(SIM_START + 3 * HOUR), refresh('2026-10-20T11:00:00Z'), refresh('2026-10-21T06:00:00Z')],
    });
    expect(report.missing).toEqual([]);
    expect(report.minimal).toEqual([]);
    expect(report.limited).toEqual({ twelvedata: 0, eodhd: 0 });
    expect(report.total.steps).toBeLessThan(40);
    expect(report.maxStepsPerMinute).toBeLessThanOrEqual(2);
    // Day two used only what the day-one quota left undone.
    expect(requestsOn(report, '2026-10-21', /eodhd\.com/).length).toBeLessThanOrEqual(20);
    expect(Math.max(...report.perHour.map((hour) => hour.rowsWritten))).toBeLessThan(400);
  });
});
