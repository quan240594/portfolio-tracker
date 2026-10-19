/**
 * Usage REST contract: how much of each free-plan cap the personal Cloudflare deployment has used today (UTC day).
 *
 * - GET /usage   the `UsageSnapshot` below. Always answered, also when the budget guard blocks the other routes, so the
 *                owner can see why. Counters reset at 00:00 UTC (`resetsAt`).
 *
 * `percent` is `used / limit * 100` rounded to two decimals (it may exceed 100 when a cap was passed anyway). The state
 * of a metric is `ok` below 60 %, `warn` from 60 % and `blocked` from 80 % of its cap; the overall `state` is the worst
 * of the metrics, or `unavailable` when the usage ledger could not be read (the guard then fails closed).
 */
import { z } from 'zod';

export const USAGE_ROUTES = {
  usage: 'GET /usage',
} as const;

/** Metrics that accumulate during a UTC day and start again at 0 at 00:00 UTC. */
export const USAGE_COUNTER_METRICS = ['workerRequests', 'durableObjectRequests', 'durableObjectGbSeconds', 'rowsRead', 'rowsWritten'] as const;
/** Metrics that are a level, not a sum: they do not reset. */
export const USAGE_GAUGE_METRICS = ['storageBytes'] as const;
export const USAGE_METRICS = [...USAGE_COUNTER_METRICS, ...USAGE_GAUGE_METRICS] as const;

export type UsageCounterMetric = (typeof USAGE_COUNTER_METRICS)[number];
export type UsageGaugeMetric = (typeof USAGE_GAUGE_METRICS)[number];
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_METRIC_LABELS: Record<UsageMetric, string> = {
  workerRequests: 'Worker requests',
  durableObjectRequests: 'Durable Object requests',
  durableObjectGbSeconds: 'Durable Object duration (GB-s)',
  rowsRead: 'Database rows read',
  rowsWritten: 'Database rows written',
  storageBytes: 'Stored data (bytes)',
};

export const USAGE_METRIC_STATES = ['ok', 'warn', 'blocked'] as const;
export type UsageMetricState = (typeof USAGE_METRIC_STATES)[number];

export const USAGE_STATES = [...USAGE_METRIC_STATES, 'unavailable'] as const;
export type UsageState = (typeof USAGE_STATES)[number];

export interface UsageMetricSnapshot {
  used: number;
  limit: number;
  /** `used / limit * 100`, two decimals. */
  percent: number;
  state: UsageMetricState;
}

export interface UsageSnapshot {
  /** The UTC day the counters belong to (YYYY-MM-DD). */
  day: string;
  /** ISO timestamp of this reading. */
  generatedAt: string;
  /** ISO timestamp of the next 00:00 UTC, when the daily counters start again. */
  resetsAt: string;
  state: UsageState;
  /** The percentages at which a metric becomes `warn` and `blocked`. */
  thresholds: { warnPercent: number; blockPercent: number };
  metrics: Record<UsageMetric, UsageMetricSnapshot>;
}

const metricSnapshotSchema = z.object({
  used: z.number().nonnegative(),
  limit: z.number().positive(),
  percent: z.number().nonnegative(),
  state: z.enum(USAGE_METRIC_STATES),
});

const isoInstant = z.string().datetime();

/** Validates a `UsageSnapshot` payload (the web client parses the response of `GET /usage` with it). */
export const usageSnapshotSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: isoInstant,
  resetsAt: isoInstant,
  state: z.enum(USAGE_STATES),
  thresholds: z.object({ warnPercent: z.number(), blockPercent: z.number() }),
  metrics: z.object({
    workerRequests: metricSnapshotSchema,
    durableObjectRequests: metricSnapshotSchema,
    durableObjectGbSeconds: metricSnapshotSchema,
    rowsRead: metricSnapshotSchema,
    rowsWritten: metricSnapshotSchema,
    storageBytes: metricSnapshotSchema,
  }),
});
