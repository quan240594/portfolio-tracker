import { USAGE_COUNTER_METRICS, type UsageCounterMetric } from '@portfolio/shared';
import type { UsageCounters, UsageDelta, UsageStore } from '@portfolio/platform';
import { settle } from './settle.js';
import { MeteredSql, type SqlStorageHost, type UsageOptions } from './sql.js';

/**
 * The free-plan usage ledger: one row per UTC day with one column per counter, so a read and an `add` each touch exactly
 * one row. `day` is the `YYYY-MM-DD` string the budget guard uses; the gigabyte-seconds are the only fractional counter.
 */
export const USAGE_SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS usage (
    day TEXT PRIMARY KEY,
    worker_requests INTEGER NOT NULL DEFAULT 0,
    durable_object_requests INTEGER NOT NULL DEFAULT 0,
    durable_object_gb_seconds REAL NOT NULL DEFAULT 0,
    rows_read INTEGER NOT NULL DEFAULT 0,
    rows_written INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`,
] as const;

const COLUMNS: Readonly<Record<UsageCounterMetric, string>> = {
  workerRequests: 'worker_requests',
  durableObjectRequests: 'durable_object_requests',
  durableObjectGbSeconds: 'durable_object_gb_seconds',
  rowsRead: 'rows_read',
  rowsWritten: 'rows_written',
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: string): void {
  if (!DAY_PATTERN.test(day)) throw new RangeError('A usage day must look like YYYY-MM-DD');
}

/** The amount to add for `metric`: 0 when omitted; a negative or non-finite amount is a programming error. */
function amountOf(delta: UsageDelta, metric: UsageCounterMetric): number {
  const amount = delta[metric] ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`The ${metric} amount must be a finite, non-negative number`);
  return amount;
}

/**
 * `UsageStore` on the Durable Object's SQLite. `add` is one `INSERT ... ON CONFLICT DO UPDATE` statement, so it is atomic
 * (the object runs one statement at a time) and creates the day's row on first use. Old days are removed by `prune`.
 */
export class SqlUsageStore implements UsageStore {
  private readonly db: MeteredSql;

  constructor(storage: SqlStorageHost, options: UsageOptions = {}) {
    this.db = new MeteredSql(storage.sql, options.onUsage);
    for (const schema of USAGE_SCHEMAS) this.db.rows(schema);
  }

  add(day: string, delta: UsageDelta): Promise<void> {
    return settle(() => {
      assertDay(day);
      const amounts = USAGE_COUNTER_METRICS.map((metric) => amountOf(delta, metric));
      if (amounts.every((amount) => amount === 0)) return;
      const columns = USAGE_COUNTER_METRICS.map((metric) => COLUMNS[metric]);
      const increments = columns.map((column) => `${column} = ${column} + excluded.${column}`).join(', ');
      this.db.rows(
        `INSERT INTO usage (day, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')}) ON CONFLICT(day) DO UPDATE SET ${increments}`,
        day,
        ...amounts,
      );
    });
  }

  read(day: string): Promise<UsageCounters> {
    return settle(() => {
      assertDay(day);
      const columns = USAGE_COUNTER_METRICS.map((metric) => `${COLUMNS[metric]} AS ${metric}`).join(', ');
      const row = this.db.first<Record<UsageCounterMetric, number>>(`SELECT ${columns} FROM usage WHERE day = ?`, day);
      const counters = {} as UsageCounters;
      for (const metric of USAGE_COUNTER_METRICS) counters[metric] = row?.[metric] ?? 0;
      return counters;
    });
  }

  prune(beforeDay: string): Promise<void> {
    return settle(() => {
      assertDay(beforeDay);
      this.db.rows('DELETE FROM usage WHERE day < ?', beforeDay);
    });
  }
}
