import { describe, expect, it } from 'vitest';
import { calculateDividendGrowthStats, YOY_MIN_MONTHS, type DividendMonthlyTotals } from './dividend-growth-stats.js';

const totals = (entries: Record<string, number>): DividendMonthlyTotals => new Map(Object.entries(entries));

/** `amount` in every month from `from` to `to` (inclusive, `YYYY-MM`). */
function steady(from: string, to: string, amount: number): Record<string, number> {
  const out: Record<string, number> = {};
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out[key] = amount;
    if (key === to) return out;
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
}

describe('calculateDividendGrowthStats: no history', () => {
  it('has no figures without dividends', () => {
    expect(calculateDividendGrowthStats(totals({}), '2026-10-15')).toEqual({ asOf: '2026-10-15', qoq: null, yoy: null, cagr: null });
  });

  it('has no figures when everything was received this month', () => {
    const stats = calculateDividendGrowthStats(totals({ '2026-10': 500 }), '2026-10-31');
    expect(stats).toEqual({ asOf: '2026-10-31', qoq: null, yoy: null, cagr: null });
  });
});

describe('quarter over quarter', () => {
  const data = totals({ '2026-04': 80, '2026-05': 20, '2026-06': 20, '2026-07': 100, '2026-08': 0, '2026-09': 50.5, '2026-10': 999 });

  it('compares the latest complete calendar quarter with the one before, ignoring the current month', () => {
    const { qoq } = calculateDividendGrowthStats(data, '2026-10-15');
    expect(qoq).toEqual({
      basis: 'QUARTER',
      current: { from: '2026-07', to: '2026-09', amount: 150.5 },
      previous: { from: '2026-04', to: '2026-06', amount: 120 },
      change: 30.5,
      pct: 25.42,
    });
  });

  it('keeps the quarter running until its last month is over', () => {
    expect(calculateDividendGrowthStats(data, '2026-12-31').qoq?.current).toEqual({ from: '2026-07', to: '2026-09', amount: 150.5 });
    expect(calculateDividendGrowthStats(data, '2026-10-01').qoq?.current.to).toBe('2026-09');
  });

  it('crosses the year boundary', () => {
    const qoq = calculateDividendGrowthStats(totals({ '2025-08': 10, '2025-11': 30 }), '2026-01-31').qoq;
    expect(qoq?.current).toEqual({ from: '2025-10', to: '2025-12', amount: 30 });
    expect(qoq?.previous).toEqual({ from: '2025-07', to: '2025-09', amount: 10 });
    expect(qoq?.pct).toBe(200);
  });

  it('shows negative growth', () => {
    const qoq = calculateDividendGrowthStats(totals({ '2026-05': 100, '2026-08': 80 }), '2026-10-15').qoq;
    expect(qoq).toMatchObject({ change: -20, pct: -20 });
    expect(calculateDividendGrowthStats(totals({ '2026-05': 100 }), '2026-10-15').qoq).toMatchObject({ change: -100, pct: -100 });
  });

  it('has a change but no percentage without a baseline', () => {
    const qoq = calculateDividendGrowthStats(totals({ '2026-08': 42.5 }), '2026-10-15').qoq;
    expect(qoq).toMatchObject({ previous: { amount: 0 }, change: 42.5, pct: null });
    const zero = calculateDividendGrowthStats(totals({ '2026-05': 0, '2026-08': 10 }), '2026-10-15').qoq;
    expect(zero?.pct).toBeNull();
  });

  it('is absent while the first payment is in the running quarter', () => {
    expect(calculateDividendGrowthStats(totals({ '2026-07': 5, '2026-09': 5 }), '2026-08-20').qoq).toBeNull();
  });

  it('follows the leap day and the short February', () => {
    const data = totals({ '2023-08': 10, '2023-11': 20, '2024-02': 40 });
    expect(calculateDividendGrowthStats(data, '2024-02-29').qoq?.current).toEqual({ from: '2023-10', to: '2023-12', amount: 20 });
    expect(calculateDividendGrowthStats(data, '2024-03-31').qoq?.current).toEqual({ from: '2023-10', to: '2023-12', amount: 20 });
    expect(calculateDividendGrowthStats(data, '2024-04-01').qoq).toMatchObject({ current: { from: '2024-01', to: '2024-03', amount: 40 }, pct: 100 });
    expect(calculateDividendGrowthStats(totals({ '2025-02': 7, '2025-04': 14 }), '2025-03-01').qoq).toBeNull();
  });
});

