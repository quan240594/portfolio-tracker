import { describe, expect, it } from 'vitest';
import {
  ECB_INFLATION_TARGET_PCT,
  MIN_GROWTH_COVERAGE,
  averageInflation,
  ecbTargetInflation,
  suggestDividendGrowth,
  suggestYieldOnNewMoney,
  type DividendGrowthHolding,
  type YieldHolding,
} from './goal-assumptions.js';
import type { InflationPoint } from './inflation-api.js';

const RANGE = { min: 0, max: 30 };

const holding = (symbol: string, forward12m: number, growthPct: number | null, growthYears = 3): DividendGrowthHolding => ({ symbol, forward12m, growthPct, growthYears });

describe('suggestDividendGrowth', () => {
  it('weights the per-share growth of every payer by its forward income', () => {
    const result = suggestDividendGrowth([holding('A', 300, 10), holding('B', 100, 2), holding('C', 100, 4, 5)], null, RANGE);
    expect(result).toEqual({
      available: true,
      rawPct: 7.2,
      pct: 7.2,
      clamped: false,
      basis: { method: 'PER_SHARE', payers: 3, holdings: 3, coveragePct: 100, minYears: 3, maxYears: 5 },
    });
  });

  it('leaves out holdings that do not pay and holdings without a growth figure when they cover enough of the income', () => {
    const result = suggestDividendGrowth([holding('A', 200, 5), holding('B', 100, null, 0), holding('Z', 0, 50)], null, RANGE);
    expect(result).toMatchObject({ available: true, pct: 5, basis: { method: 'PER_SHARE', payers: 2, holdings: 1, coveragePct: 67 } });
  });

  it('does not use a single full year of nothing: growth years below one are ignored', () => {
    const result = suggestDividendGrowth([holding('A', 100, 8, 0)], null, RANGE);
    expect(result).toEqual({ available: false, reason: 'TOO_LITTLE_HISTORY', payers: 1, withHistory: 0 });
  });

  it('needs the usable holdings to cover half of the forward income, else falls back to the income growth', () => {
    const holdings = [holding('A', 40, 6), holding('B', 60, null, 0)];
    expect(MIN_GROWTH_COVERAGE).toBe(0.5);
    const income = { startYear: 2022, endYear: 2025, startAmount: 100, endAmount: 150, years: 3, pct: 14.47 };
    expect(suggestDividendGrowth(holdings, income, RANGE)).toEqual({
      available: true,
      rawPct: 14.5,
      pct: 14.5,
      clamped: false,
      basis: { method: 'INCOME', payers: 2, holdings: 2, coveragePct: 100, minYears: 3, maxYears: 3, fromYear: 2022, toYear: 2025 },
    });
    expect(suggestDividendGrowth(holdings, undefined, RANGE)).toEqual({ available: false, reason: 'TOO_LITTLE_HISTORY', payers: 2, withHistory: 1 });
    expect(suggestDividendGrowth(holdings, { ...income, years: 0 }, RANGE)).toMatchObject({ available: false });
  });

  it('is unavailable without dividend payers', () => {
    expect(suggestDividendGrowth([], null, RANGE)).toEqual({ available: false, reason: 'NO_PAYERS', payers: 0, withHistory: 0 });
    expect(suggestDividendGrowth([holding('A', 0, 5)], null, RANGE)).toMatchObject({ reason: 'NO_PAYERS' });
  });

  it('lets a cut count: negative growth lowers the average and is clamped at the lower end', () => {
    const mixed = suggestDividendGrowth([holding('A', 100, 6), holding('B', 100, -2)], null, RANGE);
    expect(mixed).toMatchObject({ pct: 2, rawPct: 2, clamped: false });
    const cut = suggestDividendGrowth([holding('A', 100, -5)], null, RANGE);
    expect(cut).toMatchObject({ available: true, rawPct: -5, pct: 0, clamped: true });
  });

  it('limits each holding to the range, so one special dividend cannot dominate, and the result to the range', () => {
    const outlier = suggestDividendGrowth([holding('A', 100, 400), holding('B', 100, 0)], null, RANGE);
    expect(outlier).toMatchObject({ rawPct: 15, pct: 15, clamped: false });
    const high = suggestDividendGrowth([holding('A', 100, 400)], null, { min: 0, max: 20 });
    expect(high).toMatchObject({ rawPct: 20, pct: 20, clamped: false });
    const income = { startYear: 2020, endYear: 2025, startAmount: 1, endAmount: 100, years: 5, pct: 151.9 };
    expect(suggestDividendGrowth([holding('A', 100, null, 0)], income, RANGE)).toMatchObject({ rawPct: 151.9, pct: 30, clamped: true });
  });
});

const summary = { forward12m: 1000, yieldOnValuePct: 3.47, yieldOnCostPct: 4.9 };
const yieldHoldings: YieldHolding[] = [
  { forward12m: 600, marketValue: 12000 },
  { forward12m: 400, marketValue: 8000 },
  { forward12m: 0, marketValue: 0 },
];

