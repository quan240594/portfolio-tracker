import { http, HttpResponse } from 'msw';
import { USAGE_METRICS, type UsageMetric, type UsageMetricSnapshot, type UsageMetricState, type UsageSnapshot, type UsageState } from '@portfolio/shared';
import { server } from '../mocks/server';
import { api } from '../mocks/utils';

const LIMITS: Record<UsageMetric, number> = {
  workerRequests: 100_000,
  durableObjectRequests: 100_000,
  durableObjectGbSeconds: 13_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  storageBytes: 1_000_000_000,
};

const stateOf = (percent: number): UsageMetricState => {
  if (percent >= 80) return 'blocked';
  return percent >= 60 ? 'warn' : 'ok';
};

const RANK: Record<UsageMetricState, number> = { ok: 0, warn: 1, blocked: 2 };

export const metric = (metricName: UsageMetric, percent: number): UsageMetricSnapshot => ({
  used: (LIMITS[metricName] * percent) / 100,
  limit: LIMITS[metricName],
  percent,
  state: stateOf(percent),
});

/** A pinned snapshot (day 2026-10-19, reset 2026-10-20T00:00Z); `percents` sets the usage of single metrics, the overall state follows. */
export function usageSnapshot(percents: Partial<Record<UsageMetric, number>> = {}, state?: UsageState): UsageSnapshot {
  const metrics = Object.fromEntries(USAGE_METRICS.map((name) => [name, metric(name, percents[name] ?? 0)])) as Record<UsageMetric, UsageMetricSnapshot>;
  const worst = USAGE_METRICS.map((name) => metrics[name].state).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as UsageMetricState);
  return {
    day: '2026-10-19',
    generatedAt: '2026-10-19T10:00:00.000Z',
    resetsAt: '2026-10-20T00:00:00.000Z',
    state: state ?? worst,
    thresholds: { warnPercent: 60, blockPercent: 80 },
    metrics,
  };
}

export const OK_SNAPSHOT = usageSnapshot({ workerRequests: 12.5 });
export const WARN_SNAPSHOT = usageSnapshot({ workerRequests: 61, rowsRead: 72.5 });
export const BLOCKED_SNAPSHOT = usageSnapshot({ workerRequests: 61, rowsWritten: 80 });
export const UNAVAILABLE_SNAPSHOT = usageSnapshot({}, 'unavailable');

/** Answers `GET /api/usage` with the snapshot, and counts the requests. */
export function serveUsage(snapshot: UsageSnapshot | (() => UsageSnapshot)): { calls: () => number } {
  let calls = 0;
  server.use(
    http.get(api('/usage'), () => {
      calls++;
      return HttpResponse.json(typeof snapshot === 'function' ? snapshot() : snapshot);
    }),
  );
  return { calls: () => calls };
}

/** Answers every other request with the guard's 429 and a Retry-After in seconds. */
export const budgetExhausted = (retryAfter: string | null = '3600') =>
  HttpResponse.json(
    { error: { code: 'BUDGET_EXHAUSTED', message: 'The free-plan budget is used up.', details: { blockedMetrics: ['rowsRead'] } } },
    { status: 429, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } },
  );

export const budgetUnavailable = () =>
  HttpResponse.json({ error: { code: 'BUDGET_UNAVAILABLE', message: 'Usage ledger unreadable.' } }, { status: 503, headers: { 'Retry-After': '60' } });
