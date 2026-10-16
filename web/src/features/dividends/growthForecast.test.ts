import { describe, expect, it } from 'vitest';
import { buildGrowthTimeline, computeDividendGrowth, computeDividendsOverview, type AnalyticsDividendGrowthResponse, type ForecastMonthInput } from '@portfolio/shared';
import { getAnalyticsData } from '../../mocks/db';
import {
  TABLE_COLUMNS,
  TIMELINE_HISTORY_MONTHS,
  declaredKey,
  estimatedKey,
  forecastLabel,
  signedMoney,
  summaryParts,
  tableRows,
  timelineLegendItems,
  timelineRows,
  tooltipLinesOfTimeline,
  selectYearRows,
  visiblePoints,
  yearBarVisible,
  yearForecastModel,
  yearLegendItems,
  yearTooltipLines,
} from './growthForecast';
import { sp } from '../../test/utils';

type ByMonth = AnalyticsDividendGrowthResponse['byMonth'];

const monthKey = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
/** `amounts[i]` in the month i after `from`. */
function history(from: string, amounts: readonly number[]): ByMonth {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  return amounts.map((total, i) => ({ month: monthKey(start + i), total, previousYearTotal: 0, yoyPct: null }));
}
const ahead = (from: string, declared: number[], estimated: number[]): ForecastMonthInput[] =>
  Array.from({ length: 12 }, (_, i) => ({ month: monthKey(Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1 + i), declared: declared[i] ?? 0, estimated: estimated[i] ?? 0 }));

const TODAY = '2026-10-15';
// Jan 2024 … Oct 2026 (the current month has 12.5 so far)
const RECEIVED = history('2024-01', Array.from({ length: 34 }, (_, i) => (i === 33 ? 12.5 : 10 + (i % 12))));
const FUTURE = ahead('2026-10', [0, 5, 0, 8], [3, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 6]);
const TIMELINE = buildGrowthTimeline(RECEIVED, FUTURE, TODAY);

