import { averageByCalendarMonth, completeHistory, type AnalyticsDividendGrowthResponse, type ForecastTotals, type GrowthTimeline, type TimelinePoint } from '@portfolio/shared';
import { formatMoney, formatMonth } from '../../lib/format';
import { yearComparison } from './receivedSeries';

/** View models of the forecast and trend in the "Dividend growth" card (pure: the components only draw them). */

export type GrowthView = 'year' | 'timeline';

export const GROWTH_VIEWS = [
  { value: 'year', label: 'By year' },
  { value: 'timeline', label: 'Timeline' },
] as const;

/** Months of history the timeline shows (the window the trend is fitted on). */
export const TIMELINE_HISTORY_MONTHS = 24;

export const NEEDS_HISTORY_NOTE = 'Needs at least 6 months of dividend history to show a trend.';

const DASH = '—';

export const declaredKey = (year: string): string => `${year}-declared`;
export const estimatedKey = (year: string): string => `${year}-estimated`;

export type YearRow = { month: string } & Record<string, number | string | undefined>;

export interface YearForecastModel {
  /** Years with received dividends shown, oldest first. */
  years: string[];
  /** Years that have forecast bars, oldest first (the current year is in both lists once it has received dividends). */
  forecastYears: string[];
  /** Every year with a bar, oldest first. */
  bars: string[];
  /** Jan…Dec: `<year>` = received, `<year>-declared` / `<year>-estimated` = forecast, `average` = average of the years. */
  rows: YearRow[];
  /** True when the "Average of years" line has points. */
  hasAverage: boolean;
}

const positive = (value: number): number | undefined => (value > 0 ? value : undefined);

/**
 * The grouped-by-year chart with the forecast bars of the current year's remainder and of the next year(s) added to the matching year's stack.
 * `excludedYears` (the years the user left out of the chart) are not part of the "Average of years" line; the years and bars stay as they are.
 */
export function yearForecastModel(
  byMonth: AnalyticsDividendGrowthResponse['byMonth'],
  timeline: GrowthTimeline,
  showForecast: boolean,
  maxYears = 3,
  excludedYears: readonly string[] = [],
): YearForecastModel {
  const { years, rows } = yearComparison(byMonth, maxYears);
  const ahead = showForecast ? timeline.points.filter((p) => p.phase !== 'PAST' && p.declared + p.estimated > 0) : [];
  for (const p of ahead) {
    const row = rows[Number(p.month.slice(5, 7)) - 1]!;
    row[declaredKey(p.month.slice(0, 4))] = positive(p.declared);
    row[estimatedKey(p.month.slice(0, 4))] = positive(p.estimated);
  }
  const average = averageByCalendarMonth(
    completeHistory(byMonth, timeline.asOf),
    years.filter((y) => !excludedYears.includes(y)),
  );
  rows.forEach((row, i) => {
    row.average = average[i] ?? undefined;
  });
  const forecastYears = [...new Set(ahead.map((p) => p.month.slice(0, 4)))].sort((a, b) => a.localeCompare(b));
  const bars = [...new Set([...years, ...forecastYears])].sort((a, b) => a.localeCompare(b));
  return { years, forecastYears, bars, rows, hasAverage: average.some((v) => v !== null) };
}

/**
 * Whether a data key of the grouped chart (`2026`, `2026-declared`, `2026-estimated`, `average`) is drawn under a selection.
 * Legend keys: a year hides its received bar and its forecast stack, `declared` / `estimated` hide that status in every year,
 * `<year>-forecast` hides the forecast of a year that only has forecast bars, `average` hides the line.
 * `isVisible` answers true for keys the selection does not know.
 */
export function yearBarVisible(isVisible: (key: string) => boolean): (dataKey: string) => boolean {
  return (dataKey) => {
    if (dataKey === 'average') return isVisible('average');
    const year = dataKey.slice(0, 4);
    if (dataKey === year) return isVisible(year);
    return isVisible(year) && isVisible(dataKey.slice(5)) && isVisible(`${year}-forecast`);
  };
}

/** The months that are not excluded, with the hidden bars and lines cleared, so a tooltip only names what is drawn. */
export function selectYearRows(rows: readonly YearRow[], isRowVisible: (month: string) => boolean, barVisible: (dataKey: string) => boolean): YearRow[] {
  return rows
    .filter((row) => isRowVisible(row.month))
    .map((row) => {
      const masked: YearRow = { month: row.month };
      for (const [key, value] of Object.entries(row)) if (key !== 'month') masked[key] = barVisible(key) ? value : undefined;
      return masked;
    });
}

