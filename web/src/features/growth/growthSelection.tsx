import { useMemo } from 'react';
import { LegendSwatch, type LegendEntry, type SeriesSelection } from '../../components/charts/selection';

type SeriesVisibility = Pick<SeriesSelection, 'isSeriesVisible'>;

/** A line of a Growth or asset chart as the legend, the table columns and the selection see it. */
export interface LineSeries {
  /** Selection key: `portfolio`, `invested`, the asset's `price` or a benchmark symbol. */
  key: string;
  label: string;
  color: string;
  /** Figure shown after the label in the legend. */
  detail?: string;
  dashed?: boolean;
}

/** Legend entries of the series: a swatch in the series colour, a line (default) or a square for bars. */
export const legendEntries = (series: readonly LineSeries[], shape: 'line' | 'square' = 'line'): LegendEntry[] =>
  series.map(({ key, label, color, detail, dashed }) => ({ key, label, detail, swatch: <LegendSwatch shape={shape} color={color} dashed={dashed} /> }));

export const seriesKeys = (series: readonly Pick<LineSeries, 'key'>[]): string[] => series.map((s) => s.key);

/** The benchmarks that are not excluded; their colour comes from their index in the response, so it never shifts. */
export const visibleBenchmarks = <T extends { symbol: string }>(benchmarks: readonly T[], selection: SeriesVisibility): T[] =>
  benchmarks.filter((b) => selection.isSeriesVisible(b.symbol));

/**
 * `visibleBenchmarks`, memoised on the include/exclude state only: the preview (hover / focus) re-renders the card but keeps the same
 * array, so the chart data derived from it is not rebuilt.
 */
export function useVisibleBenchmarks<T extends { symbol: string }>(benchmarks: readonly T[], selection: SeriesVisibility): T[] {
  const { isSeriesVisible } = selection;
  return useMemo(() => visibleBenchmarks(benchmarks, { isSeriesVisible }), [benchmarks, isSeriesVisible]);
}

/** Labels of the series that are not excluded. */
export const shownLabels = (series: readonly LineSeries[], selection: SeriesVisibility): string[] => series.filter((s) => selection.isSeriesVisible(s.key)).map((s) => s.label);

/** Text alternative of a filtered chart: what it covers and which series are left. */
export const selectionSummary = (subject: string, span: string, shown: readonly string[]): string => `${subject} ${span}, current selection: ${shown.join(', ')}.`;
