import { describe, expect, it } from 'vitest';
import { addIsoDays } from './analytics.js';
import type { AnalyticsData } from './analytics-compute.js';
import {
  badgeFor,
  computeDividendsOverview,
  dividendGrowthCagr,
  mergePaymentHistory,
  paymentBlocks,
  scoreConsistency,
  type PaymentPoint,
} from './dividends-overview.js';
import type { DividendEvent, InstrumentProfile, Quote, Transaction } from './types.js';

const TODAY = '2026-06-15';
const at = (offset: number) => addIsoDays(TODAY, offset);
const pay = (offset: number, perShare = 1): PaymentPoint => ({ date: at(offset), perShare });
/** `count` payments `step` days apart; the newest `newestOffset` days before today. Per-share amount from `amountOf(index, oldestFirst)`. */
const schedule = (count: number, step: number, newestOffset: number, amountOf: (i: number) => number = () => 1): PaymentPoint[] =>
  Array.from({ length: count }, (_, i) => pay(newestOffset - step * (count - 1 - i), amountOf(i)));

describe('mergePaymentHistory', () => {
  const event = (over: Partial<DividendEvent>): DividendEvent => ({ symbol: 'X', exDate: at(-100), amount: 0.5, currency: 'EUR', ...over });

  it('adds past events that are not a received payment, oldest first', () => {
    const received = [pay(-10, 1), pay(-100, 1)];
    const merged = mergePaymentHistory(
      received,
      [
        event({ exDate: at(-200), payDate: at(-190), amount: 0.7 }), // older than anything received: kept
        event({ exDate: at(-15), payDate: at(-12) }), // 2 days from a received payment: the same payment
        event({ exDate: at(-111) }), // no pay date: the ex-date counts, 11 days from a received payment
        event({ exDate: at(20), payDate: at(30) }), // not paid yet
        event({ exDate: at(-300), amount: 0.6 }),
        event({ exDate: at(-305), amount: 0.6 }), // same payment as the previous event
      ],
      TODAY,
    );
    expect(merged).toEqual([pay(-300, 0.6), pay(-190, 0.7), pay(-100, 1), pay(-10, 1)]);
    expect(received).toHaveLength(2);
  });
});

describe('paymentBlocks', () => {
  it('sums consecutive blocks of payments, newest first, and drops an incomplete oldest block', () => {
    const payments = schedule(10, 91, -10, (i) => i + 1); // 1..10
    expect(paymentBlocks(payments, 4)).toEqual([7 + 8 + 9 + 10, 3 + 4 + 5 + 6]);
    expect(paymentBlocks(payments.slice(0, 3), 4)).toEqual([]);
  });

  it('looks at six years at most', () => {
    expect(paymentBlocks(schedule(40, 91, -10), 4)).toHaveLength(6);
  });
});

describe('dividendGrowthCagr', () => {
  it('is the compound annual growth of the per-share total over the full years', () => {
    // yearly totals 1.0, 1.1, 1.21 (quarterly 0.25, 0.275, 0.3025)
    const amounts = [0.25, 0.275, 0.3025];
    const payments = schedule(12, 91, -10, (i) => amounts[Math.floor(i / 4)]!);
    expect(dividendGrowthCagr(payments)).toEqual({ cagrPct: 10, years: 2 });
    expect(dividendGrowthCagr(payments.slice(4))).toEqual({ cagrPct: 10, years: 1 });
  });

  it('is null without two full years of payments', () => {
    expect(dividendGrowthCagr([])).toEqual({ cagrPct: null, years: 0 });
    expect(dividendGrowthCagr([pay(-10)])).toEqual({ cagrPct: null, years: 0 });
    expect(dividendGrowthCagr(schedule(4, 91, -10))).toEqual({ cagrPct: null, years: 0 });
    expect(dividendGrowthCagr(schedule(3, 91, -10))).toEqual({ cagrPct: null, years: 0 });
  });

  it('is null when the oldest year paid nothing and -100 % when the dividend stopped', () => {
    expect(dividendGrowthCagr(schedule(8, 91, -10, (i) => (i < 4 ? 0 : 1)))).toEqual({ cagrPct: null, years: 1 });
    expect(dividendGrowthCagr(schedule(8, 91, -10, (i) => (i < 4 ? 1 : 0)))).toEqual({ cagrPct: -100, years: 1 });
  });
});

