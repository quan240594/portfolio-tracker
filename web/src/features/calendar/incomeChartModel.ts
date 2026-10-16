import { useSyncExternalStore } from 'react';
import type { CalendarMonth } from '@portfolio/shared';
import { selectRows, visibleTotal, type SeriesSelection } from '../../components/charts/selection';
import { formatMoney } from '../../lib/format';

/** Visible names of the stacked series. The API field stays `paid`; the word shown to the user is "Received". */
const SERIES_NAMES: Readonly<Record<string, string>> = { paid: 'Received', declared: 'Declared', estimated: 'Estimated' };
export const seriesName = (key: unknown): string => SERIES_NAMES[String(key)] ?? String(key);

export const INCOME_SERIES = ['paid', 'declared', 'estimated'] as const;
export type IncomeSeries = (typeof INCOME_SERIES)[number];

type IncomeSelection = Pick<SeriesSelection, 'isRowVisible' | 'isSeriesVisible'>;

const cents = (value: number): number => Math.round(value * 100) / 100;

/** The months that are not excluded, with the excluded statuses cleared and each month's total recomputed from what is left. */
export function selectMonths(monthly: readonly CalendarMonth[], selection: IncomeSelection): CalendarMonth[] {
  const everyStatus = INCOME_SERIES.every((key) => selection.isSeriesVisible(key));
  return selectRows(monthly, (m) => m.month, selection).map((m) => {
    if (everyStatus) return m;
    const masked = { ...m, ...Object.fromEntries(INCOME_SERIES.filter((key) => !selection.isSeriesVisible(key)).map((key) => [key, 0])) };
    return { ...masked, total: cents(visibleTotal(m, INCOME_SERIES, selection)) };
  });
}

/** The dashed "avg" line: the supplied figure while everything is shown, otherwise the average over the months and statuses that are left. */
export function selectedAverage(shown: readonly CalendarMonth[], average: number, filtered: boolean): number {
  if (!filtered) return average;
  return shown.length === 0 ? 0 : shown.reduce((sum, m) => sum + m.total, 0) / shown.length;
}

export interface IncomeRow extends CalendarMonth {
  /** Short label above the bar; empty when it is hidden (zero bar or no room on a narrow screen). */
  label: string;
}

/** Totals below this amount (half a euro) round to a zero bar: no label. */
const MIN_LABEL_AMOUNT = 0.5;

export function shortAmount(value: number, currency: string): string {
  return formatMoney(value, currency, value >= 1000 ? { compact: true } : { maxDigits: 0 });
}

/** The label above one bar: empty for a zero bar. */
export function barLabel(total: number, currency: string): string {
  return total < MIN_LABEL_AMOUNT ? '' : shortAmount(total, currency);
}

/** Adds the bar label per month; on narrow screens only every other bar gets one so labels never touch. */
export function incomeRows(monthly: readonly CalendarMonth[], currency: string, narrow: boolean): IncomeRow[] {
  return monthly.map((m, i) => ({ ...m, label: narrow && i % 2 === 1 ? '' : barLabel(m.total, currency) }));
}

const NARROW_QUERY = '(max-width: 640px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = globalThis.matchMedia?.(NARROW_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

const isNarrow = (): boolean => globalThis.matchMedia?.(NARROW_QUERY).matches ?? false;

export function useNarrowScreen(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}
