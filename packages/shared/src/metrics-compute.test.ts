import { describe, expect, it } from 'vitest';
import { computeAnalyticsSummary, computeBenchmark, computeRisk, type AnalyticsData } from './analytics-compute.js';
import { computeMetrics } from './metrics-compute.js';
import { addIsoDays } from './analytics.js';
import type { EodPrice, FxRates, Transaction } from './types.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-01-02T00:00:00Z' };
const buy = (over: Partial<Transaction> = {}): Transaction => ({
  id: `t-${over.date ?? 'x'}-${over.symbol ?? 'AAA'}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2025-01-02',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 10,
  price: 100,
  fee: 0,
  currency: 'EUR',
  createdAt: '2025-01-01T00:00:00Z',
  ...over,
});
const close = (symbol: string, date: string, value: number): EodPrice => ({ symbol, date, close: value, currency: 'EUR' });

/** Weekday closes of a gently rising, wiggly path. */
function wavy(symbol: string, start: string, n: number, amplitude: number, drift: number): EodPrice[] {
  const out: EodPrice[] = [];
  for (let k = 0; k < n; k++) {
    const date = addIsoDays(start, k);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) out.push(close(symbol, date, 100 + drift * k + amplitude * Math.sin(k / 2)));
  }
  return out;
}

const profiles = {
  AAA: { symbol: 'AAA', name: 'Alpha Inc', assetClass: 'STOCK' as const, currency: 'EUR', peRatio: 25, fundamentalsAsOf: '2025-12-01' },
  ETF1: { symbol: 'ETF1', name: 'World ETF', assetClass: 'ETF' as const, currency: 'EUR' },
};

const aaa = wavy('AAA', '2024-12-20', 380, 4, 0.2);
const bmk = wavy('BMK', '2024-12-20', 380, 2, 0.12);

const data = (over: Partial<AnalyticsData> = {}): AnalyticsData => ({
  transactions: [buy()],
  quotes: { AAA: { symbol: 'AAA', price: aaa.at(-1)!.close, previousClose: aaa.at(-2)!.close, currency: 'EUR', asOf: '2026-01-02', source: 't' } },
  profiles,
  fx,
  eod: { AAA: aaa, BMK: bmk },
  dividendEvents: [],
  today: '2026-01-02',
  ...over,
});

describe('computeMetrics', () => {
  it('agrees with the summary, risk and benchmark calculators it builds on', () => {
    const d = data();
    const m = computeMetrics(d, 'BMK');
    const summary = computeAnalyticsSummary(d);
    const risk = computeRisk(d, 'BMK');
    const comparison = computeBenchmark(d, 'BMK', 'ALL').comparison!;

    expect(m.baseCurrency).toBe('EUR');
    expect(m.riskFreeRatePct).toBe(2.5);
    expect(m.benchmark).toEqual({ symbol: 'BMK', available: true });
    expect(m.twr.portfolio).toBe(summary.performance.twrPct);
    expect(m.twr).toMatchObject({ from: '2025-01-02', to: '2026-01-02', days: 365, benchmarkFrom: '2025-01-02' });
    expect(m.twr.benchmark).toBe(comparison.benchmarkReturnPct);
    expect(m.twr.difference).toBe(comparison.differencePct);
    expect(m.twr.difference).toBeCloseTo(m.twr.portfolio! - m.twr.benchmark!, 2);

    expect(m.volatility.portfolio).toBe(risk.volatilityPct);
    expect(m.sharpe.portfolio).toBeCloseTo(risk.sharpe!, 2);
    expect(m.sortino.portfolio).toBeCloseTo(risk.sortino!, 2);
    expect(m.volatility.beta).toBeCloseTo(risk.benchmark.beta!, 2);
    expect(m.volatility.observations).toBe(risk.observations);
    expect(m.volatility.benchmarkObservations).toBe(risk.observations);
  });

  it('computes the benchmark with the same calculators over the same window', () => {
    // A benchmark that IS the portfolio's only holding has identical figures and beta 1.
    const same = computeMetrics(data({ eod: { AAA: aaa } }), 'AAA');
    expect(same.volatility.benchmark).toBe(same.volatility.portfolio);
    expect(same.sharpe.benchmark).toBe(same.sharpe.portfolio);
    expect(same.sortino.benchmark).toBe(same.sortino.portfolio);
    expect(same.volatility.beta).toBe(1);
    expect(same.volatility.verdict).toMatchObject({ level: 'in-line' });
    expect(same.twr.benchmark!).toBeCloseTo(same.twr.portfolio!, 0);
  });

  it('classifies the verdicts from the returned figures', () => {
    const m = computeMetrics(data(), 'BMK');
    expect(m.sharpe.verdict?.level).toBeDefined();
    expect(m.volatility.verdict).not.toBeNull();
    expect(m.sortino.verdict).not.toBeNull();
    const calm = computeMetrics(data({ eod: { AAA: wavy('AAA', '2024-12-20', 380, 0.5, 0.01), BMK: bmk } }), 'BMK');
    expect(calm.volatility.verdict?.level).toBe('lower');
    expect(calm.volatility.beta!).toBeLessThan(0.9);
  });

  it('computes the portfolio P/E from the profiles of the held stocks', () => {
    const m = computeMetrics(data(), 'BMK');
    expect(m.pe.portfolio).toBe(25);
    expect(m.pe.benchmark).toBeNull();
    expect(m.pe.coverage).toMatchObject({ includedStocks: 1, totalStocks: 1, portfolioSharePct: 100 });
    expect(m.pe.asOf).toBe('2025-12-01');
    const withBenchmarkPe = computeMetrics(data({ profiles: { ...profiles, BMK: { symbol: 'BMK', name: 'Bench', assetClass: 'ETF', currency: 'EUR', peRatio: 19.5 } } }), 'BMK');
    expect(withBenchmarkPe.pe.benchmark).toBe(19.5);
  });

  it('reports no P/E when the held stock has no earnings data', () => {
    const m = computeMetrics(data({ profiles: { AAA: { ...profiles.AAA, peRatio: undefined } } }), 'BMK');
    expect(m.pe.portfolio).toBeNull();
    expect(m.pe.coverage).toMatchObject({ includedStocks: 0, totalStocks: 1, portfolioSharePct: 0 });
    expect(m.pe.excluded).toEqual([expect.objectContaining({ symbol: 'AAA', reason: 'missing' })]);
  });

  it('explains a benchmark without prices and keeps the portfolio figures', () => {
    const m = computeMetrics(data(), 'ZZZ');
    expect(m.benchmark.available).toBe(false);
    expect(m.benchmark.message).toMatch(/No end-of-day prices are tracked for ZZZ/);
    expect(m.twr).toMatchObject({ benchmark: null, difference: null, benchmarkFrom: null });
    expect(m.twr.portfolio).not.toBeNull();
    expect(m.volatility).toMatchObject({ benchmark: null, beta: null, verdict: null, benchmarkObservations: 0 });
    expect(m.volatility.portfolio).not.toBeNull();
    expect(m.sharpe.benchmark).toBeNull();
    expect(m.sortino.benchmark).toBeNull();
  });

  it('treats a benchmark with a single close as unavailable', () => {
    const m = computeMetrics(data({ eod: { AAA: aaa, ONE: [close('ONE', '2026-01-02', 100)] } }), 'ONE');
    expect(m.benchmark.available).toBe(false);
    expect(m.twr.benchmark).toBeNull();
  });

  it('measures like with like when the benchmark history starts after the first purchase', () => {
    const late = wavy('LATE', '2025-07-01', 190, 2, 0.12);
    const d = data({ eod: { AAA: aaa, LATE: late } });
    const m = computeMetrics(d, 'LATE');
    const comparison = computeBenchmark(d, 'LATE', 'ALL').comparison!;
    expect(m.twr.benchmarkFrom).toBe(late[0]!.date);
    expect(m.twr.from).toBe('2025-01-02');
    expect(m.twr.benchmark).toBe(comparison.benchmarkReturnPct);
    expect(m.twr.difference).toBe(comparison.differencePct);
    expect(m.twr.portfolio).toBe(computeAnalyticsSummary(d).performance.twrPct);
  });

  it('shows figures with a short history and withholds them below 20 weekday returns', () => {
    const short = computeMetrics(data({ today: '2025-03-14' }), 'BMK');
    expect(short.volatility.observations).toBeGreaterThanOrEqual(20);
    expect(short.volatility.observations).toBeLessThan(60);
    expect(short.sharpe.portfolio).not.toBeNull();
    const tiny = computeMetrics(data({ today: '2025-01-20' }), 'BMK');
    expect(tiny.volatility.observations).toBe(12);
    expect(tiny).toMatchObject({
      volatility: { portfolio: null, benchmark: null, beta: null, verdict: null },
      sharpe: { portfolio: null, verdict: null },
      sortino: { portfolio: null, verdict: null },
    });
    expect(tiny.twr.portfolio).not.toBeNull();
  });

  it('is empty without transactions but still answers', () => {
    const m = computeMetrics(data({ transactions: [] }), 'BMK');
    expect(m.benchmark).toMatchObject({ symbol: 'BMK', available: false });
    expect(m.benchmark.message).toMatch(/Add transactions/);
    expect(m.twr).toEqual({ portfolio: null, benchmark: null, difference: null, from: null, to: '2026-01-02', days: 0, benchmarkFrom: null });
    expect(m.pe.portfolio).toBeNull();
    expect(m.pe.coverage.totalStocks).toBe(0);
    expect(m.volatility).toMatchObject({ observations: 0, portfolio: null, beta: null });
  });

  it('has no TWR on the very first day and ignores cash movements as flows', () => {
    const first = computeMetrics(data({ today: '2025-01-02' }), 'BMK');
    expect(first.twr).toMatchObject({ portfolio: null, from: '2025-01-02', days: 0 });
    expect(first.benchmark.available).toBe(false);
    const deposit = buy({ id: 'dep', date: '2024-12-30', type: 'DEPOSIT', symbol: 'CASH.EUR', quantity: 1, price: 5000 });
    const withDeposit = computeMetrics(data({ transactions: [deposit, buy()] }), 'BMK');
    expect(withDeposit.twr.from).toBe('2025-01-02');
    expect(withDeposit.twr.portfolio).toBe(computeMetrics(data(), 'BMK').twr.portfolio);
  });

  it('defaults to IWDA.AS and the standard risk-free rate', () => {
    const m = computeMetrics(data({ eod: { AAA: aaa, 'IWDA.AS': bmk } }));
    expect(m.benchmark).toEqual({ symbol: 'IWDA.AS', available: true });
    expect(m.riskFreeRatePct).toBe(2.5);
  });
});
