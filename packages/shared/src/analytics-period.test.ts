import { describe, expect, it } from 'vitest';
import { computeAnalyticsSummary, type AnalyticsData } from './analytics-compute.js';
import { DASHBOARD_PERIODS, analyticsSummaryQuerySchema } from './analytics-api.js';
import { emptyPeriodPerformance, periodBaseline } from './analytics-period.js';
import type { EodPrice, FxRates, Transaction } from './types.js';

const fx: FxRates = { base: 'EUR', rates: {}, asOf: '2026-01-02T00:00:00Z' };
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
const close = (date: string, value: number): EodPrice => ({ symbol: 'AAA', date, close: value, currency: 'EUR' });
const profiles = { AAA: { symbol: 'AAA', name: 'Alpha Inc', assetClass: 'STOCK' as const, sector: 'Technology', country: 'United States', currency: 'EUR' } };

/** Buy 10 @ 100, sell 4 @ 115 (realized 60), dividend 6 shares x 1 (6); the price steps 100 → 110 → 121. */
const data = (over: Partial<AnalyticsData> = {}): AnalyticsData => ({
  transactions: [tx({}), tx({ type: 'SELL', date: '2025-08-01', quantity: 4, price: 115 }), tx({ type: 'DIVIDEND', date: '2025-09-01', quantity: 6, price: 1 })],
  quotes: { AAA: { symbol: 'AAA', price: 121, previousClose: 120, currency: 'EUR', asOf: '2026-01-02', source: 't' } },
  profiles,
  fx,
  eod: { AAA: [close('2025-01-02', 100), close('2025-07-01', 110), close('2026-01-02', 121)] },
  dividendEvents: [],
  today: '2026-01-02',
  ...over,
});

const periodOf = (period: (typeof DASHBOARD_PERIODS)[number], over: Partial<AnalyticsData> = {}) => computeAnalyticsSummary(data(over), period).periodPerformance!;

describe('periodBaseline', () => {
  it('is the day before the window starts', () => {
    expect(periodBaseline('ttm', '2026-01-02', '2020-01-01')).toBe('2025-01-02');
    expect(periodBaseline('ytd', '2026-03-05', '2020-01-01')).toBe('2025-12-31');
    expect(periodBaseline('5y', '2026-01-02', '2020-01-01')).toBe('2021-01-03');
    expect(periodBaseline('10y', '2026-01-02', '2020-01-01')).toBe('2016-01-05');
    expect(periodBaseline('all', '2026-01-02', '2025-01-02')).toBe('2025-01-01');
  });
});

describe('computeAnalyticsSummary with a period', () => {
  it('leaves the response untouched without a period', () => {
    expect(computeAnalyticsSummary(data())).not.toHaveProperty('periodPerformance');
  });

  it('reproduces the all-time figures for "all"', () => {
    const all = computeAnalyticsSummary(data(), 'all');
    expect(all.periodPerformance).toMatchObject({
      period: 'all',
      from: '2025-01-02',
      to: '2026-01-02',
      truncated: false,
      startValue: 0,
      endValue: 726,
      dividends: 6,
      realizedPnl: 60,
      totalReturn: 192,
      totalReturnPct: 19.2,
    });
    expect(all.periodPerformance).toMatchObject({ irrPct: all.performance.irrPct, twrPct: all.performance.twrPct, days: all.performance.days });
  });

  it('cuts year to date at the last close of the previous year', () => {
    expect(periodOf('ytd')).toMatchObject({
      period: 'ytd',
      from: '2026-01-01',
      truncated: false,
      startValue: 660,
      endValue: 726,
      dividends: 0,
      realizedPnl: 0,
      totalReturn: 66,
      totalReturnPct: 11,
      twrPct: 10,
      twrAnnualisedPct: null,
      irrAnnualised: false,
    });
  });

  it('counts what happened inside a trailing year', () => {
    const ttm = periodOf('ttm');
    expect(ttm).toMatchObject({ from: '2025-01-03', truncated: false, startValue: 1000, dividends: 6, realizedPnl: 60, totalReturn: 192 });
    expect(ttm.days).toBe(365);
    expect(ttm.irrAnnualised).toBe(true);
  });

  it('flags a window longer than the history and covers only the history', () => {
    const five = periodOf('5y');
    expect(five).toMatchObject({ period: '5y', from: '2025-01-02', truncated: true, startValue: 0, totalReturn: 192, totalReturnPct: 19.2 });
    expect(periodOf('10y')).toMatchObject({ truncated: true, from: '2025-01-02' });
  });

  it('only counts dividends and sales that fall inside the window', () => {
    const late = periodOf('ytd', { today: '2026-01-02', transactions: [tx({}), tx({ type: 'DIVIDEND', date: '2026-01-01', quantity: 10, price: 2 }), tx({ type: 'SELL', date: '2026-01-02', quantity: 10, price: 121 })] });
    expect(late).toMatchObject({ dividends: 20, realizedPnl: 210 });
  });

  it('has no percentage base for a window without cost', () => {
    const closed = periodOf('ytd', { transactions: [tx({}), tx({ type: 'SELL', date: '2025-06-01', quantity: 10, price: 110 })], eod: { AAA: [close('2025-01-02', 100), close('2025-06-01', 110)] } });
    expect(closed).toMatchObject({ startValue: 0, endValue: 0, totalReturn: 0, totalReturnPct: 0, realizedPnl: 0 });
  });

  it('is empty without transactions', () => {
    expect(periodOf('ttm', { transactions: [] })).toEqual(emptyPeriodPerformance('ttm', '2026-01-02'));
  });
});

describe('analyticsSummaryQuerySchema', () => {
  it('accepts every window, treats empty as omitted and rejects the rest', () => {
    for (const period of DASHBOARD_PERIODS) expect(analyticsSummaryQuerySchema.parse({ period }).period).toBe(period);
    expect(analyticsSummaryQuerySchema.parse({ period: '' }).period).toBeUndefined();
    expect(analyticsSummaryQuerySchema.parse({}).period).toBeUndefined();
    expect(analyticsSummaryQuerySchema.safeParse({ period: '3y' }).success).toBe(false);
  });
});
