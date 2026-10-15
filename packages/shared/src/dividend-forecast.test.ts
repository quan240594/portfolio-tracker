import { describe, expect, it } from 'vitest';
import {
  AVERAGE_WINDOW_MONTHS,
  TREND_FIT_MONTHS,
  TREND_MIN_MONTHS,
  averageByCalendarMonth,
  buildGrowthTimeline,
  completeHistory,
  linearFit,
  trailingAverages,
  type ForecastMonthInput,
  type MonthAmount,
} from './dividend-forecast.js';

const monthKey = (index: number): string => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/** `amounts[i]` in the month i after `from` (`YYYY-MM`). */
function series(from: string, amounts: readonly number[]): MonthAmount[] {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  return amounts.map((total, i) => ({ month: monthKey(start + i), total }));
}

/** 12 months from `from`: declared in the first, estimated in the rest. */
function ahead(from: string, declared = 10, estimated = 5): ForecastMonthInput[] {
  return series(from, Array.from({ length: 12 }, () => 0)).map((m, i) => ({ month: m.month, declared: i === 0 ? declared : 0, estimated }));
}

describe('linearFit', () => {
  it('fits a straight line exactly', () => {
    const fit = linearFit([2, 4, 6, 8])!;
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(2, 10);
  });

  it('is flat for a constant series and averages noisy data', () => {
    expect(linearFit([5, 5, 5])).toEqual({ slope: 0, intercept: 5 });
    const fit = linearFit([1, 3, 2, 4])!;
    expect(fit.slope).toBeCloseTo(0.8, 10);
    expect(fit.intercept).toBeCloseTo(1.3, 10);
  });

  it('needs two values', () => {
    expect(linearFit([])).toBeNull();
    expect(linearFit([3])).toBeNull();
  });
});

describe('completeHistory', () => {
  it('fills the gaps up to the month before today and ignores the current and later months', () => {
    const history = completeHistory([{ month: '2026-01', total: 10 }, { month: '2026-04', total: 5.005 }, { month: '2026-06', total: 99 }, { month: '2026-09', total: 1 }], '2026-06-30');
    expect(history).toEqual(series('2026-01', [10, 0, 0, 5.01, 0]));
  });

  it('crosses a year boundary and a leap day', () => {
    expect(completeHistory(series('2023-11', [1, 2, 3, 4]), '2024-02-29')).toEqual(series('2023-11', [1, 2, 3]));
    expect(completeHistory(series('2023-11', [1, 2]), '2024-03-01')).toEqual(series('2023-11', [1, 2, 0, 0]));
  });

  it('is empty without dividends or when everything was received this month', () => {
    expect(completeHistory([], '2026-10-15')).toEqual([]);
    expect(completeHistory([{ month: '2026-10', total: 50 }], '2026-10-01')).toEqual([]);
  });
});

describe('trailingAverages', () => {
  it('starts with the sixth month and averages the available months, then the last 12', () => {
    const history = series('2025-01', Array.from({ length: 14 }, (_, i) => i + 1));
    const averages = trailingAverages(history);
    expect(averages.slice(0, TREND_MIN_MONTHS - 1)).toEqual([null, null, null, null, null]);
    expect(averages[5]).toBe(3.5); // 1..6
    expect(averages[11]).toBe(6.5); // 1..12
    expect(averages[13]).toBe(8.5); // 3..14 = last 12 months only
    expect(AVERAGE_WINDOW_MONTHS).toBe(12);
  });

  it('has nothing for an empty history', () => {
    expect(trailingAverages([])).toEqual([]);
  });
});

describe('averageByCalendarMonth', () => {
  const history = series('2024-03', Array.from({ length: 24 }, (_, i) => (i % 12 === 0 ? 10 : 0) + i)); // 2024-03 … 2026-02

  it('averages every calendar month over the years in which it is a complete month', () => {
    const average = averageByCalendarMonth(history, ['2024', '2025', '2026']);
    // January: 2025-01 (index 10) = 10 and 2026-01 (index 22) = 22 → mean 16; March: 2024-03 (0) and 2025-03 (12) → 10 + 0, 10 + 12
    expect(average[0]).toBe(16);
    expect(average[2]).toBe((10 + 0 + 10 + 12) / 2);
    expect(average).toHaveLength(12);
  });

  it('skips a month with a single year and years that are not shown', () => {
    const average = averageByCalendarMonth(history, ['2025', '2026']);
    expect(average[2]).toBeNull(); // March only in 2025 within the shown years
    expect(average[0]).toBe(16);
  });

  it('draws nothing with fewer than six months of history', () => {
    expect(averageByCalendarMonth(series('2026-01', [1, 2, 3, 4, 5]), ['2026']).every((v) => v === null)).toBe(true);
  });
});

