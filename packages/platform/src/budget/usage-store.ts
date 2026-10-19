import type { UsageCounterMetric } from '@portfolio/shared';

/** Increments for one call of `UsageStore.add`; omitted metrics are unchanged. */
export type UsageDelta = Partial<Record<UsageCounterMetric, number>>;

/** Every counter of one UTC day (0 for a day nothing was recorded). */
export type UsageCounters = Record<UsageCounterMetric, number>;

/**
 * Where the guard keeps its daily counters. The Cloudflare adapter implements it on the Durable Object's SQLite (one
 * row per UTC day keeps a read at 1 row and a write at 1 row); `MemoryUsageStore` is the reference. Must pass
 * `runUsageStoreContract` from `@portfolio/platform/testing`.
 *
 * Days are `YYYY-MM-DD` strings in UTC (see `utcDay`). Counters of one day never influence another.
 */
export interface UsageStore {
  /** Atomically adds `delta` to the counters of `day`: concurrent calls never lose an increment. */
  add(day: string, delta: UsageDelta): Promise<void>;
  /** Reads every counter of `day`; a day without data reads as all zeros. The result is a copy. */
  read(day: string): Promise<UsageCounters>;
  /** Deletes every day strictly before `beforeDay` (a no-op when there is nothing to delete). */
  prune(beforeDay: string): Promise<void>;
}
