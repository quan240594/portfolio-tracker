import { describe, expect, it } from 'vitest';
import type { AnalyticsData } from './analytics-compute.js';
import { addIsoDays } from './analytics.js';
import {
  BENCHMARK_SUGGESTIONS,
  GROWTH_RANGES,
  growthQuerySchema,
  holdingsPerformanceQuerySchema,
  parseBenchmarkList,
  type GrowthBenchmarkOption,
} from './growth-api.js';
import {
  buildBenchmarkOptions,
  computeGrowth,
  computeHoldingsPerformance,
  cumulativeReturnPct,
  growthHeadline,
  growthRangeStart,
  holdingReturn,
  periodReturnsPct,
  rebasedReturnPct,
} from './growth.js';
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

const TODAY = '2026-01-02';
/** Daily closes growing 0.1 % per day from `start`, `rate` per day. */
function path(symbol: string, start: string, base = 100, rate = 0.001, until = TODAY): EodPrice[] {
  const out: EodPrice[] = [];
  for (let date = start, k = 0; date <= until; date = addIsoDays(date, 1), k++) {
    out.push({ symbol, date, close: base * (1 + rate) ** k, currency: 'EUR' });
  }
  return out;
}
const profiles = {
  AAA: { symbol: 'AAA', name: 'Alpha Inc', assetClass: 'STOCK' as const, sector: 'Technology', country: 'United States', currency: 'EUR' },
  BBB: { symbol: 'BBB', name: 'Beta Corp', assetClass: 'STOCK' as const, sector: 'Industrials', country: 'Germany', currency: 'EUR' },
};
const quote = (symbol: string, price: number) => ({ symbol, price, previousClose: price, currency: 'EUR', asOf: TODAY, source: 't' });

const data = (over: Partial<AnalyticsData> = {}): AnalyticsData => ({
  transactions: [tx({})],
  quotes: { AAA: quote('AAA', 100 * 1.001 ** 365) },
  profiles,
  fx,
  eod: { AAA: path('AAA', '2025-01-02'), IDX: path('IDX', '2024-12-01', 50) },
  dividendEvents: [],
  today: TODAY,
  ...over,
});

const options: GrowthBenchmarkOption[] = [{ symbol: 'IDX', hasData: true }];

describe('growthRangeStart', () => {
  it('maps every range, never before the first investment', () => {
    expect(growthRangeStart('7D', '2026-01-10', '2020-01-01')).toBe('2026-01-03');
    expect(growthRangeStart('1M', '2026-01-31', '2020-01-01')).toBe('2026-01-01');
    expect(growthRangeStart('3M', '2026-04-02', '2020-01-01')).toBe('2026-01-01');
    expect(growthRangeStart('6M', '2026-07-02', '2020-01-01')).toBe('2026-01-01');
    expect(growthRangeStart('YTD', '2026-07-02', '2020-01-01')).toBe('2026-01-01');
    expect(growthRangeStart('1Y', '2026-01-02', '2020-01-01')).toBe('2025-01-02');
    expect(growthRangeStart('5Y', '2026-01-02', '2010-01-01')).toBe('2021-01-02');
    expect(growthRangeStart('ALL', '2026-01-02', '2023-05-05')).toBe('2023-05-05');
    expect(growthRangeStart('1Y', '2026-01-02', '2025-06-01')).toBe('2025-06-01');
    expect(GROWTH_RANGES).toHaveLength(8);
  });
});

