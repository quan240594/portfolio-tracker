import { describe, expect, it } from 'vitest';
import { FxTimeline } from './fx.js';
import {
  GOAL_SCENARIOS,
  addIsoDays,
  annualiseReturn,
  betaVs,
  chainReturns,
  dailyFlows,
  daysBetween,
  downsampleEvenly,
  maxDrawdown,
  moneyWeightedReturn,
  periodKey,
  portfolioDailyReturns,
  projectIncomeGoal,
  ratioToPct,
  riskStats,
  roundTo,
  toTradingDayReturns,
  topMovers,
  transactionAmount,
  transactionCashFlows,
  wealthIndex,
  xirr,
  type GoalInputs,
} from './analytics.js';
import type { FxRates, Holding, Transaction, ValuePoint } from './types.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-01-01T00:00:00Z' };
const timeline = new FxTimeline(fx);
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2026-01-02',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 1,
  price: 100,
  fee: 0,
  currency: 'EUR',
  createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});

describe('date and rounding helpers', () => {
  it('adds days across month and leap boundaries', () => {
    expect(addIsoDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addIsoDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addIsoDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('counts whole days, negative when reversed', () => {
    expect(daysBetween('2025-01-01', '2026-01-01')).toBe(365);
    expect(daysBetween('2026-01-02', '2026-01-01')).toBe(-1);
  });
  it('rounds', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(ratioToPct(0.12345)).toBe(12.35);
  });
});

describe('cash flows', () => {
  it('signs flows and applies fee and FX', () => {
    const buy = tx({ currency: 'USD', quantity: 10, price: 10, fee: 1 });
    const sell = tx({ type: 'SELL', currency: 'USD', quantity: 10, price: 10, fee: 1, fxRate: 1 });
    const div = tx({ type: 'DIVIDEND', quantity: 10, price: 1, fee: 1 });
    expect(transactionAmount(buy, timeline)).toBeCloseTo(101 / 1.1);
    expect(transactionAmount(sell, timeline)).toBe(99);
    expect(transactionCashFlows([buy, sell, div], timeline).map((f) => roundTo(f.amount, 4))).toEqual([-91.8182, 99, 9]);
  });
  it('aggregates contributions and income per day', () => {
    const flows = dailyFlows(
      [tx({ quantity: 2, price: 50 }), tx({ quantity: 1, price: 30, type: 'SELL' }), tx({ type: 'DIVIDEND', quantity: 3, price: 1 }), tx({ date: '2026-01-03', quantity: 1 })],
      timeline,
    );
    expect(flows.get('2026-01-02')).toEqual({ contributions: 70, income: 3 });
    expect(flows.get('2026-01-03')).toEqual({ contributions: 100, income: 0 });
  });
});

describe('xirr', () => {
  it('equals the analytic rate for one buy and a terminal value', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }])).toBeCloseTo(0.1, 9);
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2027-01-01', amount: 1210 }])).toBeCloseTo(0.1, 9);
  });
  it('handles a loss and a zero return', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 800 }])).toBeCloseTo(-0.2, 9);
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-07-01', amount: 1000 }])).toBeCloseTo(0, 9);
  });
  it('solves several flows', () => {
    const r = xirr([
      { date: '2024-01-01', amount: -100 },
      { date: '2024-12-31', amount: -100 },
      { date: '2025-12-31', amount: 231 },
    ]);
    expect(r).toBeCloseTo(0.1, 6);
  });
  it('falls back to bisection when Newton does not converge', () => {
    const flows = [
      [0, -348],
      [171, -926],
      [495, -865],
      [1058, 385],
    ].map(([d, amount]) => ({ date: addIsoDays('2020-01-01', d!), amount: amount! }));
    const r = xirr(flows)!;
    expect(r).toBeCloseTo(-0.569739, 5);
    const npv = flows.reduce((sum, f) => sum + f.amount * (1 + r) ** (-daysBetween('2020-01-01', f.date) / 365), 0);
    expect(Math.abs(npv)).toBeLessThan(1e-6);
  });
  it('rejects period returns beyond 100 000 000 %', () => {
    expect(xirr([{ date: '2026-01-01', amount: -1 }, { date: '2026-01-31', amount: 1e7 }])).toBeNull();
  });
  it('solves very short spans in period space', () => {
    const r = xirr([{ date: '2025-12-31', amount: -1100 }, { date: '2026-01-02', amount: 1210 }])!;
    expect(r / (1.1 ** (365 / 2) - 1)).toBeCloseTo(1, 9);
    expect(xirr([{ date: '2026-01-01', amount: -100 }, { date: '2026-01-31', amount: 300 }])! / (3 ** (365 / 30) - 1)).toBeCloseTo(1, 9);
  });
  it('is null when the annualised rate cannot be represented', () => {
    expect(xirr([{ date: '2026-01-01', amount: -1 }, { date: '2026-01-02', amount: 1e5 }])).toBeNull();
  });
  it('is null when no rate exists', () => {
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: '2026-01-01', amount: 100 }, { date: '2026-02-01', amount: 100 }])).toBeNull();
    expect(xirr([{ date: '2026-01-01', amount: -100 }, { date: '2026-01-01', amount: 150 }])).toBeNull();
    // beyond the supported rate range
    expect(xirr([{ date: '2026-01-01', amount: -1 }, { date: '2026-01-02', amount: 1e9 }])).toBeNull();
  });
  it('ignores zero flows and reports a total loss as -100 %', () => {
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-06-01', amount: 0 }])).toBe(-1);
    expect(xirr([{ date: '2025-01-01', amount: -1000 }])).toBeNull();
    expect(xirr([{ date: '2026-01-01', amount: -100 }, { date: '2026-02-01', amount: Number.NaN }])).toBe(-1);
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-06-01', amount: 0 }, { date: '2026-01-01', amount: 1100 }])).toBeCloseTo(0.1, 9);
  });
});

