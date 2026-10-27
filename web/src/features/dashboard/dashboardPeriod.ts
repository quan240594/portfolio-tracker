import { useCallback, useState } from 'react';
import { DASHBOARD_PERIODS, type DashboardPeriod, type PeriodPerformance } from '@portfolio/shared';
import { formatDate } from '../../lib/format';

export const DEFAULT_PERIOD: DashboardPeriod = 'all';
/** One plain key, so a later modular layout can keep its own settings next to it. */
export const PERIOD_STORAGE_KEY = 'pt-dashboard-period';

export const PERIOD_LABELS: Readonly<Record<DashboardPeriod, string>> = { ttm: 'TTM', ytd: 'YTD', '5y': '5 years', '10y': '10 years', all: 'All time' };
export const PERIOD_OPTIONS = DASHBOARD_PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }));

const PERIOD_PHRASES: Readonly<Record<DashboardPeriod, string>> = {
  ttm: 'Last 12 months',
  ytd: 'Year to date',
  '5y': 'Last 5 years',
  '10y': 'Last 10 years',
  all: 'All time',
};

/** Shown on cards that do not follow the period (title and accessible description, not visible text). */
export const SNAPSHOT_NOTE = 'Not affected by period';
export const TTM_NOTE = 'Always the trailing 12 months, whatever period is selected';

const isPeriod = (v: string | null): v is DashboardPeriod => v !== null && (DASHBOARD_PERIODS as readonly string[]).includes(v);

export function readStoredPeriod(): DashboardPeriod {
  try {
    const v = localStorage.getItem(PERIOD_STORAGE_KEY);
    return isPeriod(v) ? v : DEFAULT_PERIOD;
  } catch {
    return DEFAULT_PERIOD;
  }
}

function storePeriod(period: DashboardPeriod) {
  try {
    localStorage.setItem(PERIOD_STORAGE_KEY, period);
  } catch {
    // Storage unavailable (e.g. private mode): the choice then lasts until the page closes.
  }
}

/** The selected dashboard period, remembered in localStorage. */
export function useDashboardPeriod(): readonly [DashboardPeriod, (period: DashboardPeriod) => void] {
  const [period, setPeriod] = useState(readStoredPeriod);
  const choose = useCallback((next: DashboardPeriod) => {
    setPeriod(next);
    storePeriod(next);
  }, []);
  return [period, choose];
}

/** The value of the `?period=` query: "all time" is the plain, unparameterised request. */
export const queryPeriod = (period: DashboardPeriod): DashboardPeriod | undefined => (period === 'all' ? undefined : period);

/** What a windowed figure covers: the period, or the real range when the history is shorter than the period. */
export function coverageLabel(period: DashboardPeriod, pp: Pick<PeriodPerformance, 'truncated' | 'from'>): string {
  if (pp.truncated && pp.from) return `Since ${formatDate(pp.from)}, the start of your history (shorter than the period)`;
  return PERIOD_PHRASES[period];
}
