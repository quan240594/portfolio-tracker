import { downsampleEvenly, seriesExtremes, type AssetHistoryResponse, type AssetMarkerType } from '@portfolio/shared';
import { formatDate, formatMoney, formatPercent } from '../../lib/format';
import { MARKER_LABELS, uniqueKeys } from './assetFormat';

export type ChartMode = 'performance' | 'price';

/** One chart row per series point: `date`, `value` (percent change or close) and `b{i}` for the i-th benchmark. */
export type ChartRow = Record<string, string | number | null>;

export const benchKey = (index: number): string => `b${index}`;

/** Benchmarks that have data, by their index in the response (index = colour and column key). */
export const availableBenchmarks = (data: AssetHistoryResponse): { symbol: string; index: number }[] =>
  data.benchmarks.flatMap((b, index) => (b.available ? [{ symbol: b.symbol, index }] : []));

/** Benchmarks are percent changes, so they only share an axis with the performance view. */
export function chartRows(data: AssetHistoryResponse, mode: ChartMode): ChartRow[] {
  return data.points.map((p, i) => {
    const row: ChartRow = { date: p.date, value: mode === 'price' ? p.close : p.pct };
    if (mode === 'performance') for (const b of availableBenchmarks(data)) row[benchKey(b.index)] = data.benchmarks[b.index]!.points[i]?.returnPct ?? null;
    return row;
  });
}

export interface PlottedMarker {
  key: string;
  type: AssetMarkerType;
  /** Series date the marker is drawn at. */
  x: string;
  y: number;
  label: string;
}

/** Markers that fall on a plotted row, with a text label (also used for the accessible list). */
export function plottedMarkers(data: AssetHistoryResponse, rows: readonly ChartRow[]): PlottedMarker[] {
  const byDate = new Map(rows.map((r) => [String(r.date), Number(r.value)]));
  const keys = uniqueKeys(data.markers, (m) => [m.date, m.type, m.portfolioId, m.quantity, m.price].join('-'));
  return data.markers.flatMap((m, i) => {
    const y = byDate.get(m.plotDate);
    if (y === undefined) return [];
    return [{ key: keys[i]!, type: m.type, x: m.plotDate, y, label: `${MARKER_LABELS[m.type]} ${formatDate(m.date)}` }];
  });
}

export interface Extreme {
  date: string;
  value: number;
}

/** Lowest and highest value of the plotted line; null for an empty series. */
export function chartExtremes(rows: readonly ChartRow[]): { min: Extreme | null; max: Extreme | null } {
  const { min, max } = seriesExtremes(rows, (r) => Number(r.value));
  const at = (e: { index: number; value: number } | null): Extreme | null => (e ? { date: String(rows[e.index]!.date), value: e.value } : null);
  return { min: at(min), max: at(max) };
}

/** Label side of a min/max dot: above/below it, or beside it near the plot edges so the text is never cut off. */
export function labelPosition(rows: readonly ChartRow[], date: string, vertical: 'top' | 'bottom'): 'top' | 'bottom' | 'left' | 'right' {
  const share = rows.length > 1 ? rows.findIndex((r) => r.date === date) / (rows.length - 1) : 0.5;
  if (share > 0.8) return 'left';
  return share < 0.2 ? 'right' : vertical;
}

export const formatChartValue = (mode: ChartMode, currency: string) => (value: number) =>
  mode === 'price' ? formatMoney(value, currency, { maxDigits: value < 1 ? 6 : 2 }) : formatPercent(value, { signed: true });

export const chartTooltip =
  (mode: ChartMode, currency: string) =>
  (value: unknown, name: unknown): [string, string] => [formatChartValue(mode, currency)(Number(value)), String(name)];

/** Text alternative of the chart. */
export function chartSummary(data: AssetHistoryResponse, mode: ChartMode): string {
  const first = data.points[0];
  const last = data.points.at(-1);
  if (!first || !last) return `No price history is stored for ${data.symbol} in this period.`;
  const span = `from ${formatDate(first.date)} to ${formatDate(last.date)}`;
  if (mode === 'price') {
    return `Closing price of ${data.symbol} ${span}: ${formatMoney(first.close, data.currency)} to ${formatMoney(last.close, data.currency)} (${formatPercent(last.pct, { signed: true })}).`;
  }
  return `Price change of ${data.symbol} ${span}: ${formatPercent(last.pct, { signed: true })}.`;
}

type Bench = { symbol: string; index: number };

const percent = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : formatChartValue('performance', '')(value));

function tableColumns(data: AssetHistoryResponse, mode: ChartMode, bench: readonly Bench[]): string[] {
  const own = mode === 'price' ? ['Close', 'Change'] : [data.symbol];
  return ['Date', ...own, ...bench.map((b) => b.symbol)];
}

function tableRow(data: AssetHistoryResponse, mode: ChartMode, bench: readonly Bench[], i: number): string[] {
  const p = data.points[i]!;
  const own = mode === 'price' ? [formatMoney(p.close, data.currency, { maxDigits: p.close < 1 ? 6 : 2 }), percent(p.pct)] : [percent(p.pct)];
  return [formatDate(p.date), ...own, ...bench.map((b) => percent(data.benchmarks[b.index]!.points[i]?.returnPct))];
}

/** Evenly sampled rows for the data-table alternative of the chart. */
export function chartTableRows(data: AssetHistoryResponse, mode: ChartMode, max: number): { columns: string[]; rows: string[][] } {
  const bench = mode === 'performance' ? availableBenchmarks(data) : [];
  const indexes = downsampleEvenly(
    data.points.map((_, i) => i),
    max,
  );
  return { columns: tableColumns(data, mode, bench), rows: indexes.map((i) => tableRow(data, mode, bench, i)) };
}