describe('moneyWeightedReturn', () => {
  it('annualises spans of a year or more', () => {
    const r = moneyWeightedReturn([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }])!;
    expect(r).toMatchObject({ days: 365, isAnnualised: true });
    expect(r.rate).toBeCloseTo(0.1, 9);
    expect(r.periodReturn).toBeCloseTo(0.1, 9);
  });
  it('reports the period return for short spans', () => {
    const r = moneyWeightedReturn([{ date: '2026-01-01', amount: -1000 }, { date: '2026-07-02', amount: 1050 }])!;
    expect(r.isAnnualised).toBe(false);
    expect(r.rate).toBeCloseTo(0.05, 9);
    expect(r.annualised).toBeGreaterThan(0.1);
  });
  it('keeps the exact period return for a two-day span', () => {
    const r = moneyWeightedReturn([{ date: '2025-12-31', amount: -1100 }, { date: '2026-01-02', amount: 1210 }])!;
    expect(r).toMatchObject({ days: 2, isAnnualised: false });
    expect(r.rate).toBeCloseTo(0.1, 12);
  });
  it('has no annualised figure when it overflows', () => {
    const r = moneyWeightedReturn([{ date: '2026-01-01', amount: -1 }, { date: '2026-01-02', amount: 1e5 }])!;
    expect(r.annualised).toBeNull();
    expect(r.rate).toBeCloseTo(99_999, 3);
  });
  it('reports a total loss over the whole span', () => {
    const r = moneyWeightedReturn([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 0 }])!;
    expect(r).toMatchObject({ rate: -1, periodReturn: -1, days: 365 });
  });
  it('is null without a rate', () => {
    expect(moneyWeightedReturn([])).toBeNull();
  });
});