describe('series helpers', () => {
  it('chains daily returns after the base date into a cumulative percentage', () => {
    const returns = [
      { date: '2025-01-01', r: 0.5 },
      { date: '2025-01-02', r: 0.1 },
      { date: '2025-01-03', r: -0.1 },
    ];
    expect(cumulativeReturnPct(returns, ['2025-01-01', '2025-01-02', '2025-01-03'])).toEqual([0, 10, -1]);
    expect(cumulativeReturnPct(returns, [])).toEqual([]);
    expect(cumulativeReturnPct([], ['2025-01-01', '2025-01-02'])).toEqual([0, 0]);
  });

  it('rebases a series to 0 % at the first value and keeps gaps', () => {
    expect(rebasedReturnPct([null, 100, 110, 90])).toEqual([null, 0, 10, -10]);
    expect(rebasedReturnPct([null, null])).toEqual([null, null]);
    expect(rebasedReturnPct([0, 5])).toEqual([null, null]);
    expect(rebasedReturnPct([])).toEqual([]);
  });

  it('compounds returns per month or quarter', () => {
    const r = [
      { date: '2025-01-30', r: 0.1 },
      { date: '2025-01-31', r: 0.1 },
      { date: '2025-02-01', r: -0.5 },
      { date: '2025-04-01', r: 0.2 },
    ];
    expect([...periodReturnsPct(r)]).toEqual([
      ['2025-01', 21],
      ['2025-02', -50],
      ['2025-04', 20],
    ]);
    expect([...periodReturnsPct(r, 'quarter')]).toEqual([
      ['2025-Q1', -39.5],
      ['2025-Q2', 20],
    ]);
  });

  it('turns a comparison into headline numbers', () => {
    expect(growthHeadline('IDX', null)).toBeNull();
    expect(
      growthHeadline('IDX', { from: '2025-01-02', to: '2025-06-01', portfolioReturnPct: 12, benchmarkReturnPct: 8, differencePct: 4, portfolioGain: 1200.5, benchmarkGain: 800.25 }),
    ).toEqual({ symbol: 'IDX', from: '2025-01-02', to: '2025-06-01', amount: 400.25, differencePct: 4, portfolioReturnPct: 12, benchmarkReturnPct: 8 });
    expect(
      growthHeadline('IDX', { from: 'a', to: 'b', portfolioReturnPct: 1, benchmarkReturnPct: 3, differencePct: -2, portfolioGain: 10, benchmarkGain: 30 })?.amount,
    ).toBe(-20);
  });

  it('merges tracked symbols and suggestions: data first, names kept, no duplicates', () => {
    const merged = buildBenchmarkOptions([
      { symbol: 'ZZZ', hasData: true },
      { symbol: 'IWDA.AS', hasData: true },
      { symbol: 'AAA', name: 'Alpha', hasData: true },
      { symbol: 'WATCH', name: 'Watched', hasData: false },
    ]);
    expect(merged.map((o) => o.symbol)).toEqual(['AAA', 'IWDA.AS', 'ZZZ', 'EXSA.DE', 'SXR8.DE', 'VWCE.DE', 'VWRL.AS', 'WATCH']);
    expect(merged.find((o) => o.symbol === 'IWDA.AS')).toEqual({ symbol: 'IWDA.AS', name: 'iShares Core MSCI World', hasData: true });
    expect(merged.find((o) => o.symbol === 'ZZZ')).toEqual({ symbol: 'ZZZ', hasData: true });
    expect(merged.find((o) => o.symbol === 'AAA')?.name).toBe('Alpha');
    expect(merged.find((o) => o.symbol === 'VWRL.AS')).toMatchObject({ hasData: false, name: 'Vanguard FTSE All-World' });
    expect(buildBenchmarkOptions([], [])).toEqual([]);
    expect(buildBenchmarkOptions([]).map((o) => o.symbol)).toEqual(BENCHMARK_SUGGESTIONS.map((s) => s.symbol).sort((a, b) => a.localeCompare(b)));
  });
});

describe('holdingReturn', () => {
  const points = (values: number[]) => values.map((value, i) => ({ date: addIsoDays('2025-01-01', i), value, invested: value }));

  it('chains the daily returns and reports the money made', () => {
    const r = holdingReturn(points([100, 110, 121]), new Map());
    expect(r).toEqual({ startValue: 100, endValue: 121, contributions: 0, income: 0, gain: 21, returnPct: 21 });
  });

  it('removes purchases after the first day and counts dividends as return', () => {
    // day 2: +100 bought, value 210 → (210 − 100) / 100 = +10 %; day 3: +5 dividend, flat → (210 + 5) / 210 − 1
    const flows = new Map([
      ['2025-01-02', { contributions: 100, income: 0 }],
      ['2025-01-03', { contributions: 0, income: 5 }],
      ['2025-01-01', { contributions: 100, income: 0 }],
      ['2025-02-01', { contributions: 50, income: 0 }],
    ]);
    const r = holdingReturn(points([100, 210, 210]), flows)!;
    expect(r.contributions).toBe(100);
    expect(r.income).toBe(5);
    expect(r.gain).toBe(15);
    expect(r.returnPct).toBeCloseTo((1.1 * (215 / 210) - 1) * 100, 1);
  });

  it('is null without a day of return', () => {
    expect(holdingReturn([], new Map())).toBeNull();
    expect(holdingReturn(points([100]), new Map())).toBeNull();
    expect(holdingReturn(points([0, 10]), new Map())).toBeNull();
  });
});