describe('badgeFor', () => {
  it('uses 70 and 40 as boundaries', () => {
    expect([100, 70, 69, 40, 39, 0].map(badgeFor)).toEqual(['RELIABLE', 'RELIABLE', 'OK', 'OK', 'IRREGULAR', 'IRREGULAR']);
  });
});

describe('scoreConsistency', () => {
  it('scores a perfect payer 100: five years, even gaps, no cut, five raises in a row', () => {
    // 24 quarterly payments, the per-share total rising every year
    const result = scoreConsistency(schedule(24, 91, -10, (i) => 0.25 * 1.05 ** Math.floor(i / 4)), TODAY);
    expect(result).toEqual({
      badge: 'RELIABLE',
      score: 100,
      payments: 24,
      yearsWithPayments: 5,
      paymentsPerYear: 4,
      regularityCv: 0,
      cuts: 0,
      growthStreak: 5,
      points: { history: 30, regularity: 30, cuts: 25, growth: 15 },
    });
  });

  it('scores two flat years of a regular quarterly payer 67 (OK)', () => {
    const result = scoreConsistency(schedule(8, 91, -10), TODAY);
    expect(result).toMatchObject({ badge: 'OK', score: 67, yearsWithPayments: 2, cuts: 0, growthStreak: 0, points: { history: 12, regularity: 30, cuts: 25, growth: 0 } });
  });

  it('counts a year with a lower per-share total as a cut', () => {
    // yearly totals 1.0, 1.2, 1.0
    const amounts = [0.25, 0.3, 0.25];
    const result = scoreConsistency(schedule(12, 91, -10, (i) => amounts[Math.floor(i / 4)]!), TODAY);
    expect(result).toMatchObject({ badge: 'OK', score: 60, yearsWithPayments: 3, cuts: 1, growthStreak: 0, points: { history: 18, regularity: 30, cuts: 12, growth: 0 } });
  });

  it('never gives negative cut points and ignores changes within the flat band', () => {
    const shrinking = [1, 0.8, 0.6, 0.4];
    const cuts = scoreConsistency(schedule(16, 91, -10, (i) => shrinking[Math.floor(i / 4)]! / 4), TODAY);
    expect(cuts).toMatchObject({ cuts: 3, points: { cuts: 0 } });
    const flat = scoreConsistency(schedule(8, 91, -10, (i) => (i < 4 ? 0.25 : 0.2501)), TODAY);
    expect(flat).toMatchObject({ cuts: 0, growthStreak: 0 });
  });

  it('scores an erratic payer 30 (irregular)', () => {
    const payments = [pay(-1000), pay(-900), pay(-500), pay(-480), pay(-100, 0.5)];
    // gaps 100, 400, 20, 380: variation 0.74 → no regularity points; the upper median gap makes it a yearly payer, and the
    // newest payment (0.5) is below the one before (1) → one cut
    expect(scoreConsistency(payments, TODAY)).toEqual({
      badge: 'IRREGULAR',
      score: 30,
      payments: 5,
      yearsWithPayments: 3,
      paymentsPerYear: 1,
      regularityCv: 0.745,
      cuts: 1,
      growthStreak: 0,
      points: { history: 18, regularity: 0, cuts: 12, growth: 0 },
    });
  });

  it('treats a long wait since the last payment as one more gap', () => {
    const regular = scoreConsistency(schedule(8, 91, -75), TODAY);
    const stalled = scoreConsistency(schedule(8, 91, -300), TODAY);
    expect(regular.points.regularity).toBe(30);
    expect(stalled.points.regularity).toBeLessThan(10);
    expect(stalled.regularityCv).toBeGreaterThan(0.5);
  });

  it('uses neutral points when the history is too short to judge', () => {
    expect(scoreConsistency([pay(-100), pay(-10)], TODAY)).toMatchObject({
      badge: 'IRREGULAR',
      score: 33,
      regularityCv: null,
      cuts: null,
      points: { history: 6, regularity: 15, cuts: 12, growth: 0 },
    });
  });

  it('labels fewer than two payments NEW without a score', () => {
    const none = scoreConsistency([], TODAY);
    expect(none).toEqual({ badge: 'NEW', score: null, payments: 0, yearsWithPayments: 0, paymentsPerYear: 1, regularityCv: null, cuts: null, growthStreak: 0, points: { history: 0, regularity: 0, cuts: 0, growth: 0 } });
    expect(scoreConsistency([pay(-10)], TODAY)).toMatchObject({ badge: 'NEW', score: null, payments: 1, yearsWithPayments: 1 });
  });
});