describe('the forecast reconciles with the Future payments card', () => {
  const data = getAnalyticsData();
  const overview = computeDividendsOverview(data);
  const growth = computeDividendGrowth(data);

  // each month (and each holding) is rounded to cents on its own, so the parts can differ from the headline by a few cents
  it('sums to summary.forward12m within the cent rounding of its months, declared and estimated included', () => {
    const timeline = buildGrowthTimeline(growth.byMonth, overview.futureMonths, overview.asOf);
    expect(Math.abs(timeline.forecast.total - overview.summary.forward12m)).toBeLessThan(0.1);
    expect(Math.abs(timeline.forecast.declared - overview.summary.declared)).toBeLessThan(0.1);
    expect(Math.abs(timeline.forecast.estimated - overview.summary.estimated)).toBeLessThan(0.1);
    expect(timeline.forecast.total).toBe(Math.round((timeline.forecast.declared + timeline.forecast.estimated) * 100) / 100);
    expect(timeline.points.slice(-12).map((p) => p.month)).toEqual(overview.futureMonths.map((m) => m.month));
  });

  it('sums the bars the grouped chart and the timeline draw', () => {
    const timeline = buildGrowthTimeline(growth.byMonth, overview.futureMonths, overview.asOf);
    const model = yearForecastModel(growth.byMonth, timeline, true);
    const bars = model.rows.flatMap((row) => model.forecastYears.flatMap((y) => [row[declaredKey(y)], row[estimatedKey(y)]])).reduce<number>((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
    const line = timelineRows(timeline, true).reduce((sum, r) => sum + (r.declared ?? 0) + (r.estimated ?? 0), 0);
    expect(bars).toBeCloseTo(timeline.forecast.total, 2);
    expect(line).toBeCloseTo(timeline.forecast.total, 2);
    expect(Math.abs(bars - overview.summary.forward12m)).toBeLessThan(0.1);
  });
});

describe('yearForecastModel', () => {
  it('adds the current year remainder to its stack and the next year as a forecast year', () => {
    const model = yearForecastModel(RECEIVED, TIMELINE, true);
    expect(model.years).toEqual(['2024', '2025', '2026']);
    expect(model.forecastYears).toEqual(['2026', '2027']);
    expect(model.bars).toEqual(['2024', '2025', '2026', '2027']);
    const [jan, , , , , , , , , oct, nov] = model.rows;
    expect(oct).toMatchObject({ month: 'okt', '2026': 12.5, [estimatedKey('2026')]: 3 });
    expect(oct![declaredKey('2026')]).toBeUndefined(); // zero amounts leave no bar
    expect(nov).toMatchObject({ [declaredKey('2026')]: 5 });
    expect(jan).toMatchObject({ [declaredKey('2027')]: 8 });
    expect(jan![estimatedKey('2027')]).toBeUndefined();
    expect(model.rows[1]![estimatedKey('2027')]).toBe(4);
  });

  it('has no forecast bars when the forecast is hidden', () => {
    const model = yearForecastModel(RECEIVED, TIMELINE, false);
    expect(model.forecastYears).toEqual([]);
    expect(model.bars).toEqual(['2024', '2025', '2026']);
    expect(model.rows.every((r) => Object.keys(r).every((k) => !k.endsWith('-declared') && !k.endsWith('-estimated')))).toBe(true);
  });

  it('draws the average of the years only with history, and leaves out months with one year', () => {
    const model = yearForecastModel(RECEIVED, TIMELINE, true);
    expect(model.hasAverage).toBe(true);
    // January: 2024 = 10, 2025 = 10, 2026 = 10
    expect(model.rows[0]!.average).toBe(10);
    // October 2026 is the current month, so only 2024 and 2025 count
    expect(model.rows[9]!.average).toBe(((10 + 9) + (10 + 9)) / 2);
    const short = yearForecastModel(history('2026-05', [4, 4, 4, 4, 4]), buildGrowthTimeline(history('2026-05', [4, 4, 4, 4, 4]), FUTURE, TODAY), true);
    expect(short.hasAverage).toBe(false);
    expect(short.rows.every((r) => r.average === undefined)).toBe(true);
  });

  it('makes a forecast year of the current year when nothing was received in it yet', () => {
    const received = history('2025-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const timeline = buildGrowthTimeline(received, ahead('2026-01', [5], []), '2026-01-20');
    const model = yearForecastModel(received, timeline, true);
    expect(model.years).toEqual(['2025']);
    expect(model.forecastYears).toEqual(['2026']);
    expect(model.bars).toEqual(['2025', '2026']);
    expect(model.rows[0]).toMatchObject({ '2025': 1, [declaredKey('2026')]: 5 });
  });

  it('is unchanged without a forecast (no future events in the scope)', () => {
    const timeline = buildGrowthTimeline(RECEIVED, ahead('2026-10', [], []), TODAY);
    const model = yearForecastModel(RECEIVED, timeline, true);
    expect(model.forecastYears).toEqual([]);
    expect(model.years).toEqual(['2024', '2025', '2026']);
  });
});

describe('yearTooltipLines', () => {
  it('lists the received and forecast rows of a month and says "forecast" in words', () => {
    const model = yearForecastModel(RECEIVED, TIMELINE, true);
    const lines = yearTooltipLines(model.rows[9]!, model);
    expect(lines.map((l) => l.label)).toEqual(['2024', '2025', '2026', '2026 forecast · Estimated', 'Average of years']);
    expect(lines.find((l) => l.kind === 'estimated')).toMatchObject({ value: 3, year: '2026' });
    expect(yearTooltipLines(model.rows[0]!, model).map((l) => l.label)).toContain('2027 forecast · Declared');
    expect(yearTooltipLines(model.rows[1]!, model).map((l) => l.label)).toContain('2027 forecast · Estimated');
  });

  it('is empty for a month without any data', () => {
    expect(yearTooltipLines({ month: 'jan' }, { bars: ['2025'] })).toEqual([]);
  });
});

describe('timelineRows', () => {
  it('shows the last 24 complete months, the current month and the forecast with trend and average', () => {
    const rows = timelineRows(TIMELINE, true);
    expect(rows).toHaveLength(TIMELINE_HISTORY_MONTHS + 1 + 11);
    expect(rows[0]!.month).toBe('2024-10');
    const current = rows[TIMELINE_HISTORY_MONTHS]!;
    expect(current).toMatchObject({ month: '2026-10', phase: 'CURRENT', received: 12.5, estimated: 3 });
    expect(current.declared).toBeUndefined();
    expect(current.trend).toBeUndefined();
    expect(current.projection).toBeGreaterThan(0);
    const lastPast = rows[TIMELINE_HISTORY_MONTHS - 1]!;
    expect(lastPast.trend).toBeDefined();
    expect(lastPast.projection).toBe(lastPast.trend); // the dashed line starts where the solid one ends
    expect(rows.at(-1)).toMatchObject({ month: '2027-09', phase: 'FUTURE', received: undefined, estimated: 6 });
    expect(rows.slice(0, 5).every((r) => r.average !== undefined)).toBe(true);
  });

  it('drops the forecast and the projection when hidden, but keeps the current month', () => {
    const rows = timelineRows(TIMELINE, false);
    expect(rows).toHaveLength(TIMELINE_HISTORY_MONTHS + 1);
    expect(rows.at(-1)).toMatchObject({ phase: 'CURRENT', received: 12.5 });
    expect(rows.every((r) => r.declared === undefined && r.estimated === undefined && r.projection === undefined)).toBe(true);
    expect(rows.some((r) => r.trend !== undefined)).toBe(true);
  });

  it('has no trend or average lines without enough history', () => {
    const short = buildGrowthTimeline(history('2026-06', [3, 3, 3, 3]), FUTURE, TODAY);
    const rows = timelineRows(short, true);
    expect(rows.every((r) => r.trend === undefined && r.projection === undefined && r.average === undefined)).toBe(true);
    expect(rows.at(-1)).toBeDefined();
  });

  it('is empty without any data', () => {
    expect(timelineRows(buildGrowthTimeline([], [], TODAY), true)).toEqual([]);
  });
});

describe('tooltipLinesOfTimeline', () => {
  it('names the rows: received so far, forecast and projected trend', () => {
    const rows = timelineRows(TIMELINE, true);
    const current = tooltipLinesOfTimeline(rows[TIMELINE_HISTORY_MONTHS]!);
    expect(current.map((l) => l.label)).toEqual(['Received so far', 'Forecast · Estimated', 'Trend (projected)']);
    const past = tooltipLinesOfTimeline(rows[3]!);
    expect(past.map((l) => l.label)).toEqual(['Received', '12-month average', 'Trend']);
    const joint = tooltipLinesOfTimeline(rows[TIMELINE_HISTORY_MONTHS - 1]!);
    expect(joint.at(-1)!.label).toBe('Trend');
    expect(tooltipLinesOfTimeline(rows.at(-1)!).map((l) => l.label)).toEqual(['Forecast · Estimated', 'Trend (projected)']);
  });
});

describe('visiblePoints and tableRows', () => {
  it('labels forecast months "Forecast" in the period column', () => {
    const rows = tableRows(visiblePoints(TIMELINE, true), 'EUR').map((r) => r.map(sp));
    expect(TABLE_COLUMNS).toEqual(['Period', 'Received', 'Declared', 'Estimated', 'Trend']);
    expect(rows[0]![0]).toMatch(/^okt\.? 24$/);
    expect(rows[0]!.slice(2, 4)).toEqual(['—', '—']); // history has no forecast
    const current = rows[TIMELINE_HISTORY_MONTHS]!;
    expect(current[0]).toMatch(/ · Forecast \(month in progress\)$/);
    expect(current.slice(1, 4)).toEqual(['€ 12,50', '€ 0,00', '€ 3,00']);
    const future = rows.at(-1)!;
    expect(future[0]).toMatch(/^sep\.? 27 · Forecast$/);
    expect(future[1]).toBe('—');
    expect(future[3]).toBe('€ 6,00');
  });

  it('shows a dash for a missing trend', () => {
    const short = buildGrowthTimeline(history('2026-06', [3, 3, 3, 3]), [], TODAY);
    expect(tableRows(short.points, 'EUR').every((r) => r[4] === '—')).toBe(true);
  });
});

describe('summary', () => {
  it('formats the forecast and the trend per year', () => {
    const parts = summaryParts(TIMELINE, 'EUR', { declared: 13, estimated: 13, total: 26 }).map(sp);
    expect(parts[0]).toBe('Forecast next 12 months: € 26,00 (declared € 13,00, estimated € 13,00)');
    expect(parts[1]).toMatch(/^Trend: [+−]€ \d+,\d{2}\/month per year$/);
  });

  it('leaves out the forecast without data and the trend without 6 months', () => {
    const short = buildGrowthTimeline(history('2026-06', [3, 3, 3, 3]), FUTURE, TODAY);
    const totals = { declared: 13, estimated: 13, total: 26 };
    expect(summaryParts(short, 'EUR', totals)).toHaveLength(1);
    expect(summaryParts(short, 'EUR', null)).toEqual([]);
    expect(forecastLabel(short, 'EUR', null)).toBe('');
    expect(sp(forecastLabel(TIMELINE, 'EUR', totals))).toMatch(/^Forecast next 12 months: € 26,00 .*\. Trend: .*\.$/);
    expect(sp(forecastLabel(TIMELINE, 'EUR', null))).toMatch(/^Trend: /);
  });

  it('puts the sign before the currency symbol', () => {
    expect(sp(signedMoney(12.345, 'EUR'))).toBe('+€ 12,35');
    expect(sp(signedMoney(-3, 'EUR'))).toBe('\u2212€ 3,00');
    expect(sp(signedMoney(0.001, 'EUR'))).toBe('€ 0,00');
    expect(sp(signedMoney(-0.001, 'EUR'))).toBe('€ 0,00');
  });
});

describe('legend items', () => {
  it('lists the years, the forecast year, the forecast statuses and the average', () => {
    const model = yearForecastModel(RECEIVED, TIMELINE, true);
    const items = yearLegendItems(model, (y) => `#${y}`);
    expect(items.map((i) => i.label)).toEqual(['2024', '2025', '2026', '2027 (forecast)', 'Declared (forecast)', 'Estimated (forecast)', 'Average of years']);
    expect(items[0]).toMatchObject({ swatch: 'year', color: '#2024' });
    expect(yearLegendItems(yearForecastModel(RECEIVED, TIMELINE, false), (y) => y).map((i) => i.label)).toEqual(['2024', '2025', '2026', 'Average of years']);
  });

  it('lists only the series of the timeline that are drawn', () => {
    const all = timelineLegendItems(timelineRows(TIMELINE, true), '#0d9488');
    expect(all.map((i) => i.label)).toEqual(['Received', 'Declared (forecast)', 'Estimated (forecast)', '12-month average', 'Trend', 'Trend (projected)']);
    const hidden = timelineLegendItems(timelineRows(TIMELINE, false), '#0d9488');
    expect(hidden.map((i) => i.label)).toEqual(['Received', '12-month average', 'Trend']);
  });
});

describe('selection of the grouped chart', () => {
  const data = getAnalyticsData();
  const overview = computeDividendsOverview(data);
  const growth = computeDividendGrowth(data);
  const hide = (...hidden: string[]) => yearBarVisible((key) => !hidden.includes(key));

  it('lets a year hide its received bar and its forecast stack, and a kind hide that status in every year', () => {
    expect(hide()('2026')).toBe(true);
    expect(hide('2026')('2026')).toBe(false);
    expect(hide('2026')('2026-declared')).toBe(false);
    expect(hide('2026')('2027-declared')).toBe(true);
    expect(hide('declared')('2027-declared')).toBe(false);
    expect(hide('declared')('2027-estimated')).toBe(true);
    expect(hide('declared')('2026')).toBe(true);
  });

  it('lets a forecast-only year and the average line be hidden on their own', () => {
    expect(hide('2027-forecast')('2027-declared')).toBe(false);
    expect(hide('2027-forecast')('2027-estimated')).toBe(false);
    expect(hide('2027-forecast')('2026-declared')).toBe(true);
    expect(hide('average')('average')).toBe(false);
    expect(hide()('average')).toBe(true);
  });

  it('drops excluded months and clears hidden bars and lines in the rows it keeps', () => {
    const rows = [
      { month: 'Jan', '2025': 1, '2026': 2, '2026-declared': 3, average: 1.5 },
      { month: 'Feb', '2025': 4, '2026': 5, average: 4.5 },
    ];
    const result = selectYearRows(rows, (month) => month !== 'Feb', hide('2026', 'average'));
    expect(result).toEqual([{ month: 'Jan', '2025': 1, '2026': undefined, '2026-declared': undefined, average: undefined }]);
    expect(rows[0]!['2026']).toBe(2);
  });

  it('leaves the excluded years out of the average of the years only', () => {
    const timeline = buildGrowthTimeline(growth.byMonth, [], overview.asOf);
    const full = yearForecastModel(growth.byMonth, timeline, false);
    const [first, ...rest] = full.years;
    const without = yearForecastModel(growth.byMonth, timeline, false, 3, rest);
    expect(without.years).toEqual(full.years);
    expect(without.bars).toEqual(full.bars);
    expect(without.rows.map((r) => r.average)).not.toEqual(full.rows.map((r) => r.average));
    const none = yearForecastModel(growth.byMonth, timeline, false, 3, full.years);
    expect(none.hasAverage).toBe(false);
    expect(first).toBeDefined();
  });
});
