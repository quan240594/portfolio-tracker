import type { AnalyticsGrowthResponse, GrowthBenchmark, GrowthHeadline, GrowthMonthRow, GrowthRange } from '@portfolio/shared';
import type { Theme } from '../../theme/ThemeProvider';
import { LOCALE, formatDate, formatMoney, formatMonth, formatPercent, trendOf, type Trend } from '../../lib/format';

export const RANGE_LABELS: Record<GrowthRange, string> = { '7D': '7D', '1M': '1M', '3M': '3M', '6M': '6M', YTD: 'YTD', '1Y': '1Y', '5Y': '5Y', ALL: 'All' };

export const TREND_ARROWS: Record<Trend, string> = { up: '▲', down: '▼', flat: '■' };
export const arrowOf = (value: number): string => TREND_ARROWS[trendOf(value)];

/** Benchmark line colours (portfolio keeps the brand indigo); distinct in light and dark mode. */
export const benchmarkColors = (theme: Theme): string[] =>
  theme === 'dark' ? ['#fbbf24', '#2dd4bf', '#f472b6'] : ['#d97706', '#0d9488', '#db2777'];

const pointsFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

/** "Your portfolio is ahead of IWDA.AS by € 1.234,00 (3,4 percentage points) since 02-01-2025." */
export function headlineText(h: GrowthHeadline, currency: string): string {
  const since = `since ${formatDate(h.from)}`;
  if (h.amount === 0 && h.differencePct === 0) return `Your portfolio is level with ${h.symbol} ${since}.`;
  const direction = h.amount > 0 || (h.amount === 0 && h.differencePct > 0) ? 'ahead of' : 'behind';
  const gap = `${formatMoney(Math.abs(h.amount), currency)} (${pointsFormat.format(Math.abs(h.differencePct))} percentage points)`;
  return `Your portfolio is ${direction} ${h.symbol} by ${gap} ${since}.`;
}

/** One chart row per series point: `value`/`invested`/`returnPct` plus `v{i}`/`r{i}` for the i-th benchmark. */
export type GrowthRow = Record<string, string | number | null>;

export const valueKey = (index: number): string => `v${index}`;
export const returnKey = (index: number): string => `r${index}`;

export function growthRows(data: AnalyticsGrowthResponse): GrowthRow[] {
  return data.series.map((p, i) => {
    const row: GrowthRow = { date: p.date, value: p.value, invested: p.invested, returnPct: p.returnPct };
    data.benchmarks.forEach((b, k) => {
      row[valueKey(k)] = b.points[i]?.value ?? null;
      row[returnKey(k)] = b.points[i]?.returnPct ?? null;
    });
    return row;
  });
}

/** Last value of a benchmark series, null when it has no data. */
export const lastBenchmarkValue = (b: GrowthBenchmark, key: 'value' | 'returnPct'): number | null => b.points.at(-1)?.[key] ?? null;

/** First value of a benchmark series, null when it has no data. */
export const firstBenchmarkValue = (b: GrowthBenchmark, key: 'value' | 'returnPct'): number | null => b.points[0]?.[key] ?? null;

export const DYNAMICS_LAST_12M = '12M';

/** `12M` + every calendar year with monthly data, newest year last. */
export const dynamicsOptions = (monthly: readonly GrowthMonthRow[]): { value: string; label: string }[] => {
  const years = [...new Set(monthly.map((m) => m.month.slice(0, 4)))];
  return [{ value: DYNAMICS_LAST_12M, label: 'Last 12 months' }, ...years.map((y) => ({ value: y, label: y }))];
};

/** Months of the selection: the latest 12, or the months of one calendar year. */
export const dynamicsMonths = (monthly: readonly GrowthMonthRow[], selection: string): GrowthMonthRow[] =>
  selection === DYNAMICS_LAST_12M ? monthly.slice(-12) : monthly.filter((m) => m.month.startsWith(selection));

export const monthShortLabel = (month: string): string => formatMonth(month);

/** Benchmarks that have data, with their index in the response (index = colour and column key). */
export const availableBenchmarks = (data: AnalyticsGrowthResponse): { symbol: string; index: number }[] =>
  data.benchmarks.flatMap((b, index) => (b.available ? [{ symbol: b.symbol, index }] : []));

/** Evenly sampled rows for the data-table alternative of a chart. */
export const TABLE_ROWS = 24;

const NICE_STEPS = [1, 2, 5, 10];

/** Round axis bounds and ticks (multiples of 1/2/5 × 10ⁿ) around the values and zero; `headroom` adds room for labels. */
export function niceAxis(values: readonly number[], headroom = 0, target = 5): { domain: [number, number]; ticks: number[]; digits: number } {
  const min = Math.min(0, ...values) * (1 + headroom);
  const max = Math.max(0, ...values) * (1 + headroom);
  const raw = Math.max(max - min, 1e-9) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = (NICE_STEPS.find((s) => s * magnitude >= raw) ?? 10) * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { domain: [lo, hi], ticks, digits: step < 1 ? 1 : 0 };
}

/** First date of each distinct month (thinned to at most `max`), so a long axis never repeats a month label. */
export function monthTicks(dates: readonly string[], max = 8): string[] {
  const firsts = dates.filter((d, i) => i === 0 || d.slice(0, 7) !== dates[i - 1]!.slice(0, 7));
  const every = Math.ceil(firsts.length / max);
  return firsts.filter((_, i) => i % every === 0);
}

/** Axis tick for a percentage with the number of decimals the tick step needs. */
export const percentTickWith = (digits: number) => (v: number) => formatPercent(v, { digits });
