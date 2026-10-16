import type { SeriesSelection } from './useSeriesSelection';

/** Applying a selection to chart data. Pure functions: the charts stay plain recharts charts fed with the visible data. */

type RowSelection = Pick<SeriesSelection, 'isRowVisible'>;
type SeriesVisibility = Pick<SeriesSelection, 'isSeriesVisible'>;

/** The rows (categories) that are not excluded; the chart's axes then scale to what is left. */
export function selectRows<T>(rows: readonly T[], idOf: (row: T) => string, selection: RowSelection): T[] {
  return rows.filter((row) => selection.isRowVisible(idOf(row)));
}

/** The series keys that are not excluded, in their original order. */
export function visibleKeys(keys: readonly string[], selection: SeriesVisibility): string[] {
  return keys.filter((key) => selection.isSeriesVisible(key));
}

/** One colour per key by its position among ALL keys, so a series keeps its colour while others are hidden. */
export function stableColours(keys: readonly string[], palette: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key, i) => [key, palette[i % palette.length]!]));
}

/** A copy of `row` whose hidden series fields are cleared (undefined), so a tooltip or total built from the row ignores them. */
export function maskSeries<T extends object>(row: T, keys: readonly string[], selection: SeriesVisibility): T {
  const hidden = keys.filter((key) => !selection.isSeriesVisible(key));
  if (hidden.length === 0) return row;
  const masked: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of hidden) masked[key] = undefined;
  return masked as T;
}

/** Sum of the numeric series fields of `row` that are visible. */
export function visibleTotal(row: object, keys: readonly string[], selection: SeriesVisibility): number {
  const fields = row as Record<string, unknown>;
  return visibleKeys(keys, selection).reduce((sum, key) => {
    const value = fields[key];
    return typeof value === 'number' ? sum + value : sum;
  }, 0);
}

export interface SliceLike {
  key: string;
  value: number;
}

/** Slices that stay in the donut with their share of the VISIBLE total (0..1). */
export function visibleSlices<T extends SliceLike>(slices: readonly T[], selection: SeriesVisibility): (T & { share: number })[] {
  const shown = slices.filter((s) => selection.isSeriesVisible(s.key));
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  return shown.map((s) => ({ ...s, share: total > 0 ? s.value / total : 0 }));
}

/** Total of the slices that are not excluded: the donut's centre figure. */
export function visibleSliceTotal(slices: readonly SliceLike[], selection: SeriesVisibility): number {
  return slices.filter((s) => selection.isSeriesVisible(s.key)).reduce((sum, s) => sum + s.value, 0);
}
