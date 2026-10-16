import { useCallback, useEffect, useMemo, useState } from 'react';
import { activeFocus, allHidden, pruneKeys, toggleKey } from './selectionState';

/** What the legend, the table and the chart share: which series (columns, legend entries) and which rows (categories) are hidden. */
export interface SeriesSelection {
  /** Hidden series keys that still exist in the data. */
  hiddenSeries: ReadonlySet<string>;
  /** Hidden row ids that still exist in the data. */
  hiddenRows: ReadonlySet<string>;
  isSeriesVisible: (key: string) => boolean;
  isRowVisible: (id: string) => boolean;
  toggleSeries: (key: string) => void;
  toggleRow: (id: string) => void;
  /** Something is excluded: the chart no longer shows everything. */
  hasHidden: boolean;
  /** Every series, or every row, is excluded: there is nothing to draw. */
  nothingSelected: boolean;
  /** "Show all". */
  reset: () => void;
  /**
   * The legend entry the pointer or the keyboard is on (hover / focus preview), or null. Transient: never persisted, never changes what is
   * included, and null while that entry is excluded. The chart dims everything that does not belong to it (`focusOpacity`).
   */
  focusKey: string | null;
  /** Sets or clears (null) the previewed legend entry; the `SelectableLegend` calls it. */
  setFocus: (key: string | null) => void;
}

/** The part of the selection the legend and the table need (so tests and other callers can pass a small object). */
export type SelectionView = Pick<SeriesSelection, 'isSeriesVisible' | 'isRowVisible' | 'toggleSeries' | 'toggleRow' | 'hasHidden' | 'reset'> & Partial<Pick<SeriesSelection, 'focusKey' | 'setFocus'>>;

/** The include/exclude half of the selection: stable while only the hover / focus preview changes. */
type SelectionBase = Omit<SeriesSelection, 'focusKey' | 'setFocus'>;

const NONE: ReadonlySet<string> = new Set();

const SEPARATOR = '\u0000';

function useHiddenKeys(valid: readonly string[]) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NONE);
  // callers build the key lists on every render: rebuild them only when their content changes
  const signature = valid.join(SEPARATOR);
  const keys = useMemo(() => (signature === '' ? [] : signature.split(SEPARATOR)), [signature]);
  const validSet = useMemo(() => new Set(keys), [keys]);
  // Keys that left the data (another portfolio, another period) are forgotten, so they come back visible.
  useEffect(() => {
    setHidden((current) => pruneKeys(current, validSet));
  }, [validSet]);
  const effective = useMemo(() => pruneKeys(hidden, validSet), [hidden, validSet]);
  const toggle = useCallback((key: string) => setHidden((current) => toggleKey(current, key)), []);
  const clear = useCallback(() => setHidden(NONE), []);
  return { hidden: effective, keys, toggle, clear };
}

/** The transient hover / keyboard focus of a legend entry; it follows `hidden` so an excluded entry has no focus. */
function useLegendFocus(hidden: ReadonlySet<string>) {
  const [focus, setFocus] = useState<string | null>(null);
  return { focusKey: activeFocus(focus, hidden), setFocus };
}

/**
 * Include/exclude state of one chart card, in memory only.
 * `seriesKeys` = the series the chart can draw (legend entries, value columns of the table); `rowIds` = its categories (table rows).
 * Hidden keys that disappear from the data are dropped; ones that are still there survive a data change (e.g. another portfolio).
 */
export function useSeriesSelection(seriesKeys: readonly string[], rowIds: readonly string[] = []): SeriesSelection {
  const series = useHiddenKeys(seriesKeys);
  const rows = useHiddenKeys(rowIds);
  const { focusKey, setFocus } = useLegendFocus(series.hidden);
  const { clear: clearSeries } = series;
  const { clear: clearRows } = rows;
  const reset = useCallback(() => {
    clearSeries();
    clearRows();
  }, [clearSeries, clearRows]);
  const base = useMemo<SelectionBase>(
    () => ({
      hiddenSeries: series.hidden,
      hiddenRows: rows.hidden,
      isSeriesVisible: (key) => !series.hidden.has(key),
      isRowVisible: (id) => !rows.hidden.has(id),
      toggleSeries: series.toggle,
      toggleRow: rows.toggle,
      hasHidden: series.hidden.size > 0 || rows.hidden.size > 0,
      nothingSelected: allHidden(series.keys, series.hidden) || allHidden(rows.keys, rows.hidden),
      reset,
    }),
    [series.hidden, series.keys, series.toggle, rows.hidden, rows.keys, rows.toggle, reset],
  );
  // the preview changes on every hover: the include/exclude functions above keep their identity, so memoised chart data stays valid
  return useMemo(() => ({ ...base, focusKey, setFocus }), [base, focusKey, setFocus]);
}

/**
 * Selection of a donut (parts of a whole): a slice is both a legend entry and a table row, so the legend and the table
 * toggle the same state. Use `isSeriesVisible(key)` / `isRowVisible(key)` interchangeably.
 */
export function useSliceSelection(sliceKeys: readonly string[]): SeriesSelection {
  const slices = useHiddenKeys(sliceKeys);
  const { focusKey, setFocus } = useLegendFocus(slices.hidden);
  const base = useMemo<SelectionBase>(
    () => ({
      hiddenSeries: slices.hidden,
      hiddenRows: slices.hidden,
      isSeriesVisible: (key) => !slices.hidden.has(key),
      isRowVisible: (key) => !slices.hidden.has(key),
      toggleSeries: slices.toggle,
      toggleRow: slices.toggle,
      hasHidden: slices.hidden.size > 0,
      nothingSelected: allHidden(slices.keys, slices.hidden),
      reset: slices.clear,
    }),
    [slices.hidden, slices.keys, slices.toggle, slices.clear],
  );
  return useMemo(() => ({ ...base, focusKey, setFocus }), [base, focusKey, setFocus]);
}