describe('buildGrowthTimeline: no history', () => {
  it('has no points without any data', () => {
    const t = buildGrowthTimeline([], [], '2026-10-15');
    expect(t).toEqual({ asOf: '2026-10-15', historyMonths: 0, points: [], trend: null, forecast: { declared: 0, estimated: 0, total: 0 } });
  });

  it('still draws the forecast, without a trend', () => {
    const t = buildGrowthTimeline([], ahead('2026-10'), '2026-10-15');
    expect(t.historyMonths).toBe(0);
    expect(t.trend).toBeNull();
    expect(t.points).toHaveLength(12);
    expect(t.points[0]).toMatchObject({ month: '2026-10', phase: 'CURRENT', received: 0, declared: 10, estimated: 5, trend: null, projected: false });
    expect(t.points.every((p) => p.trend === null)).toBe(true);
    expect(t.forecast).toEqual({ declared: 10, estimated: 60, total: 70 });
  });

  it('keeps a current month that only has received dividends', () => {
    const t = buildGrowthTimeline([{ month: '2026-10', total: 12.5 }], [], '2026-10-15');
    expect(t.points).toEqual([{ month: '2026-10', phase: 'CURRENT', received: 12.5, declared: 0, estimated: 0, average: null, trend: null, projected: false }]);
  });
});

describe('buildGrowthTimeline: fewer than 6 months', () => {
  it('has no trend and no average, but still the forecast', () => {
    const t = buildGrowthTimeline(series('2026-05', [10, 10, 10, 10, 10]), ahead('2026-10'), '2026-10-15');
    expect(t.historyMonths).toBe(5);
    expect(t.trend).toBeNull();
    expect(t.points.slice(0, 5).every((p) => p.average === null && p.trend === null)).toBe(true);
    expect(t.points.at(-1)!.trend).toBeNull();
    expect(t.forecast.total).toBe(70);
  });

  it('draws the trend from exactly 6 months', () => {
    const t = buildGrowthTimeline(series('2026-04', [10, 10, 10, 10, 10, 10]), ahead('2026-10'), '2026-10-15');
    expect(t.historyMonths).toBe(6);
    expect(t.trend).toEqual({ from: '2026-04', to: '2026-09', months: 6, slopePerMonth: 0, slopePerYear: 0 });
    expect(t.points[5]!.average).toBe(10);
  });
});