describe('time-weighted return', () => {
  const points = (values: number[], start = '2026-03-02'): ValuePoint[] =>
    values.map((value, i) => ({ date: addIsoDays(start, i), value, invested: 0 }));

  it('removes contributions and counts income', () => {
    const flows = new Map([
      ['2026-03-04', { contributions: 50, income: 0 }],
      ['2026-03-05', { contributions: 0, income: 2 }],
    ]);
    const r = portfolioDailyReturns(points([100, 110, 165, 165]), flows);
    expect(r.map((x) => roundTo(x.r, 5))).toEqual([0.1, roundTo(115 / 110 - 1, 5), roundTo(2 / 165, 5)]);
    expect(r[0]!.date).toBe('2026-03-03');
  });
  it('skips days without a value base and handles a full sell', () => {
    const flows = new Map([['2026-03-03', { contributions: -120, income: 0 }]]);
    const r = portfolioDailyReturns(points([0, 100, 0, 0, 80]), flows);
    // day1: prev 0 skipped; day2: sold everything (value 0, proceeds 120... contributions -120 not on that date)
    expect(r.map((x) => x.date)).toEqual(['2026-03-04']);
    const sold = portfolioDailyReturns(points([100, 0]), new Map([['2026-03-03', { contributions: -105, income: 0 }]]));
    expect(sold[0]!.r).toBeCloseTo(0.05);
  });
  it('chains and annualises', () => {
    expect(chainReturns([0.1, 0.1])).toBeCloseTo(0.21);
    expect(chainReturns([])).toBe(0);
    expect(annualiseReturn(0.21, 730)).toBeCloseTo(0.1);
    expect(annualiseReturn(0.05, 364)).toBeNull();
  });
  it('builds a wealth index', () => {
    const levels = wealthIndex([{ date: 'b', r: 0.1 }, { date: 'c', r: -0.5 }], 'a');
    expect(levels.map((l) => l.date)).toEqual(['a', 'b', 'c']);
    expect(levels.map((l) => roundTo(l.index, 6))).toEqual([1, 1.1, 0.55]);
  });
  it('compounds weekend returns into the next weekday', () => {
    // 2026-03-06 is a Friday
    const out = toTradingDayReturns([
      { date: '2026-03-05', r: 0.01 },
      { date: '2026-03-06', r: 0.01 },
      { date: '2026-03-07', r: 0.02 },
      { date: '2026-03-08', r: 0.03 },
      { date: '2026-03-09', r: 0.04 },
      { date: '2026-03-10', r: 0 },
      { date: '2026-03-14', r: 0.5 },
    ]);
    expect(out.map((x) => x.date)).toEqual(['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10']);
    expect(out[2]!.r).toBeCloseTo(1.02 * 1.03 * 1.04 - 1, 12);
  });
});

describe('riskStats', () => {
  it('matches hand-computed values', () => {
    const s = riskStats([0.01, 0.03, -0.01, 0.03], 0);
    expect(s.volatility).toBeCloseTo(0.3039737, 6);
    expect(s.sharpe).toBeCloseTo(12.435287, 5);
    expect(s.sortino).toBeCloseTo(47.623524, 5);
  });
  it('subtracts the daily risk-free rate', () => {
    const zero = riskStats([0.01, 0.03, -0.01, 0.03], 0).sharpe!;
    const withRf = riskStats([0.01, 0.03, -0.01, 0.03]).sharpe!;
    expect(withRf).toBeLessThan(zero);
  });
  it('is symmetric around zero for alternating returns', () => {
    const s = riskStats([0.01, -0.01], 0);
    expect(s.volatility).toBeCloseTo(0.0141421 * Math.sqrt(252), 5);
    expect(s.sharpe).toBeCloseTo(0, 9);
    expect(s.sortino).toBeCloseTo(0, 9);
  });
  it('returns null where undefined', () => {
    expect(riskStats([0.01])).toEqual({ volatility: null, sharpe: null, sortino: null });
    expect(riskStats([])).toEqual({ volatility: null, sharpe: null, sortino: null });
    const flat = riskStats([0.02, 0.02, 0.02]);
    expect(flat.volatility).toBeCloseTo(0, 12);
    expect(flat.sharpe).toBeNull();
    expect(flat.sortino).toBeNull();
  });
});