describe('computeGrowth', () => {
  it('matches the benchmark when it has the same price path and the same cash flows', () => {
    const d = data({ eod: { AAA: path('AAA', '2025-01-02'), IDX: path('IDX', '2024-12-01', 80) } });
    const g = computeGrowth(d, 'ALL', ['IDX'], options);
    const expected = (1.001 ** 365 - 1) * 100;
    expect(g.period).toMatchObject({ from: '2025-01-02', to: TODAY, startValue: 1000, invested: 1000 });
    expect(g.period!.returnPct).toBeCloseTo(expected, 1);
    expect(g.benchmarks[0]!.points.at(-1)!.returnPct).toBeCloseTo(g.period!.returnPct, 1);
    expect(g.benchmarks[0]!.points.at(-1)!.value).toBeCloseTo(g.series.at(-1)!.value, 0);
    expect(g.series[0]).toEqual({ date: '2025-01-02', value: 1000, invested: 1000, returnPct: 0 });
    expect(g.headline!.symbol).toBe('IDX');
    expect(Math.abs(g.headline!.amount)).toBeLessThan(1);
    expect(Math.abs(g.headline!.differencePct)).toBeLessThan(0.1);
    expect(g.options).toBe(options);
    expect(g.baseCurrency).toBe('EUR');
  });

  it('shows who is ahead: a weaker benchmark and a stronger one', () => {
    const d = data({ eod: { AAA: path('AAA', '2025-01-02'), WEAK: path('WEAK', '2025-01-02', 100, 0.0005), STRONG: path('STRONG', '2025-01-02', 100, 0.002) } });
    const [weak, strong] = computeGrowth(d, 'ALL', ['WEAK', 'STRONG'], options).benchmarks;
    expect(weak!.comparison!.differencePct).toBeGreaterThan(0);
    expect(strong!.comparison!.differencePct).toBeLessThan(0);
    const g = computeGrowth(d, 'ALL', ['STRONG', 'WEAK'], options);
    expect(g.headline!.symbol).toBe('STRONG');
    expect(g.headline!.amount).toBeLessThan(0);
    expect(g.benchmarks.map((b) => b.symbol)).toEqual(['STRONG', 'WEAK']);
  });

  it('rebases the return and the benchmark at the start of a shorter range and tracks net contributions', () => {
    const d = data({ transactions: [tx({}), tx({ date: '2025-10-01', quantity: 5, price: 100 * 1.001 ** 272 })] });
    const g = computeGrowth(d, '3M', ['IDX'], options);
    expect(g.period!.from).toBe(growthRangeStart('3M', TODAY, '2025-01-02'));
    expect(g.series[0]!.returnPct).toBe(0);
    expect(g.benchmarks[0]!.points[0]).toEqual({ value: expect.any(Number), returnPct: 0 });
    // The purchase on 2025-10-01 is before the range: the invested line is flat at the start value.
    expect(g.series.every((p) => p.invested === g.series[0]!.invested)).toBe(true);
    const all = computeGrowth(d, 'ALL', ['IDX'], options);
    expect(all.series.find((p) => p.date === '2025-10-01')!.invested).toBeCloseTo(1000 + 5 * 100 * 1.001 ** 272, 0);
    expect(all.series.find((p) => p.date === '2025-09-30')!.invested).toBe(1000);
  });

  it('includes dividends received in the value and the return', () => {
    const d = data({ transactions: [tx({}), tx({ date: '2025-06-01', type: 'DIVIDEND', quantity: 10, price: 2 })] });
    const g = computeGrowth(d, 'ALL', [], options);
    const noDiv = computeGrowth(data(), 'ALL', [], options);
    expect(g.series.at(-1)!.value - noDiv.series.at(-1)!.value).toBeCloseTo(20, 1);
    expect(g.period!.returnPct).toBeGreaterThan(noDiv.period!.returnPct);
    expect(g.period!.gain).toBeCloseTo(noDiv.period!.gain + 20, 1);
  });

  it('reports a benchmark without prices instead of failing, and still returns the portfolio series', () => {
    const g = computeGrowth(data(), 'ALL', ['NOPE', 'IDX'], options);
    const [nope, idx] = g.benchmarks;
    expect(nope).toMatchObject({ symbol: 'NOPE', available: false, comparison: null });
    expect(nope!.message).toContain('NOPE');
    expect(nope!.points).toHaveLength(g.series.length);
    expect(nope!.points.every((p) => p.value === null && p.returnPct === null)).toBe(true);
    expect(idx!.available).toBe(true);
    expect(g.headline!.symbol).toBe('IDX');
    expect(g.monthly[0]!.benchmarks).toHaveProperty('NOPE', null);
    expect(computeGrowth(data(), 'ALL', ['NOPE'], options).headline).toBeNull();
  });

  it('works without any benchmark', () => {
    const g = computeGrowth(data(), '1Y', [], options);
    expect(g.benchmarks).toEqual([]);
    expect(g.headline).toBeNull();
    expect(g.series.length).toBeGreaterThan(300);
  });

  it('builds monthly returns for the portfolio and each benchmark', () => {
    const g = computeGrowth(data(), 'ALL', ['IDX'], options);
    expect(g.monthly[0]!.month).toBe('2025-01');
    expect(g.monthly.at(-1)!.month).toBe('2026-01');
    const feb = g.monthly.find((m) => m.month === '2025-02')!;
    expect(feb.portfolioPct).toBeCloseTo((1.001 ** 28 - 1) * 100, 1);
    expect(feb.benchmarks.IDX).toBeCloseTo(feb.portfolioPct, 1);
    // monthly returns are independent of the requested range
    expect(computeGrowth(data(), '7D', ['IDX'], options).monthly).toEqual(g.monthly);
  });

  it('downsamples long series, keeping first and last and the benchmark alignment', () => {
    const d = data({ transactions: [tx({ date: '2024-06-01' })], eod: { AAA: path('AAA', '2024-06-01'), IDX: path('IDX', '2024-05-01') } });
    const g = computeGrowth(d, 'ALL', ['IDX'], options);
    expect(g.series).toHaveLength(400);
    expect(g.series[0]!.date).toBe('2024-06-01');
    expect(g.series.at(-1)!.date).toBe(TODAY);
    expect(g.benchmarks[0]!.points).toHaveLength(400);
    expect(g.benchmarks[0]!.points[0]!.returnPct).toBe(0);
  });

  it('is empty without transactions and ignores future-dated ones', () => {
    const empty = computeGrowth(data({ transactions: [] }), '1Y', ['IDX'], options);
    expect(empty).toMatchObject({ period: null, series: [], headline: null, monthly: [], options });
    expect(empty.benchmarks).toEqual([{ symbol: 'IDX', available: false, message: expect.stringContaining('Add transactions'), points: [], comparison: null }]);
    expect(computeGrowth(data({ transactions: [tx({ date: '2026-06-01' })] }), '1Y', [], options).period).toBeNull();
  });

  it('measures only investments: cash movements and splits are not flows', () => {
    const d = data({ transactions: [tx({ date: '2024-12-01', type: 'DEPOSIT', symbol: 'CASH.EUR', price: 1, quantity: 5000 }), tx({})] });
    expect(computeGrowth(d, 'ALL', [], options).period!.from).toBe('2025-01-02');
  });
});

