/**
 * Trend and forecast of the dividends under the "Dividend growth" chart. Pure: it takes the net amount received per
 * month (`GET /analytics/dividend-growth` → `byMonth`) and the months ahead of `GET /dividends/overview`
 * (`futureMonths`), so the forecast bars add up to `summary.forward12m` of the same overview and the received bars to the
 * chart's data table.
 *
 * - History = every complete month from the first dividend month to the month before `today` (gaps count as 0). The
 *   current month is partial and never takes part in the average or the trend.
 * - Trailing average = mean of the (up to) last 12 history months, drawn from the 6th history month on.
 * - Linear trend = ordinary least squares over the last (up to) 24 history months (x = 0…n-1, y = amount received),
 *   needs at least 6 months of history; projected over the current and the future months and clamped at 0.
 * An extrapolation, not a promise: dividends can be cut, skipped or raised. Not investment advice.
 */
import { roundTo } from './analytics.js';

const MONTHS = 12;
/** The trend and the averages need this many complete months of history. */
export const TREND_MIN_MONTHS = 6;
/** The linear trend is fitted on at most this many of the most recent complete months. */
export const TREND_FIT_MONTHS = 24;
/** Window of the trailing average. */
export const AVERAGE_WINDOW_MONTHS = 12;

export interface MonthAmount {
  /** `YYYY-MM`. */
  month: string;
  total: number;
}

export interface ForecastMonthInput {
  /** `YYYY-MM`. */
  month: string;
  declared: number;
  estimated: number;
}

/** PAST = complete month, CURRENT = the month of `today` (received so far + still expected), FUTURE = after it. */
export type TimelinePhase = 'PAST' | 'CURRENT' | 'FUTURE';

export interface TimelinePoint {
  month: string;
  phase: TimelinePhase;
  /** Net received (0 in FUTURE months). */
  received: number;
  declared: number;
  estimated: number;
  /** Trailing average of the received months; null before enough history, in the current and in future months. */
  average: number | null;
  /** Fitted (fit window) or projected (current and future months) trend, ≥ 0; null without a trend. */
  trend: number | null;
  /** True when `trend` lies after the last complete month. */
  projected: boolean;
}

export interface LinearFit {
  slope: number;
  intercept: number;
}

export interface DividendTrend {
  /** First and last month of the fit window (`YYYY-MM`) and its length. */
  from: string;
  to: string;
  months: number;
  /** Change of the monthly income per month (base currency), raw (not clamped). */
  slopePerMonth: number;
  /** `slopePerMonth × 12`: how much the monthly income rises (or falls) per year. */
  slopePerYear: number;
}

export interface ForecastTotals {
  declared: number;
  estimated: number;
  total: number;
}

export interface GrowthTimeline {
  /** `YYYY-MM-DD`. */
  asOf: string;
  /** Complete months from the first dividend month. */
  historyMonths: number;
  /** One per month: history, the current month, then the forecast months; empty without any data. */
  points: TimelinePoint[];
  /** Null with fewer than `TREND_MIN_MONTHS` months of history. */
  trend: DividendTrend | null;
  /** Sum of the forecast months handed in (declared + estimated, current month included). */
  forecast: ForecastTotals;
}

const monthIndex = (month: string): number => Number(month.slice(0, 4)) * MONTHS + Number(month.slice(5, 7)) - 1;
const monthKey = (index: number): string => `${Math.floor(index / MONTHS)}-${String((index % MONTHS) + 1).padStart(2, '0')}`;
const toCents = (amount: number): number => Math.round(amount * 100);

/** Least-squares line `y = intercept + slope · x` through the values at x = 0…n-1; null with fewer than two values. */
export function linearFit(values: readonly number[]): LinearFit | null {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, y) => sum + y, 0) / n;
  let covariance = 0;
  let variance = 0;
  values.forEach((y, x) => {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  });
  const slope = covariance / variance;
  return { slope, intercept: meanY - slope * meanX };
}

/** Every complete month from the first month of `byMonth` to the month before `today`, gaps filled with 0. Months from the current one on are ignored. */
export function completeHistory(byMonth: readonly MonthAmount[], today: string): MonthAmount[] {
  const current = monthIndex(today);
  const totals = new Map<number, number>();
  for (const m of byMonth) totals.set(monthIndex(m.month), (totals.get(monthIndex(m.month)) ?? 0) + m.total);
  const first = Math.min(...totals.keys());
  if (!Number.isFinite(first) || first >= current) return [];
  return Array.from({ length: current - first }, (_, i) => ({ month: monthKey(first + i), total: roundTo(totals.get(first + i) ?? 0) }));
}

/** Mean of the up-to-12 months ending at each history month; null before the 6th month of history. */
export function trailingAverages(history: readonly MonthAmount[]): (number | null)[] {
  return history.map((_, i) => {
    if (i + 1 < TREND_MIN_MONTHS) return null;
    const recent = history.slice(Math.max(0, i + 1 - AVERAGE_WINDOW_MONTHS), i + 1);
    return roundTo(recent.reduce((sum, m) => sum + m.total, 0) / recent.length);
  });
}

