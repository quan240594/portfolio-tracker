import { FxTimeline } from './fx.js';
import { describe, expect, it } from 'vitest';
import {
  computeAnalyticsSummary,
  computeBenchmark,
  computeDividendGrowth,
  computeGoal,
  computeReturns,
  computeRisk,
  MAX_ANALYTICS_POINTS,
  type AnalyticsData,
} from './analytics-compute.js';
import { analyticsGoalQuerySchema } from './analytics-api.js';
import { addIsoDays, dailyFlows, isInvestmentFlow, transactionCashFlows } from './analytics.js';
import type { EodPrice, FxRates, Transaction } from './types.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-01-02T00:00:00Z' };
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2025-01-02',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 10,
  price: 100,
  fee: 0,
  currency: 'EUR',
  createdAt: `2025-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
const close = (symbol: string, date: string, value: number, currency = 'EUR'): EodPrice => ({ symbol, date, close: value, currency });
const profiles = { AAA: { symbol: 'AAA', name: 'Alpha Inc', assetClass: 'STOCK' as const, sector: 'Technology', country: 'United States', currency: 'EUR' } };
const quote = (price: number, previousClose = price) => ({ AAA: { symbol: 'AAA', price, previousClose, currency: 'EUR', asOf: '2026-01-02', source: 't' } });

/** Steps: 100 → 110 on 2025-07-01 → 121 on 2026-01-02 (10 % twice). */
const stepEod = [close('AAA', '2025-01-02', 100), close('AAA', '2025-07-01', 110), close('AAA', '2026-01-02', 121)];

const base = (over: Partial<AnalyticsData> = {}): AnalyticsData => ({
  transactions: [tx({})],
  quotes: quote(121, 120),
  profiles,
  fx,
  eod: { AAA: stepEod },
  dividendEvents: [],
  today: '2026-01-02',
  ...over,
});

/** Weekday closes on a gently rising, wiggly path, starting `start`, `n` days long. */
function wavy(symbol: string, start: string, n: number, amplitude = 3, currency = 'EUR'): EodPrice[] {
  const out: EodPrice[] = [];
  for (let k = 0; k < n; k++) {
    const date = addIsoDays(start, k);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) continue;
    out.push(close(symbol, date, 100 + 0.2 * k + amplitude * Math.sin(k / 2), currency));
  }
  return out;
}

describe('computeAnalyticsSummary', () => {
  it('reports IRR and TWR equal to the analytic 21 % for a single buy', () => {
    const s = computeAnalyticsSummary(base());
    expect(s.baseCurrency).toBe('EUR');
    expect(s.performance).toEqual({ since: '2025-01-02', days: 365, irrPct: 21, irrAnnualised: true, twrPct: 21, twrAnnualisedPct: 21 });
    expect(s.gainers).toEqual([{ symbol: 'AAA', name: 'Alpha Inc', dayChangePct: 0.83, dayChange: 10 }]);
    expect(s.losers).toEqual([]);
    expect(s.passiveIncome.forward12m).toBe(0);
    expect(s.insights.map((i) => i.id)).toEqual(['concentration-top-holding', 'sector-imbalance', 'country-concentration']);
  });

  it('does not annualise within the first year', () => {
    const s = computeAnalyticsSummary(base({ today: '2025-07-01', transactions: [tx({})], quotes: quote(110) }));
    expect(s.performance).toMatchObject({ days: 180, irrAnnualised: false, twrPct: 10, twrAnnualisedPct: null });
    expect(s.performance.irrPct).toBeCloseTo(10, 1);
  });

  it('is empty without transactions and ignores future-dated ones', () => {
    const empty = computeAnalyticsSummary(base({ transactions: [] }));
    expect(empty.performance).toEqual({ since: null, days: 0, irrPct: null, irrAnnualised: false, twrPct: null, twrAnnualisedPct: null });
    expect(empty.insights).toEqual([]);
    const future = computeAnalyticsSummary(base({ transactions: [tx({ date: '2026-06-01' })] }));
    expect(future.performance.since).toBeNull();
  });

  it('has no TWR on the very first day', () => {
    const s = computeAnalyticsSummary(base({ today: '2025-01-02', quotes: quote(100) }));
    expect(s.performance).toMatchObject({ since: '2025-01-02', days: 0, twrPct: null, twrAnnualisedPct: null });
  });

  it('reports a total loss as -100 % IRR', () => {
    const s = computeAnalyticsSummary(base({ quotes: quote(0), eod: { AAA: [close('AAA', '2025-01-02', 100), close('AAA', '2025-06-01', 0)] } }));
    expect(s.performance.irrPct).toBe(-100);
  });
});

describe('computeReturns', () => {
  it('builds yearly TWR bars with period IRR and gains', () => {
    const r = computeReturns(base(), 'year');
    expect(r).toMatchObject({ period: 'year', baseCurrency: 'EUR' });
    expect(r.rows).toEqual([
      { period: '2025', start: '2025-01-02', end: '2025-12-31', twrPct: 10, irrPct: 10, startValue: 1000, endValue: 1100, contributions: 0, income: 0, gain: 100 },
      { period: '2026', start: '2025-12-31', end: '2026-01-02', twrPct: 10, irrPct: 10, startValue: 1100, endValue: 1210, contributions: 0, income: 0, gain: 110 },
    ]);
  });

  it('adjusts for contributions and counts dividends as return', () => {
    const data = base({
      transactions: [tx({}), tx({ date: '2025-07-01', price: 110 }), tx({ date: '2025-10-01', type: 'DIVIDEND', quantity: 20, price: 0.25 })],
      quotes: quote(121),
    });
    const [y2025, y2026] = computeReturns(data, 'year').rows;
    // 2025-07-01: (2200 − 1100) / 1000 → +10 %; 2025-10-01: +5 / 2200
    expect(y2025!.twrPct).toBeCloseTo((1.1 * (1 + 5 / 2200) - 1) * 100, 1);
    expect(y2025).toMatchObject({ startValue: 1000, endValue: 2200, contributions: 1100, income: 5, gain: 105 });
    expect(y2026).toMatchObject({ startValue: 2200, endValue: 2420, contributions: 0, income: 0, gain: 220 });
  });

  it('groups by quarter and month without an IRR', () => {
    const quarters = computeReturns(base(), 'quarter').rows;
    expect(quarters.map((q) => q.period)).toEqual(['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1']);
    expect(quarters.find((q) => q.period === '2025-Q3')).toMatchObject({ twrPct: 10, irrPct: null });
    const months = computeReturns(base(), 'month').rows;
    expect(months).toHaveLength(13);
    expect(months.find((m) => m.period === '2025-07')).toMatchObject({ twrPct: 10, gain: 100 });
    expect(months.every((m) => m.irrPct === null)).toBe(true);
  });

  it('has no rows without transactions and keeps a fully sold position at zero value', () => {
    expect(computeReturns(base({ transactions: [] }), 'year').rows).toEqual([]);
    const sold = base({ transactions: [tx({}), tx({ date: '2025-03-03', type: 'SELL', price: 100 })], quotes: {}, eod: { AAA: stepEod } });
    const rows = computeReturns(sold, 'year').rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endValue: 0, gain: 0 });
  });
});

describe('computeRisk', () => {
  const eod = { AAA: wavy('AAA', '2025-01-02', 200), BMK: wavy('BMK', '2025-01-02', 200, 1) };
  const data = (over: Partial<AnalyticsData> = {}) => base({ today: '2025-07-20', eod, quotes: quote(130), ...over });

  it('computes volatility, ratios, drawdown and beta', () => {
    const r = computeRisk(data(), 'BMK');
    expect(r.observations).toBeGreaterThan(100);
    expect(r.volatilityPct).toBeGreaterThan(0);
    expect(r.sharpe).not.toBeNull();
    expect(r.sortino).not.toBeNull();
    expect(r.maxDrawdown!.depthPct).toBeLessThan(0);
    expect(r.maxDrawdown!.peakDate! < r.maxDrawdown!.troughDate!).toBe(true);
    expect(r.riskFreeRatePct).toBe(2.5);
    expect(r.benchmark).toMatchObject({ symbol: 'BMK', available: true });
    expect(r.benchmark.beta).not.toBeNull();
    expect(r.from).toBe('2025-01-03');
    expect(r.to).toBe('2025-07-20');
  });

  it('has a beta of 1 against the same instrument', () => {
    const r = computeRisk(data(), 'AAA');
    expect(r.benchmark).toMatchObject({ beta: 1, correlation: 1 });
  });

  it('converts a foreign-currency benchmark', () => {
    const usd = wavy('USDX', '2025-01-02', 200, 3).map((p) => ({ ...p, close: p.close * 1.25, currency: 'USD' }));
    const r = computeRisk(data({ eod: { ...eod, USDX: usd } }), 'USDX');
    expect(r.benchmark.beta).toBe(1);
  });

  it('explains a missing benchmark and a too-short overlap', () => {
    const missing = computeRisk(data(), 'ZZZ');
    expect(missing.benchmark).toMatchObject({ symbol: 'ZZZ', available: false, beta: null, correlation: null });
    expect(missing.benchmark.message).toContain('ZZZ');
    const short = computeRisk(data({ eod: { ...eod, SHORT: [close('SHORT', '2025-07-10', 100), close('SHORT', '2025-07-15', 101)] } }), 'SHORT');
    expect(short.benchmark).toMatchObject({ available: true, beta: null, message: 'Not enough overlapping history to estimate beta.' });
    expect(short.volatilityPct).not.toBeNull();
  });

  it('reports a constant benchmark as beta-less', () => {
    const flat = Array.from({ length: 150 }, (_, k) => close('FLAT', addIsoDays('2025-01-02', k), 50));
    const r = computeRisk(data({ eod: { ...eod, FLAT: flat } }), 'FLAT');
    expect(r.benchmark).toMatchObject({ available: true, beta: null, correlation: null });
  });

  it('nulls the metrics below 20 observations and defaults the benchmark', () => {
    const r = computeRisk(base({ today: '2025-01-20', eod, quotes: quote(100) }));
    expect(r.observations).toBeLessThan(20);
    expect(r).toMatchObject({ volatilityPct: null, sharpe: null, sortino: null });
    expect(r.benchmark.symbol).toBe('IWDA.AS');
    expect(r.maxDrawdown).not.toBeNull();
  });

  it('is empty without transactions or before any return exists', () => {
    for (const d of [base({ transactions: [] }), base({ today: '2025-01-02' })]) {
      const r = computeRisk(d);
      expect(r).toMatchObject({ observations: 0, from: null, to: null, volatilityPct: null, maxDrawdown: null });
      expect(r.benchmark.available).toBe(false);
    }
  });

  it('accepts a custom risk-free rate', () => {
    const low = computeRisk(data(), 'BMK', 0);
    const high = computeRisk(data(), 'BMK', 0.1);
    expect(high.riskFreeRatePct).toBe(10);
    expect(high.sharpe!).toBeLessThan(low.sharpe!);
  });
});

describe('computeBenchmark', () => {
  const eod = { AAA: wavy('AAA', '2025-01-02', 400), BMK: wavy('BMK', '2025-01-02', 400, 1) };
  const data = (over: Partial<AnalyticsData> = {}) => base({ today: '2026-01-20', eod, quotes: quote(150), ...over });

  it('replays the same instrument exactly: identical path, zero difference', () => {
    const at = (date: string) => eod.AAA.find((p) => p.date === date)!.close;
    const trades = [
      tx({}),
      tx({ date: '2025-06-02', quantity: 5, price: at('2025-06-02') }),
      tx({ date: '2025-09-01', type: 'SELL', quantity: 3, price: at('2025-09-01') }),
    ];
    const r = computeBenchmark(data({ transactions: trades }), 'AAA', 'ALL');
    expect(r.benchmark).toEqual({ symbol: 'AAA', available: true });
    expect(r.points.length).toBeGreaterThan(300);
    for (const p of r.points) expect(p.benchmark).toBeCloseTo(p.portfolio, 1);
    expect(r.comparison).toMatchObject({ from: '2025-01-02', to: '2026-01-20', differencePct: 0 });
    expect(r.comparison!.portfolioGain).toBeCloseTo(r.comparison!.benchmarkGain, 1);
    expect(r.points[0]).toMatchObject({ date: '2025-01-02', invested: 1000 });
    const expectedInvested = 1000 + 5 * at('2025-06-02') - 3 * at('2025-09-01');
    expect(r.points.at(-1)!.invested).toBeCloseTo(expectedInvested, 1);
  });

  it('keeps dividends as cash in the portfolio line', () => {
    const r = computeBenchmark(data({ transactions: [tx({}), tx({ date: '2025-06-02', type: 'DIVIDEND', quantity: 10, price: 2 })] }), 'AAA', 'ALL');
    const last = r.points.at(-1)!;
    expect(last.portfolio - last.benchmark!).toBeCloseTo(20, 1);
    expect(r.comparison!.differencePct).toBeGreaterThan(0);
    expect(r.comparison!.portfolioGain - r.comparison!.benchmarkGain).toBeCloseTo(20, 1);
  });

  it('compares against a different index with the same cash flows', () => {
    const r = computeBenchmark(data(), 'BMK', '1Y');
    expect(r.range).toBe('1Y');
    expect(r.comparison!.from >= '2025-01-20').toBe(true);
    expect(r.comparison!.benchmarkReturnPct).not.toBe(r.comparison!.portfolioReturnPct);
    expect(r.comparison!.differencePct).toBeCloseTo(r.comparison!.portfolioReturnPct - r.comparison!.benchmarkReturnPct, 1);
  });

  it('starts when the benchmark data starts and converts its currency', () => {
    const late = wavy('LATE', '2025-04-01', 300).map((p) => ({ ...p, close: p.close * 1.25, currency: 'USD' }));
    const r = computeBenchmark(data({ eod: { ...eod, LATE: late } }), 'LATE', 'ALL');
    expect(r.points[0]!.date).toBe(late[0]!.date);
    expect(r.points[0]!.benchmark).toBeCloseTo(r.points[0]!.portfolio, 1);
    expect(r.comparison!.from).toBe(late[0]!.date);
  });

  it('downsamples long series', () => {
    const long = wavy('AAA', '2020-01-01', 2200);
    const r = computeBenchmark(
      base({ today: '2026-01-20', transactions: [tx({ date: '2020-01-01' })], eod: { AAA: long }, quotes: quote(150) }),
      'AAA',
      'ALL',
    );
    expect(r.points).toHaveLength(MAX_ANALYTICS_POINTS);
  });

  it('says so when the benchmark has no data, still returning the portfolio path', () => {
    const r = computeBenchmark(data(), 'NOPE', '3M');
    expect(r.benchmark.available).toBe(false);
    expect(r.benchmark.message).toContain('NOPE');
    expect(r.comparison).toBeNull();
    expect(r.points.length).toBeGreaterThan(50);
    expect(r.points.every((p) => p.benchmark === null)).toBe(true);
    // benchmark data entirely after today is just as unusable
    const future = computeBenchmark(data({ eod: { ...eod, LATER: [close('LATER', '2030-01-01', 10)] } }), 'LATER', '3M');
    expect(future.benchmark.available).toBe(false);
  });

  it('returns a single point without a comparison for a one-day window', () => {
    const r = computeBenchmark(base({ today: '2025-01-02', eod, quotes: quote(100) }), 'BMK', 'ALL');
    expect(r.points).toHaveLength(1);
    expect(r.comparison).toBeNull();
  });

  it('is empty without transactions and defaults the benchmark and range', () => {
    const r = computeBenchmark(base({ transactions: [] }));
    expect(r).toMatchObject({ range: '1Y', points: [], comparison: null, benchmark: { symbol: 'IWDA.AS', available: false } });
  });
});

describe('computeDividendGrowth', () => {
  it('delegates to the dividend growth calculation', () => {
    const g = computeDividendGrowth(base({ transactions: [tx({}), tx({ type: 'DIVIDEND', date: '2025-05-01', price: 1 })] }));
    expect(g.byYear).toEqual([{ year: '2025', total: 10, payments: 1, yoyPct: null, partial: false }]);
  });
});

describe('computeGoal', () => {
  const query = analyticsGoalQuerySchema.parse({ targetIncome: '1000', dividendGrowthPct: '0', yieldOnNewMoneyPct: '5', monthlyContribution: '1000', reinvestDividends: 'false', years: '2' });

  it('starts from the forward income and echoes the inputs', () => {
    const data = base({ transactions: [tx({}), tx({ type: 'DIVIDEND', date: '2025-12-01', price: 10 })] });
    const g = computeGoal(data, query);
    expect(g.baseCurrency).toBe('EUR');
    expect(g.inputs).toMatchObject({ targetIncome: 1000, currentValue: 1210, currentIncome: 100, currentYieldPct: 8.26, monthlyContribution: 1000, years: 2, reinvestDividends: false });
    const base3 = g.scenarios.find((s) => s.id === 'base')!;
    expect(base3.points[0]).toEqual({ year: 0, income: 100, contributed: 0 });
    // 100 + 12 × 1000 × 5 % = 700 after one year; 1300 after two
    expect(base3.points.map((p) => p.income)).toEqual([100, 700, 1300]);
    expect(base3.yearsToGoal).toBe(1.5);
  });

  it('lets the caller override the starting yield', () => {
    const g = computeGoal(base(), { ...query, currentYieldPct: 4 });
    expect(g.inputs).toMatchObject({ currentIncome: 48.4, currentYieldPct: 4 });
  });
});

describe('cash movements and splits are not investment flows', () => {
  const cash = [
    tx({ type: 'DEPOSIT', symbol: 'CASH.EUR', date: '2024-12-01', quantity: 50_000, price: 1 }),
    tx({ type: 'WITHDRAWAL', symbol: 'CASH.EUR', date: '2025-06-01', quantity: 1_000, price: 1 }),
    tx({ type: 'FEE', symbol: 'CASH.EUR', date: '2025-06-02', quantity: 1, price: 5 }),
    tx({ type: 'INTEREST', symbol: 'CASH.EUR', date: '2025-06-03', quantity: 1, price: 7 }),
  ];

  it('classifies only trades and dividends as investment flows', () => {
    expect(['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'INTEREST', 'SPLIT'].filter((type) => isInvestmentFlow({ type: type as Transaction['type'] }))).toEqual(['BUY', 'SELL', 'DIVIDEND']);
  });

  it('keeps them out of the IRR and TWR flows', () => {
    const timeline = new FxTimeline(fx);
    const txns = [...cash, tx({}), tx({ type: 'SPLIT', date: '2025-03-01', quantity: 2, price: 0 })];
    expect(transactionCashFlows(txns, timeline)).toEqual(transactionCashFlows([tx({})], timeline));
    expect([...dailyFlows(txns, timeline).keys()]).toEqual(['2025-01-02']);
  });

  it('does not change the returns, and "since" is the first investment, not an earlier deposit', () => {
    const plain = computeAnalyticsSummary(base()).performance;
    const withCash = computeAnalyticsSummary(base({ transactions: [...cash, tx({})] })).performance;
    expect(withCash).toEqual(plain);
    expect(withCash).toMatchObject({ since: '2025-01-02', irrPct: 21, twrPct: 21 });
  });

  it('reports no performance for a portfolio that only holds cash', () => {
    expect(computeAnalyticsSummary(base({ transactions: cash })).performance).toMatchObject({ since: null, irrPct: null, twrPct: null });
  });
});