describe('computeHoldingsPerformance', () => {
  const two = () =>
    data({
      transactions: [tx({}), tx({ symbol: 'BBB', date: '2025-10-01', quantity: 4, price: 50 })],
      quotes: { AAA: quote('AAA', 100 * 1.001 ** 365), BBB: quote('BBB', 50 * 1.01 ** 93) },
      eod: { AAA: path('AAA', '2025-01-02'), BBB: path('BBB', '2025-10-01', 50, 0.01) },
    });

  it('measures holdings bought inside the range from their first purchase, best first', () => {
    const r = computeHoldingsPerformance(two(), 'ALL');
    expect(r).toMatchObject({ range: 'ALL', baseCurrency: 'EUR', from: '2025-01-02', to: TODAY });
    expect(r.holdings.map((h) => h.symbol)).toEqual(['BBB', 'AAA']);
    const [bbb, aaa] = r.holdings;
    expect(bbb).toMatchObject({ name: 'Beta Corp', from: '2025-10-01', sincePurchase: true });
    expect(bbb!.returnPct).toBeCloseTo((1.01 ** 93 - 1) * 100, 1);
    expect(bbb!.gain).toBeCloseTo(4 * 50 * (1.01 ** 93 - 1), 1);
    expect(aaa).toMatchObject({ from: '2025-01-02', sincePurchase: false });
    expect(aaa!.returnPct).toBeCloseTo((1.001 ** 365 - 1) * 100, 1);
  });

  it('uses the range start for older holdings and leaves out holdings bought on the last day', () => {
    const d = two();
    d.transactions = [...d.transactions, tx({ symbol: 'CCC', date: TODAY, quantity: 1, price: 10 })];
    const r = computeHoldingsPerformance(d, '1M');
    expect(r.from).toBe('2025-12-03');
    expect(r.holdings.map((h) => h.symbol)).toEqual(['BBB', 'AAA']);
    expect(r.holdings.every((h) => !h.sincePurchase && h.from === '2025-12-03')).toBe(true);
  });

  it('excludes closed positions and falls back to the symbol without a profile', () => {
    const d = two();
    d.transactions = [...d.transactions, tx({ symbol: 'BBB', date: '2025-11-01', type: 'SELL', quantity: 4, price: 60 }), tx({ symbol: 'DDD', date: '2025-02-01', quantity: 1, price: 10 })];
    d.eod = { ...d.eod, DDD: path('DDD', '2025-02-01', 10, 0.002) };
    const r = computeHoldingsPerformance(d, 'ALL');
    expect(r.holdings.map((h) => h.symbol)).toEqual(['DDD', 'AAA']);
    expect(r.holdings[0]!.name).toBe('DDD');
  });

  it('breaks ties by symbol and is empty without transactions', () => {
    const d = data({ transactions: [tx({ symbol: 'BBB' }), tx({})], quotes: {}, eod: { AAA: path('AAA', '2025-01-02', 100, 0), BBB: path('BBB', '2025-01-02', 100, 0) } });
    expect(computeHoldingsPerformance(d, 'ALL').holdings.map((h) => [h.symbol, h.returnPct])).toEqual([
      ['AAA', 0],
      ['BBB', 0],
    ]);
    expect(computeHoldingsPerformance(data({ transactions: [] }), '1Y')).toEqual({ range: '1Y', baseCurrency: 'EUR', from: null, to: TODAY, holdings: [] });
  });
});

