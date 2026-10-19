import { USAGE_METRICS, USAGE_METRIC_LABELS, type UsageMetric, type UsageMetricState, type UsageSnapshot, type UsageState } from '@portfolio/shared';
import { formatCount, formatPercent } from '../../lib/format';

/** Short text of the overall state; it always accompanies the status icon, colour is never the only signal. */
export const STATE_CHIP_TEXT: Record<UsageState, string> = {
  ok: 'Usage OK',
  warn: 'Usage high',
  blocked: 'Paused',
  unavailable: 'Usage unknown',
};

export const METRIC_STATE_TEXT: Record<UsageMetricState, string> = {
  ok: 'OK',
  warn: 'High',
  blocked: 'Paused',
};

/** Worse states sort higher; used to tell whether a state worsened. */
export const STATE_RANK: Record<UsageState, number> = { ok: 0, unavailable: 1, warn: 2, blocked: 3 };

export interface MetricRow {
  metric: UsageMetric;
  label: string;
  state: UsageMetricState;
  percent: number;
  /** "1.234 of 100.000 (1,2%)" in the app locale. */
  summary: string;
}

/** Counters get up to two decimals (GB-s), everything else is a whole number. */
const digitsFor = (metric: UsageMetric) => (metric === 'durableObjectGbSeconds' ? 2 : 0);

export function metricRows(snapshot: UsageSnapshot): MetricRow[] {
  return USAGE_METRICS.map((metric) => {
    const { used, limit, percent, state } = snapshot.metrics[metric];
    const digits = digitsFor(metric);
    return {
      metric,
      label: USAGE_METRIC_LABELS[metric],
      state,
      percent,
      summary: `${formatCount(used, digits)} of ${formatCount(limit, digits)} (${formatPercent(percent, { digits: 1 })})`,
    };
  });
}

export const metricsInState = (snapshot: UsageSnapshot, state: UsageMetricState): UsageMetric[] =>
  USAGE_METRICS.filter((metric) => snapshot.metrics[metric].state === state);

/** The stored-data gauge does not reset at midnight, so waiting for the reset does not help when only it is blocked. */
export function onlyStorageBlocked(snapshot: UsageSnapshot): boolean {
  const blocked = metricsInState(snapshot, 'blocked');
  return blocked.length > 0 && blocked.every((metric) => metric === 'storageBytes');
}