export type TooltipKind = 'received' | 'declared' | 'estimated' | 'average' | 'trend';

export interface TooltipLine {
  key: string;
  label: string;
  value: number;
  kind: TooltipKind;
  /** Year of a bar (not set for lines). */
  year?: string;
}

const isNumber = (value: unknown): value is number => typeof value === 'number';

/** Rows of the tooltip of one calendar month in the grouped chart; forecast rows say so in words. */
export function yearTooltipLines(row: YearRow, model: Pick<YearForecastModel, 'bars'>): TooltipLine[] {
  const lines: TooltipLine[] = [];
  for (const year of model.bars) {
    const received = row[year];
    const declared = row[declaredKey(year)];
    const estimated = row[estimatedKey(year)];
    if (isNumber(received)) lines.push({ key: year, label: year, value: received, kind: 'received', year });
    if (isNumber(declared)) lines.push({ key: declaredKey(year), label: `${year} forecast · Declared`, value: declared, kind: 'declared', year });
    if (isNumber(estimated)) lines.push({ key: estimatedKey(year), label: `${year} forecast · Estimated`, value: estimated, kind: 'estimated', year });
  }
  if (isNumber(row.average)) lines.push({ key: 'average', label: 'Average of years', value: row.average, kind: 'average' });
  return lines;
}

export interface TimelineRow {
  month: string;
  label: string;
  phase: TimelinePoint['phase'];
  received?: number;
  declared?: number;
  estimated?: number;
  /** Trailing 12-month average. */
  average?: number;
  /** Trend fitted over the history. */
  trend?: number;
  /** Trend extended over the current and future months; starts at the last fitted point so the two lines join. */
  projection?: number;
}

/** The points of the timeline chart: the last 24 complete months, the current month and (with the forecast) the months ahead. */
export function visiblePoints(timeline: GrowthTimeline, showForecast: boolean): TimelinePoint[] {
  const past = timeline.points.filter((p) => p.phase === 'PAST').slice(-TIMELINE_HISTORY_MONTHS);
  const rest = timeline.points.filter((p) => p.phase !== 'PAST' && (showForecast || p.phase === 'CURRENT'));
  return [...past, ...rest];
}

export function timelineRows(timeline: GrowthTimeline, showForecast: boolean): TimelineRow[] {
  const rows: TimelineRow[] = visiblePoints(timeline, showForecast).map((p) => ({
    month: p.month,
    label: formatMonth(p.month),
    phase: p.phase,
    received: p.phase === 'FUTURE' ? undefined : p.received,
    declared: showForecast ? positive(p.declared) : undefined,
    estimated: showForecast ? positive(p.estimated) : undefined,
    average: p.average ?? undefined,
    trend: p.projected ? undefined : (p.trend ?? undefined),
    projection: showForecast && p.projected ? (p.trend ?? undefined) : undefined,
  }));
  const firstProjection = rows.findIndex((r) => r.projection !== undefined);
  const lastFit = firstProjection > 0 ? rows[firstProjection - 1] : undefined;
  if (lastFit?.trend !== undefined) lastFit.projection = lastFit.trend;
  return rows;
}

export function tooltipLinesOfTimeline(row: TimelineRow): TooltipLine[] {
  const lines: TooltipLine[] = [];
  const add = (key: string, label: string, value: number | undefined, kind: TooltipKind) => {
    if (value !== undefined) lines.push({ key, label, value, kind });
  };
  add('received', row.phase === 'CURRENT' ? 'Received so far' : 'Received', row.received, 'received');
  add('declared', 'Forecast · Declared', row.declared, 'declared');
  add('estimated', 'Forecast · Estimated', row.estimated, 'estimated');
  add('average', '12-month average', row.average, 'average');
  add('trend', row.trend === undefined ? 'Trend (projected)' : 'Trend', row.trend ?? row.projection, 'trend');
  return lines;
}

const PHASE_NOTE: Record<TimelinePoint['phase'], string> = { PAST: '', CURRENT: ' · Forecast (month in progress)', FUTURE: ' · Forecast' };

export const TABLE_COLUMNS = ['Period', 'Received', 'Declared', 'Estimated', 'Trend'] as const;