describe('query schemas', () => {
  it('parses benchmark lists: upper-cased, de-duplicated, at most three, valid symbols', () => {
    expect(parseBenchmarkList('iwda.as, VWRL.AS,iwda.as,')).toEqual(['IWDA.AS', 'VWRL.AS']);
    expect(parseBenchmarkList('')).toEqual([]);
    expect(parseBenchmarkList('A,B,C,D')).toBeNull();
    expect(parseBenchmarkList('A,B C')).toBeNull();
  });

  it('defaults to one year and the default benchmark; empty means none', () => {
    expect(growthQuerySchema.parse({})).toEqual({ range: '1Y', benchmarks: ['IWDA.AS'] });
    expect(growthQuerySchema.parse({ portfolioId: 'all', range: '5Y', benchmarks: 'a,b' })).toEqual({ portfolioId: 'all', range: '5Y', benchmarks: ['A', 'B'] });
    expect(growthQuerySchema.parse({ benchmarks: '' }).benchmarks).toEqual([]);
    expect(growthQuerySchema.safeParse({ range: '2Y' }).success).toBe(false);
    expect(growthQuerySchema.safeParse({ benchmarks: 'a,b,c,d' }).success).toBe(false);
    expect(holdingsPerformanceQuerySchema.parse({})).toEqual({ range: '1Y' });
    expect(holdingsPerformanceQuerySchema.safeParse({ range: 'nope' }).success).toBe(false);
  });
});