/** Per calendar month (index 0 = January) the mean over the given years in which that month is a complete history month; null with fewer than 2 such years or fewer than 6 months of history. */
export function averageByCalendarMonth(history: readonly MonthAmount[], years: readonly string[]): (number | null)[] {
  const none = Array.from({ length: MONTHS }, () => null);
  if (history.length < TREND_MIN_MONTHS) return none;
  return none.map((_, i) => {
    const observed = history.filter((m) => Number(m.month.slice(5, 7)) - 1 === i && years.includes(m.month.slice(0, 4)));
    return observed.length < 2 ? null : roundTo(observed.reduce((sum, m) => sum + m.total, 0) / observed.length);
  });
}

function trendOf(history: readonly MonthAmount[]): { info: DividendTrend; fit: LinearFit } | null {
  if (history.length < TREND_MIN_MONTHS) return null;
  const recent = history.slice(-TREND_FIT_MONTHS);
  const fit = linearFit(recent.map((m) => m.total))!;
  const info: DividendTrend = {
    from: recent[0]!.month,
    to: recent.at(-1)!.month,
    months: recent.length,
    slopePerMonth: roundTo(fit.slope, 4),
    slopePerYear: roundTo(fit.slope * MONTHS),
  };
  return { info, fit };
}

const emptyPoint = (month: string, phase: TimelinePhase): TimelinePoint => ({ month, phase, received: 0, declared: 0, estimated: 0, average: null, trend: null, projected: false });

/** The trend line value (clamped at 0) in month `index`; `x0` = the history month index of x = 0. */
const trendAt = (fit: LinearFit, x0: number, index: number): number => roundTo(Math.max(0, fit.intercept + fit.slope * (index - x0)));

type TrendFit = NonNullable<ReturnType<typeof trendOf>>;

/** Past months: received, trailing average and, inside the fit window, the trend line. */
function historyPoints(history: readonly MonthAmount[], averages: readonly (number | null)[], trend: TrendFit | null, x0: number, lastWindow: number): TimelinePoint[] {
  return history.map((m, i) => {
    const index = monthIndex(m.month);
    const inWindow = trend !== null && index >= x0 && index <= lastWindow;
    return { ...emptyPoint(m.month, 'PAST'), received: m.total, average: averages[i] ?? null, trend: inWindow ? trendAt(trend.fit, x0, index) : null };
  });
}

/** The current month and the forecast months: what is still to come plus the projected trend. */
function forwardPoints(
  indices: readonly number[],
  ahead: ReadonlyMap<number, ForecastMonthInput>,
  now: { current: number; receivedNow: number },
  trend: TrendFit | null,
  x0: number,
): TimelinePoint[] {
  return indices.map((index) => {
    const f = ahead.get(index);
    const isCurrent = index === now.current;
    return {
      ...emptyPoint(monthKey(index), isCurrent ? 'CURRENT' : 'FUTURE'),
      received: isCurrent ? now.receivedNow : 0,
      declared: f?.declared ?? 0,
      estimated: f?.estimated ?? 0,
      trend: trend ? trendAt(trend.fit, x0, index) : null,
      projected: trend !== null,
    };
  });
}

/** Chronological monthly series (received, forecast, trailing average, trend) and the figures that go with it. */
export function buildGrowthTimeline(byMonth: readonly MonthAmount[], future: readonly ForecastMonthInput[], today: string): GrowthTimeline {
  const current = monthIndex(today);
  const history = completeHistory(byMonth, today);
  const averages = trailingAverages(history);
  const trend = trendOf(history);
  const x0 = trend ? monthIndex(trend.info.from) : 0;
  const lastWindow = trend ? monthIndex(trend.info.to) : 0;

  const points: TimelinePoint[] = historyPoints(history, averages, trend, x0, lastWindow);

  const ahead = new Map<number, ForecastMonthInput>();
  for (const f of future) if (monthIndex(f.month) >= current) ahead.set(monthIndex(f.month), f);
  const receivedNow = roundTo(byMonth.filter((m) => monthIndex(m.month) === current).reduce((sum, m) => sum + m.total, 0));
  const hasData = history.length > 0 || receivedNow > 0 || ahead.size > 0;
  const indices = [...new Set([current, ...ahead.keys()])].sort((a, b) => a - b);
  if (hasData) points.push(...forwardPoints(indices, ahead, { current, receivedNow }, trend, x0));

  const declared = [...ahead.values()].reduce((sum, f) => sum + toCents(f.declared), 0);
  const estimated = [...ahead.values()].reduce((sum, f) => sum + toCents(f.estimated), 0);
  return {
    asOf: today,
    historyMonths: history.length,
    points,
    trend: trend?.info ?? null,
    forecast: { declared: declared / 100, estimated: estimated / 100, total: (declared + estimated) / 100 },
  };
}