describe('buildGrowthTimeline: trend', () => {
  it('fits a rising line over the history and projects it over the current and future months', () => {
    const t = buildGrowthTimeline(series('2026-01', [10, 12, 14, 16, 18, 20, 22, 24, 26]), ahead('2026-10'), '2026-10-15');
    expect(t.trend).toEqual({ from: '2026-01', to: '2026-09', months: 9, slopePerMonth: 2, slopePerYear: 24 });
    const byMonth = Object.fromEntries(t.points.map((p) => [p.month, p]));
    expect(byMonth['2026-09']).toMatchObject({ trend: 26, projected: false, phase: 'PAST' });
    expect(byMonth['2026-10']).toMatchObject({ trend: 28, projected: true, phase: 'CURRENT' });
    expect(byMonth['2027-09']).toMatchObject({ trend: 50, projected: true, phase: 'FUTURE' });
  });

  it('uses only the last 24 complete months', () => {
    const amounts = [...Array.from({ length: 10 }, () => 1000), ...Array.from({ length: 24 }, (_, i) => 5 + i)];
    const t = buildGrowthTimeline(series('2024-01', amounts), ahead('2026-11'), '2026-11-15');
    expect(t.historyMonths).toBe(34);
    expect(t.trend).toMatchObject({ from: '2024-11', to: '2026-10', months: TREND_FIT_MONTHS, slopePerMonth: 1 });
    expect(t.points[0]!.trend).toBeNull(); // before the fit window
    expect(t.points[10]).toMatchObject({ month: '2024-11', trend: 5 });
  });

  it('clamps a falling trend at 0 instead of going negative', () => {
    const t = buildGrowthTimeline(series('2026-01', [30, 25, 20, 15, 10, 5, 0, 0, 0]), ahead('2026-10'), '2026-10-15');
    expect(t.trend!.slopePerMonth).toBeLessThan(0);
    expect(t.trend!.slopePerYear).toBeLessThan(0);
    expect(t.points.slice(-12).every((p) => p.trend === 0)).toBe(true);
    expect(t.points.every((p) => p.trend === null || p.trend >= 0)).toBe(true);
  });

  it('treats months without dividends as zeros', () => {
    const t = buildGrowthTimeline([...series('2026-01', [40]), ...series('2026-07', [40])], ahead('2026-10'), '2026-10-15');
    expect(t.historyMonths).toBe(9);
    expect(t.points.slice(0, 9).map((p) => p.received)).toEqual([40, 0, 0, 0, 0, 0, 40, 0, 0]);
    expect(t.points[8]!.average).toBe(8.89); // (40 + 40) / 9 months
  });

  it('is a flat zero trend for zero income', () => {
    const t = buildGrowthTimeline(series('2026-01', [0, 0, 0, 0, 0, 0, 0]), [], '2026-08-15');
    expect(t.trend).toMatchObject({ slopePerMonth: 0, slopePerYear: 0 });
  });
});

describe('buildGrowthTimeline: forecast horizon', () => {
  it('crosses the year boundary and keeps the current month partial', () => {
    const t = buildGrowthTimeline([...series('2026-01', [5, 5, 5, 5, 5, 5, 5, 5, 5]), { month: '2026-10', total: 7.5 }], ahead('2026-10', 4, 1), '2026-10-31');
    expect(t.points.at(-12)).toMatchObject({ month: '2026-10', phase: 'CURRENT', received: 7.5, declared: 4, estimated: 1 });
    expect(t.points.slice(-12).map((p) => p.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09']);
    expect(t.points.slice(-11).every((p) => p.phase === 'FUTURE' && p.received === 0)).toBe(true);
  });

  it('keeps the whole horizon inside the year in January', () => {
    const t = buildGrowthTimeline([], ahead('2026-01'), '2026-01-31');
    expect(t.points.map((p) => p.month.slice(0, 4))).toEqual(Array.from({ length: 12 }, () => '2026'));
  });

  it('adds a current month when the forecast starts after it and drops stale months', () => {
    const t = buildGrowthTimeline(series('2026-01', [1, 1, 1, 1, 1, 1, 1, 1, 1]), [{ month: '2026-08', declared: 99, estimated: 99 }, { month: '2026-11', declared: 3, estimated: 2 }], '2026-10-15');
    expect(t.points.slice(-2)).toMatchObject([{ month: '2026-10', phase: 'CURRENT', declared: 0, estimated: 0 }, { month: '2026-11', phase: 'FUTURE', declared: 3, estimated: 2 }]);
    expect(t.forecast).toEqual({ declared: 3, estimated: 2, total: 5 });
  });

  it('has a flat, empty forecast for a scope without future events', () => {
    const t = buildGrowthTimeline(series('2026-01', [5, 5, 5, 5, 5, 5, 5, 5, 5]), ahead('2026-10', 0, 0), '2026-10-15');
    expect(t.forecast).toEqual({ declared: 0, estimated: 0, total: 0 });
    expect(t.points.slice(-12).every((p) => p.declared === 0 && p.estimated === 0 && p.trend === 5)).toBe(true);
  });

  it('sums the forecast in cents, without floating point noise', () => {
    const months = ahead('2026-10', 0.1, 0.2);
    const t = buildGrowthTimeline([], months, '2026-10-15');
    expect(t.forecast.declared).toBe(0.1);
    expect(t.forecast.estimated).toBe(2.4);
    expect(t.forecast.total).toBe(2.5);
  });
});