describe('maxDrawdown', () => {
  const lv = (...idx: number[]) => idx.map((index, i) => ({ date: addIsoDays('2026-01-01', i), index }));
  it('finds peak, trough and recovery', () => {
    const d = maxDrawdown(lv(1, 1.2, 0.9, 1, 1.3, 1.1))!;
    expect(d.depth).toBeCloseTo(-0.25);
    expect(d).toMatchObject({ peakDate: '2026-01-02', troughDate: '2026-01-03', recoveryDate: '2026-01-05' });
  });
  it('has no recovery while under water and picks the deepest drawdown', () => {
    const d = maxDrawdown(lv(1, 2, 1.5, 3, 1))!;
    expect(d.depth).toBeCloseTo(-2 / 3);
    expect(d).toMatchObject({ peakDate: '2026-01-04', troughDate: '2026-01-05', recoveryDate: null });
  });
  it('reports none for a rising or empty series', () => {
    expect(maxDrawdown(lv(1, 1.1, 1.2))).toEqual({ depth: 0, peakDate: null, troughDate: null, recoveryDate: null });
    expect(maxDrawdown([])).toBeNull();
  });
});

describe('betaVs', () => {
  const series = (values: number[]) => values.map((r, i) => ({ date: addIsoDays('2026-01-01', i), r }));
  it('is 2 for a portfolio that moves twice the benchmark', () => {
    const b = series([0.01, -0.02, 0.03, 0.005]);
    const p = b.map((x) => ({ ...x, r: x.r * 2 }));
    const r = betaVs(p, b)!;
    expect(r.beta).toBeCloseTo(2, 9);
    expect(r.correlation).toBeCloseTo(1, 9);
    expect(r.observations).toBe(4);
  });
  it('uses shared dates only and needs two of them', () => {
    expect(betaVs(series([0.1, 0.2]), [{ date: '2030-01-01', r: 1 }])).toBeNull();
    expect(betaVs(series([0.1, 0.2, 0.3]), series([0.1, 0.2]).slice(1))).toBeNull();
  });
  it('is null for a constant benchmark and has no correlation for a constant portfolio', () => {
    expect(betaVs(series([0.1, 0.2, 0.3]), series([0.01, 0.01, 0.01]))).toEqual({ beta: null, correlation: null, observations: 3 });
    const r = betaVs(series([0.02, 0.02, 0.02]), series([0.01, 0.02, 0.03]))!;
    expect(r.beta).toBeCloseTo(0, 12);
    expect(r.correlation).toBeNull();
  });
});

describe('periodKey', () => {
  it('formats years, quarters and months', () => {
    expect(periodKey('2026-02-17', 'year')).toBe('2026');
    expect(periodKey('2026-03-31', 'quarter')).toBe('2026-Q1');
    expect(periodKey('2026-04-01', 'quarter')).toBe('2026-Q2');
    expect(periodKey('2026-12-31', 'quarter')).toBe('2026-Q4');
    expect(periodKey('2026-02-17', 'month')).toBe('2026-02');
  });
});