describe('year over year', () => {
  it('compares the last 12 complete months with the 12 before with 24 months of history', () => {
    const data = totals({ ...steady('2024-10', '2025-09', 10), ...steady('2025-10', '2026-09', 15), '2024-09': 1000, '2026-10': 777 });
    expect(calculateDividendGrowthStats(data, '2026-10-15').yoy).toEqual({
      basis: 'TTM',
      current: { from: '2025-10', to: '2026-09', amount: 180 },
      previous: { from: '2024-10', to: '2025-09', amount: 120 },
      change: 60,
      pct: 50,
    });
  });

  it('needs exactly 24 complete months for the rolling comparison', () => {
    expect(YOY_MIN_MONTHS).toBe(24);
    const rolling = calculateDividendGrowthStats(totals(steady('2024-10', '2026-09', 10)), '2026-10-15').yoy;
    expect(rolling?.basis).toBe('TTM');
    const short = calculateDividendGrowthStats(totals(steady('2024-11', '2026-09', 10)), '2026-10-15').yoy;
    expect(short?.basis).toBe('CALENDAR_YEAR');
  });

  it('falls back to the latest complete calendar year with fewer than 24 months', () => {
    const data = totals({ ...steady('2024-08', '2024-12', 10), ...steady('2025-01', '2025-12', 8), '2026-01': 9, '2026-02': 9 });
    expect(calculateDividendGrowthStats(data, '2026-03-10').yoy).toEqual({
      basis: 'CALENDAR_YEAR',
      current: { from: '2025-01', to: '2025-12', amount: 96 },
      previous: { from: '2024-01', to: '2024-12', amount: 50 },
      change: 46,
      pct: 92,
    });
  });

  it('shows negative growth', () => {
    const yoy = calculateDividendGrowthStats(totals({ '2024-06': 200.5, '2025-06': 100 }), '2026-02-01').yoy;
    expect(yoy).toMatchObject({ basis: 'CALENDAR_YEAR', change: -100.5, pct: -50.12 });
  });

  it('is absent without a previous calendar year of dividends', () => {
    expect(calculateDividendGrowthStats(totals(steady('2025-03', '2025-12', 10)), '2026-03-10').yoy).toBeNull();
    expect(calculateDividendGrowthStats(totals({ '2026-01': 10 }), '2026-03-10').yoy).toBeNull();
    expect(calculateDividendGrowthStats(totals({ '2024-05': 0, '2025-05': 10 }), '2026-03-10').yoy).toBeNull();
  });

  it('has no percentage when the earlier 12 months are empty despite a long history', () => {
    const data = totals({ '2024-10': 0, ...steady('2025-10', '2026-09', 5) });
    expect(calculateDividendGrowthStats(data, '2026-10-15').yoy).toMatchObject({ basis: 'TTM', change: 60, pct: null, previous: { amount: 0 } });
  });

  it('does not count the current partial year', () => {
    const data = totals({ '2024-05': 100, '2025-05': 100, '2026-01': 5000 });
    expect(calculateDividendGrowthStats(data, '2026-03-10').yoy).toMatchObject({ change: 0, pct: 0 });
  });
});

describe('compound annual growth', () => {
  it('compounds from the first to the latest complete calendar year', () => {
    const data = totals({ '2023-03': 70, '2023-09': 50, '2024-06': 200, '2025-12': 310, '2026-02': 9999 });
    expect(calculateDividendGrowthStats(data, '2026-10-15').cagr).toEqual({ startYear: 2023, endYear: 2025, startAmount: 120, endAmount: 310, years: 2, pct: 60.73 });
  });

  it('handles a single year step and negative growth', () => {
    expect(calculateDividendGrowthStats(totals({ '2024-05': 100, '2025-05': 125 }), '2026-01-02').cagr).toMatchObject({ years: 1, pct: 25 });
    expect(calculateDividendGrowthStats(totals({ '2022-05': 300, '2024-05': 200 }), '2025-03-01').cagr).toMatchObject({ years: 2, endAmount: 200, pct: -18.35 });
  });

  it('counts a latest complete year without dividends as a full loss', () => {
    expect(calculateDividendGrowthStats(totals({ '2023-05': 100 }), '2026-05-01').cagr).toMatchObject({ endAmount: 0, years: 2, pct: -100 });
  });

  it('is absent with fewer than two complete years', () => {
    expect(calculateDividendGrowthStats(totals({ '2025-05': 100 }), '2026-05-01').cagr).toBeNull();
    expect(calculateDividendGrowthStats(totals({ '2026-01': 100 }), '2026-05-01').cagr).toBeNull();
    expect(calculateDividendGrowthStats(totals({ '2025-05': 100, '2026-01': 100 }), '2026-05-01').cagr).toBeNull();
  });

  it('is absent when the first year received nothing or the last year is negative', () => {
    expect(calculateDividendGrowthStats(totals({ '2023-05': 0, '2025-05': 100 }), '2026-05-01').cagr).toBeNull();
    expect(calculateDividendGrowthStats(totals({ '2023-05': 100, '2025-05': -5 }), '2026-05-01').cagr).toBeNull();
  });

  it('never returns Infinity or NaN', () => {
    const data = totals({ '2023-05': 0, '2024-05': 0, '2025-05': 0, '2026-01': 0 });
    for (const stats of [calculateDividendGrowthStats(data, '2026-05-01'), calculateDividendGrowthStats(totals({ '2025-01': 0, '2025-04': 5 }), '2026-05-01')]) {
      for (const g of [stats.qoq, stats.yoy]) expect(g === null || g.pct === null || Number.isFinite(g.pct)).toBe(true);
    }
  });
});
