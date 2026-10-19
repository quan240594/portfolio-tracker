import { USAGE_COUNTER_METRICS, type UsageCounterMetric, type UsageMetric, type UsageMetricState } from '@portfolio/shared';

/**
 * Cloudflare Free-plan caps the personal deployment is designed against. Docs date: 2026-10-18; sources: the Cloudflare
 * developer docs pages "Workers > Platform > Limits", "Durable Objects > Platform > Limits" and "Durable Objects >
 * Platform > Pricing" (the Free-plan columns), cross-checked with the measurements in docs/architecture.md ("Cloudflare
 * limits probe"). Counters of the daily caps reset at 00:00 UTC.
 *
 * Storage: 5 GB is the account total, 1 GB the size of one object; the deployment has a single Durable Object, so the
 * per-object cap binds first and is the one the guard measures. Sizes use decimal GB (the smaller, safer number).
 */
export const FREE_PLAN_LIMITS = {
  /** Worker requests per UTC day. */
  workerRequestsPerDay: 100_000,
  /** Durable Object requests per UTC day (HTTP/RPC calls, alarm invocations, WebSocket messages). */
  durableObjectRequestsPerDay: 100_000,
  /** Durable Object wall-clock duration per UTC day, in gigabyte-seconds (a 128 MB object running 1 s = 0.128 GB-s). */
  durableObjectGbSecondsPerDay: 13_000,
  /** SQLite rows read per UTC day. */
  sqliteRowsReadPerDay: 5_000_000,
  /** SQLite rows written per UTC day. */
  sqliteRowsWrittenPerDay: 100_000,
  /** Durable Object storage of the whole account, in bytes. */
  durableObjectStorageBytesPerAccount: 5_000_000_000,
  /** Durable Object storage of one object, in bytes. */
  durableObjectStorageBytesPerObject: 1_000_000_000,
  /** Subrequests (outbound fetches) per Worker/Durable Object invocation. A per-invocation cap, not a daily counter. */
  subrequestsPerInvocation: 50,
} as const;

export type MetricLimits = Readonly<Record<UsageMetric, number>>;

/** The cap each tracked metric is measured against. */
export const METRIC_LIMITS: MetricLimits = {
  workerRequests: FREE_PLAN_LIMITS.workerRequestsPerDay,
  durableObjectRequests: FREE_PLAN_LIMITS.durableObjectRequestsPerDay,
  durableObjectGbSeconds: FREE_PLAN_LIMITS.durableObjectGbSecondsPerDay,
  rowsRead: FREE_PLAN_LIMITS.sqliteRowsReadPerDay,
  rowsWritten: FREE_PLAN_LIMITS.sqliteRowsWrittenPerDay,
  storageBytes: FREE_PLAN_LIMITS.durableObjectStorageBytesPerObject,
};

/** A metric is `warn` from 60 % of its cap and `blocked` from 80 %: the 20 % headroom absorbs work already in flight and counters the app cannot see. */
export const BUDGET_THRESHOLDS = { warnPercent: 60, blockPercent: 80 } as const;

/** Memory billed for a Durable Object (it is fixed at 128 MB). */
export const DURABLE_OBJECT_MEMORY_GB = 0.128;

/** Gigabyte-seconds billed for a Durable Object that was active `durationMs` milliseconds. */
export function durableObjectGbSeconds(durationMs: number): number {
  return (Math.max(0, durationMs) / 1000) * DURABLE_OBJECT_MEMORY_GB;
}

const COUNTERS: readonly string[] = USAGE_COUNTER_METRICS;

export function isCounterMetric(metric: UsageMetric): metric is UsageCounterMetric {
  return COUNTERS.includes(metric);
}

/** Classifies `used` against `limit` with exact integer arithmetic at the thresholds (60 % of 100,000 is `warn`). */
export function classifyUsage(used: number, limit: number): UsageMetricState {
  if (used * 100 >= limit * BUDGET_THRESHOLDS.blockPercent) return 'blocked';
  if (used * 100 >= limit * BUDGET_THRESHOLDS.warnPercent) return 'warn';
  return 'ok';
}

/** Percentage of the cap, two decimals; a cap of 0 (or less) counts as fully used. */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.round((used / limit) * 10_000) / 100;
}

const DAY_MS = 86_400_000;

/** The UTC day (`YYYY-MM-DD`) of an instant: the unit of every daily cap. */
export function utcDay(now: Date | number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The next 00:00 UTC strictly after `now`, when the daily counters start again. */
export function nextUtcMidnight(now: Date | number): Date {
  const time = new Date(now).getTime();
  return new Date(time - (time % DAY_MS) + DAY_MS);
}

/** Whole seconds until the next 00:00 UTC (at least 1), the value for a `Retry-After` header. */
export function secondsUntilReset(now: Date | number): number {
  return Math.max(1, Math.ceil((nextUtcMidnight(now).getTime() - new Date(now).getTime()) / 1000));
}

/** The UTC day `days` before `day`. */
export function utcDayBefore(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`).getTime() - days * DAY_MS);
}