// --- computeDividendsOverview ------------------------------------------------------------------------

let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2024-01-02',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 100,
  price: 10,
  fee: 0,
  currency: 'EUR',
  createdAt: `2024-01-02T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
const div = (symbol: string, date: string, perShare: number, over: Partial<Transaction> = {}) =>
  tx({ type: 'DIVIDEND', symbol, date, price: perShare, ...over });
const quote = (symbol: string, price: number, currency = 'EUR'): Quote => ({ symbol, price, previousClose: price, currency, asOf: TODAY, source: 't' });
const profile = (symbol: string, currency = 'EUR'): InstrumentProfile => ({ symbol, name: `${symbol} Corp`, assetClass: 'STOCK', currency });

function data(over: Partial<AnalyticsData> = {}): AnalyticsData {
  const transactions = [
    // AAA: quarterly payer, 8 payments 0.09 → 0.10 net of nothing; one declared payment on 2026-07-01
    tx({ symbol: 'AAA' }),
    ...['2024-07-01', '2024-10-01', '2025-01-02', '2025-04-01'].map((d) => div('AAA', d, 0.09)),
    ...['2025-07-01', '2025-10-01', '2026-01-02', '2026-04-01'].map((d) => div('AAA', d, 0.1)),
    // BBB: USD payer with one payment, 15 % withheld
    tx({ symbol: 'BBB', quantity: 10, price: 100, currency: 'USD' }),
    div('BBB', '2026-03-01', 1, { quantity: 10, currency: 'USD', fee: 1.5 }),
    // CCC: never paid; DDD: sold, but its dividend still counts as received; EEE: stopped paying long ago
    tx({ symbol: 'CCC' }),
    tx({ symbol: 'DDD', quantity: 10, price: 10, date: '2025-01-02' }),
    div('DDD', '2025-09-01', 0.5, { quantity: 10 }),
    tx({ symbol: 'DDD', type: 'SELL', quantity: 10, price: 12, date: '2026-02-01' }),
    tx({ symbol: 'EEE' }),
    div('EEE', '2023-03-01', 0.2),
    div('EEE', '2023-09-01', 0.2),
  ];
  const events: DividendEvent[] = [{ symbol: 'AAA', exDate: '2026-06-20', payDate: '2026-07-01', amount: 0.1, currency: 'EUR' }];
  return {
    transactions,
    quotes: { AAA: quote('AAA', 12), BBB: quote('BBB', 120, 'USD'), CCC: quote('CCC', 10), EEE: quote('EEE', 10) },
    profiles: { AAA: profile('AAA'), BBB: profile('BBB', 'USD'), CCC: profile('CCC'), DDD: profile('DDD'), EEE: profile('EEE') },
    fx: { base: 'EUR', rates: { USD: 1.25 }, asOf: `${TODAY}T00:00:00Z` },
    eod: {},
    dividendEvents: events,
    today: TODAY,
    ...over,
  };
}

describe('computeDividendsOverview', () => {
  const overview = computeDividendsOverview(data());

  it('totals the forward income like the passive income forecast', () => {
    // AAA: 1 declared (100 × 0.10) + 3 estimated; BBB: 1 estimated (10 × 1.0 USD at 1.25, 15 % withheld)
    expect(overview.baseCurrency).toBe('EUR');
    expect(overview.asOf).toBe(TODAY);
    expect(overview.summary).toMatchObject({
      forward12m: 46.8,
      declared: 10,
      estimated: 36.8,
      monthlyAverage: 3.9,
      yieldOnValuePct: 1.13, // 46.8 / (1200 + 960 + 1000 + 1000)
      yieldOnCostPct: 1.23, // 46.8 / (1000 + 800 + 1000 + 1000)
      last12m: 51.8, // AAA 40 + BBB 6.8 + DDD 5 (sold holding)
      growthVsLast12mPct: -9.65,
    });
  });

  it('lists current payers with their yield, income share, growth and consistency, largest income first', () => {
    expect(overview.holdings.map((h) => h.symbol)).toEqual(['AAA', 'BBB', 'EEE']);
    const [aaa, bbb, eee] = overview.holdings as [(typeof overview.holdings)[number], (typeof overview.holdings)[number], (typeof overview.holdings)[number]];
    expect(aaa).toMatchObject({ name: 'AAA Corp', currency: 'EUR', marketValue: 1200, costBasis: 1000, forward12m: 40, declared: 10, estimated: 30, sharePct: 85.47, yieldPct: 3.33, yieldOnCostPct: 4, received12m: 40, receivedTotal: 76 });
    expect(aaa.growthPct).toBe(11.11);
    expect(aaa.growthYears).toBe(1);
    expect(aaa.consistency).toMatchObject({ badge: 'RELIABLE', score: 70, points: { history: 12, regularity: 30, cuts: 25, growth: 3 } });
    expect(bbb).toMatchObject({ currency: 'USD', marketValue: 960, forward12m: 6.8, yieldPct: 0.71, received12m: 6.8, growthPct: null });
    expect(bbb.consistency.badge).toBe('NEW');
    expect(eee).toMatchObject({ forward12m: 0, yieldPct: 0, received12m: 0, receivedTotal: 40, growthPct: null });
    expect(eee.consistency).toMatchObject({ badge: 'IRREGULAR', paymentsPerYear: 2 });
  });

  it('places declared and estimated income in the month it is paid', () => {
    expect(overview.futureMonths.map((m) => m.month)).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05',
    ]);
    const nonZero = overview.futureMonths.filter((m) => m.declared > 0 || m.estimated > 0);
    // AAA: declared 2026-07-01; the other three quarters follow last year's pattern (Oct, Dec/Jan, Apr); BBB: March
    expect(nonZero).toEqual([
      { month: '2026-07', declared: 10, estimated: 0 },
      { month: '2026-10', declared: 0, estimated: 10 },
      { month: '2026-12', declared: 0, estimated: 10 },
      { month: '2027-03', declared: 0, estimated: 6.8 },
      { month: '2027-04', declared: 0, estimated: 10 },
    ]);
    const total = overview.futureMonths.reduce((s, m) => s + m.declared + m.estimated, 0);
    expect(total).toBeCloseTo(overview.summary.forward12m, 2);
  });

  it('breaks the future months down per holding, so the periods reconcile with the forward income', () => {
    expect(overview.futureByHolding).toEqual([
      { month: '2026-07', symbol: 'AAA', declared: 10, estimated: 0 },
      { month: '2026-10', symbol: 'AAA', declared: 0, estimated: 10 },
      { month: '2026-12', symbol: 'AAA', declared: 0, estimated: 10 },
      { month: '2027-03', symbol: 'BBB', declared: 0, estimated: 6.8 },
      { month: '2027-04', symbol: 'AAA', declared: 0, estimated: 10 },
    ]);
    const entries = overview.futureByHolding!;
    const declared = entries.reduce((s, e) => s + e.declared, 0);
    const estimated = entries.reduce((s, e) => s + e.estimated, 0);
    expect(declared).toBeCloseTo(overview.summary.declared, 2);
    expect(estimated).toBeCloseTo(overview.summary.estimated, 2);
    expect(declared + estimated).toBeCloseTo(overview.summary.forward12m, 2);
    for (const month of overview.futureMonths) {
      const own = entries.filter((e) => e.month === month.month);
      expect(own.reduce((s, e) => s + e.declared, 0)).toBeCloseTo(month.declared, 2);
      expect(own.reduce((s, e) => s + e.estimated, 0)).toBeCloseTo(month.estimated, 2);
    }
  });

  it('orders several holdings in one month by symbol', () => {
    const same = computeDividendsOverview(
      data({
        dividendEvents: [
          { symbol: 'CCC', exDate: '2026-06-20', payDate: '2026-07-02', amount: 0.2, currency: 'EUR' },
          { symbol: 'AAA', exDate: '2026-06-20', payDate: '2026-07-01', amount: 0.1, currency: 'EUR' },
        ],
      }),
    );
    const july = same.futureByHolding!.filter((e) => e.month === '2026-07');
    expect(july.map((e) => e.symbol)).toEqual(['AAA', 'CCC']);
    expect(july.map((e) => e.declared)).toEqual([10, 20]);
    expect(same.futureByHolding!.map((e) => e.month)).toEqual([...same.futureByHolding!.map((e) => e.month)].sort((a, b) => a.localeCompare(b)));
  });

  it('puts payments dated in the 13th month in the current month and splits declared income by event value', () => {
    const late = computeDividendsOverview(
      data({
        dividendEvents: [
          { symbol: 'AAA', exDate: '2027-06-10', payDate: '2027-06-28', amount: 0.1, currency: 'EUR' },
          { symbol: 'AAA', exDate: '2026-12-10', amount: 0.3, currency: 'EUR' }, // pay date unknown: ex-date
          { symbol: 'AAA', exDate: '2026-09-10', payDate: '2026-09-20', amount: 0, currency: 'EUR' },
        ],
      }),
    );
    expect(late.summary.declared).toBe(40);
    expect(late.futureMonths[0]).toMatchObject({ month: '2026-06', declared: 10 });
    expect(late.futureMonths[6]).toMatchObject({ month: '2026-12', declared: 30 });
    expect(late.futureMonths[3]).toMatchObject({ month: '2026-09', declared: 0 });
  });

  it('adds past events to the payment history', () => {
    const withHistory = computeDividendsOverview(
      data({
        dividendEvents: [
          { symbol: 'BBB', exDate: '2025-02-01', payDate: '2025-03-01', amount: 0.8, currency: 'USD' },
          { symbol: 'BBB', exDate: '2024-02-01', payDate: '2024-03-01', amount: 0.6, currency: 'USD' },
        ],
      }),
    );
    const bbb = withHistory.holdings.find((h) => h.symbol === 'BBB')!;
    expect(bbb.consistency.payments).toBe(3);
    expect(bbb.consistency.badge).toBe('RELIABLE');
    expect(bbb.consistency.score).toBe(79); // 18 + 30 + 25 + 6
    expect(bbb.consistency).toMatchObject({ paymentsPerYear: 1, cuts: 0, growthStreak: 2, yearsWithPayments: 3 });
    expect(bbb.growthPct).toBe(29.1); // 1.0 / 0.6 over two years
  });

  it('ignores transactions after today and returns empty, zeroed data without holdings', () => {
    const future = computeDividendsOverview(data({ transactions: [tx({ date: '2026-08-01' })] }));
    expect(future.holdings).toEqual([]);
    const empty = computeDividendsOverview(data({ transactions: [], quotes: {}, profiles: {}, dividendEvents: [] }));
    expect(empty.holdings).toEqual([]);
    expect(empty.summary).toEqual({ forward12m: 0, declared: 0, estimated: 0, monthlyAverage: 0, yieldOnValuePct: 0, yieldOnCostPct: 0, last12m: 0, growthVsLast12mPct: null });
    expect(empty.futureMonths).toHaveLength(12);
    expect(empty.futureByHolding).toEqual([]);
    expect(empty.futureMonths.every((m) => m.declared === 0 && m.estimated === 0)).toBe(true);
  });

  it('uses the given clock for prices when provided', () => {
    expect(computeDividendsOverview(data({ now: new Date(`${TODAY}T20:00:00Z`) })).summary.forward12m).toBe(46.8);
  });
});