describe('suggestYieldOnNewMoney', () => {
  it('uses the Dividends page figures for the portfolio and cost presets', () => {
    expect(suggestYieldOnNewMoney('portfolio', summary, yieldHoldings, RANGE)).toEqual({
      available: true,
      rawPct: 3.47,
      pct: 3.47,
      clamped: false,
      basis: { preset: 'portfolio', forward12m: 1000, payers: 2 },
    });
    expect(suggestYieldOnNewMoney('cost', summary, yieldHoldings, RANGE)).toMatchObject({ pct: 4.9 });
  });

  it('divides the payers income by the payers value', () => {
    expect(suggestYieldOnNewMoney('payers', summary, yieldHoldings, RANGE)).toMatchObject({ pct: 5, basis: { preset: 'payers', forward12m: 1000, payers: 2 } });
    expect(suggestYieldOnNewMoney('payers', summary, [{ forward12m: 10, marketValue: 0 }], RANGE)).toMatchObject({ pct: 0 });
  });

  it('clamps to the range of the input', () => {
    expect(suggestYieldOnNewMoney('cost', { ...summary, yieldOnCostPct: 31.234 }, yieldHoldings, { min: 0, max: 20 })).toMatchObject({ rawPct: 31.23, pct: 20, clamped: true });
  });

  it('is unavailable without forward income', () => {
    expect(suggestYieldOnNewMoney('portfolio', { ...summary, forward12m: 0 }, yieldHoldings, RANGE)).toEqual({ available: false, reason: 'NO_INCOME' });
    expect(suggestYieldOnNewMoney('portfolio', summary, [], RANGE)).toEqual({ available: false, reason: 'NO_INCOME' });
  });
});

/** Monthly points from `from` to `to` (inclusive, `YYYY-MM`) with the rate of `rateOf(index)`. */
function series(from: string, to: string, rateOf: (month: string, index: number) => number): InflationPoint[] {
  const points: InflationPoint[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (let index = 0; ; index++) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    points.push({ month, ratePct: rateOf(month, index) });
    if (month === to) return points;
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
}

describe('averageInflation', () => {
  it('is the compound average of the annual rates, 12 months apart, ending at the latest month', () => {
    // only the rates of September count: 5 % the latest year, 3 % the year before: (1.05 * 1.03)^(1/2) - 1 = 3.995 %
    const rates: Record<string, number> = { '2026-09': 5, '2025-09': 3 };
    const points = series('2025-01', '2026-09', (month) => rates[month] ?? 50);
    expect(averageInflation(points, 'all', RANGE)).toMatchObject({ available: true, pct: 4, rawPct: 4, basis: { horizon: 'all', years: 2, fromMonth: '2024-09', toMonth: '2026-09' } });
  });

  it('returns the exact compound rate: a constant 2.5 % is 2.5 % whatever the horizon', () => {
    const points = series('1999-01', '2026-09', () => 2.5);
    for (const horizon of ['5y', '10y', '20y', 'all'] as const) {
      expect(averageInflation(points, horizon, RANGE)).toMatchObject({ available: true, pct: 2.5, rawPct: 2.5, clamped: false });
    }
    expect(averageInflation(points, '10y', RANGE)).toMatchObject({ basis: { horizon: '10y', years: 10, fromMonth: '2016-09', toMonth: '2026-09' } });
    expect(averageInflation(points, 'all', RANGE)).toMatchObject({ basis: { years: 28, fromMonth: '1998-09' } });
  });

  it('matches the price-level growth over the period (telescoping product)', () => {
    // price index 100 -> 130 over the last 10 years: 2.66 % a year, whatever the path in between
    const rates = [3, 2, 4, 1, 0.5, 2.5, 6, 8, 3, 1.2];
    const points: InflationPoint[] = rates.map((ratePct, i) => ({ month: `${2017 + i}-09`, ratePct }));
    const growth = rates.reduce((level, r) => level * (1 + r / 100), 1);
    const result = averageInflation(points, '10y', RANGE);
    expect(result).toMatchObject({ available: true, pct: Math.round((growth ** (1 / 10) - 1) * 1000) / 10 });
  });

  it('uses the latest month as the anchor, whatever the order of the points', () => {
    const points = series('2015-01', '2026-03', (month) => (month.endsWith('-03') ? 2 : 9)).reverse();
    expect(averageInflation(points, '10y', RANGE)).toMatchObject({ available: true, pct: 2, basis: { toMonth: '2026-03', fromMonth: '2016-03' } });
  });

  it('is unavailable when the series is shorter than the horizon, has a gap in the yearly chain, or is empty', () => {
    const short = series('2020-01', '2026-09', () => 2);
    expect(averageInflation(short, '10y', RANGE)).toEqual({ available: false, reason: 'TOO_SHORT', availableYears: 7 });
    const gap = series('2016-09', '2026-09', () => 2).filter((p) => p.month !== '2021-09');
    expect(averageInflation(gap, '10y', RANGE)).toEqual({ available: false, reason: 'TOO_SHORT', availableYears: 5 });
    expect(averageInflation(gap, 'all', RANGE)).toMatchObject({ available: true, basis: { years: 5 } });
    expect(averageInflation([], 'all', RANGE)).toEqual({ available: false, reason: 'TOO_SHORT', availableYears: 0 });
    expect(averageInflation(series('2026-01', '2026-09', () => 2), '5y', RANGE)).toEqual({ available: false, reason: 'TOO_SHORT', availableYears: 1 });
  });

  it('clamps a negative average to zero and a huge one to the maximum', () => {
    const deflation = series('2020-09', '2026-09', () => -1.5);
    expect(averageInflation(deflation, '5y', RANGE)).toMatchObject({ rawPct: -1.5, pct: 0, clamped: true });
    const hyper = series('2020-09', '2026-09', () => 80);
    expect(averageInflation(hyper, '5y', RANGE)).toMatchObject({ rawPct: 80, pct: 30, clamped: true });
  });
});

describe('ecbTargetInflation', () => {
  it('is the 2 % target, within the range', () => {
    expect(ECB_INFLATION_TARGET_PCT).toBe(2);
    expect(ecbTargetInflation(RANGE)).toEqual({ rawPct: 2, pct: 2, clamped: false });
    expect(ecbTargetInflation({ min: 3, max: 5 })).toEqual({ rawPct: 2, pct: 3, clamped: true });
  });
});