const amount = (value: number | null, ccy: string): string => (value === null ? DASH : formatMoney(value, ccy));

/** Data table rows (Period, Received, Declared, Estimated, Trend); forecast months say "Forecast" in the period so it is not colour-only. */
export function tableRows(points: readonly TimelinePoint[], ccy: string): string[][] {
  return points.map((p) => [
    `${formatMonth(p.month)}${PHASE_NOTE[p.phase]}`,
    amount(p.phase === 'FUTURE' ? null : p.received, ccy),
    amount(p.phase === 'PAST' ? null : p.declared, ccy),
    amount(p.phase === 'PAST' ? null : p.estimated, ccy),
    amount(p.trend, ccy),
  ]);
}

/** "+€ 12,00" / "−€ 3,00": the sign in front of the currency symbol. */
export function signedMoney(value: number, ccy: string): string {
  const text = formatMoney(Math.abs(value), ccy);
  const cents = Math.round(value * 100);
  if (cents === 0) return text;
  return `${cents > 0 ? '+' : '\u2212'}${text}`;
}

/**
 * The parts of the summary line under the chart toggles. `forecast` = the totals of the Future payments card
 * (`summary.forward12m`, `declared`, `estimated`), so the line shows exactly that card's numbers; null = hidden or unavailable.
 */
export function summaryParts(timeline: GrowthTimeline, ccy: string, forecast: ForecastTotals | null): string[] {
  const parts: string[] = [];
  if (forecast) {
    parts.push(`Forecast next 12 months: ${formatMoney(forecast.total, ccy)} (declared ${formatMoney(forecast.declared, ccy)}, estimated ${formatMoney(forecast.estimated, ccy)})`);
  }
  if (timeline.trend) parts.push(`Trend: ${signedMoney(timeline.trend.slopePerYear, ccy)}/month per year`);
  return parts;
}

/** Text alternative of the forecast and trend, appended to the chart's label. */
export function forecastLabel(timeline: GrowthTimeline, ccy: string, forecast: ForecastTotals | null): string {
  const parts = summaryParts(timeline, ccy, forecast);
  return parts.length === 0 ? '' : `${parts.join('. ')}.`;
}

export type SwatchKind = 'year' | 'forecastYear' | 'received' | 'declared' | 'estimated' | 'average' | 'yearAverage' | 'trend' | 'projection';

export interface LegendItem {
  key: string;
  label: string;
  swatch: SwatchKind;
  /** Fill of a `year` / `received` swatch. */
  color?: string;
}

/** Legend of the grouped chart: the years, then what the forecast bars and the average line mean. */
export function yearLegendItems(model: YearForecastModel, colorOf: (year: string) => string): LegendItem[] {
  const items: LegendItem[] = model.years.map((y) => ({ key: y, label: y, swatch: 'year', color: colorOf(y) }));
  for (const y of model.forecastYears) if (!model.years.includes(y)) items.push({ key: `${y}-forecast`, label: `${y} (forecast)`, swatch: 'forecastYear' });
  if (model.forecastYears.length > 0) {
    items.push({ key: 'declared', label: 'Declared (forecast)', swatch: 'declared' }, { key: 'estimated', label: 'Estimated (forecast)', swatch: 'estimated' });
  }
  if (model.hasAverage) items.push({ key: 'average', label: 'Average of years', swatch: 'yearAverage' });
  return items;
}

/** Legend of the timeline: the series that are drawn. */
export function timelineLegendItems(rows: readonly TimelineRow[], received: string): LegendItem[] {
  const items: LegendItem[] = [{ key: 'received', label: 'Received', swatch: 'received', color: received }];
  if (rows.some((r) => r.declared !== undefined)) items.push({ key: 'declared', label: 'Declared (forecast)', swatch: 'declared' });
  if (rows.some((r) => r.estimated !== undefined)) items.push({ key: 'estimated', label: 'Estimated (forecast)', swatch: 'estimated' });
  if (rows.some((r) => r.average !== undefined)) items.push({ key: 'average', label: '12-month average', swatch: 'average' });
  if (rows.some((r) => r.trend !== undefined)) items.push({ key: 'trend', label: 'Trend', swatch: 'trend' });
  if (rows.some((r) => r.projection !== undefined)) items.push({ key: 'projection', label: 'Trend (projected)', swatch: 'projection' });
  return items;
}