describe('topMovers', () => {
  const h = (symbol: string, dayChangePct: number): Holding =>
    ({ symbol, name: `${symbol} Inc`, dayChangePct, dayChange: dayChangePct * 10 }) as Holding;
  it('splits, sorts and limits', () => {
    const holdings = [h('A', 1), h('B', 3), h('C', -2), h('D', 0), h('E', 3), h('F', -5), h('G', 0.5), h('H', 2), h('I', 4), h('J', 0.1)];
    const { gainers, losers } = topMovers(holdings, 5);
    expect(gainers.map((g) => g.symbol)).toEqual(['I', 'B', 'E', 'H', 'A']);
    expect(losers.map((g) => g.symbol)).toEqual(['F', 'C']);
    expect(gainers[0]).toEqual({ symbol: 'I', name: 'I Inc', dayChangePct: 4, dayChange: 40 });
  });
  it('breaks ties by symbol among losers and defaults the limit to 5', () => {
    const many = ['Z', 'Y', 'X', 'W', 'V', 'U', 'T'].map((s) => h(s, -1));
    expect(topMovers(many).losers.map((l) => l.symbol)).toEqual(['T', 'U', 'V', 'W', 'X']);
  });
  it('handles an empty portfolio', () => {
    expect(topMovers([])).toEqual({ gainers: [], losers: [] });
  });
});

describe('projectIncomeGoal', () => {
  const base: GoalInputs = {
    targetIncome: 600,
    startIncome: 0,
    dividendGrowthPct: 0,
    yieldOnNewMoneyPct: 5,
    monthlyContribution: 1000,
    reinvestDividends: false,
    years: 2,
  };
  const find = (inputs: GoalInputs, id: string) => projectIncomeGoal(inputs).find((s) => s.id === id)!;

  it('adds contribution × yield every month without growth', () => {
    const s = find(base, 'base');
    // 12 × 1000 × 5 % = 600 after a year
    expect(s.points.map((p) => p.income)).toEqual([0, 600, 1200]);
    expect(s.points.map((p) => p.contributed)).toEqual([0, 12_000, 24_000]);
    expect(s.yearsToGoal).toBe(1);
  });
  it('reports fractional years, 0 when already there and null when out of reach', () => {
    expect(find({ ...base, targetIncome: 300 }, 'base').yearsToGoal).toBe(0.5);
    expect(find({ ...base, startIncome: 700 }, 'base').yearsToGoal).toBe(0);
    expect(find({ ...base, targetIncome: 1e6 }, 'base').yearsToGoal).toBeNull();
    expect(find({ ...base, monthlyContribution: 0 }, 'base').points.every((p) => p.income === 0)).toBe(true);
  });
  it('compounds growth and reinvested dividends', () => {
    const grow = find({ ...base, startIncome: 1200, monthlyContribution: 0, dividendGrowthPct: 10, yieldOnNewMoneyPct: 0, years: 1 }, 'base');
    expect(grow.points[1]!.income).toBeCloseTo(1320, 6);
    const reinvest = find({ ...base, startIncome: 1200, monthlyContribution: 0, reinvestDividends: true, years: 1 }, 'base');
    expect(reinvest.points[1]!.income).toBeCloseTo(1200 * (1 + 0.05 / 12) ** 12, 1);
  });
  it('orders scenarios and floors the assumptions at zero', () => {
    const [cautious, mid, optimistic] = projectIncomeGoal({ ...base, dividendGrowthPct: 1, yieldOnNewMoneyPct: 0.2, startIncome: 100, years: 5 });
    expect([cautious!.id, mid!.id, optimistic!.id]).toEqual(GOAL_SCENARIOS.map((s) => s.id));
    expect(cautious).toMatchObject({ dividendGrowthPct: 0, yieldOnNewMoneyPct: 0, label: 'Cautious' });
    expect(optimistic).toMatchObject({ dividendGrowthPct: 3, yieldOnNewMoneyPct: 0.7 });
    expect(cautious!.points.at(-1)!.income).toBeLessThan(mid!.points.at(-1)!.income);
    expect(mid!.points.at(-1)!.income).toBeLessThan(optimistic!.points.at(-1)!.income);
  });
});

describe('downsampleEvenly', () => {
  it('keeps short series and samples long ones including the ends', () => {
    expect(downsampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const out = downsampleEvenly(Array.from({ length: 101 }, (_, i) => i), 11);
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });
});
