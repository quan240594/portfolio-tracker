/**
 * The slice of the Durable Object storage API the adapters use, declared structurally so this package needs no
 * Cloudflare type package and the adapters run against any implementation (the real `ctx.storage`, a test double).
 */
export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlCursor<T> {
  /** Drains the cursor into an array. */
  toArray(): T[];
  /** Rows the statement read (final once the cursor is drained). Index lookups count as rows read, too. */
  readonly rowsRead: number;
  /** Rows the statement wrote (a secondary index entry counts as a row). */
  readonly rowsWritten: number;
}

/** `ctx.storage.sql` of a SQLite-backed Durable Object. */
export interface SqlStorageLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** `ctx.storage` of a SQLite-backed Durable Object, restricted to what the store adapters need. */
export interface SqlStorageHost {
  readonly sql: SqlStorageLike;
  /** Runs `closure` as one atomic transaction. The closure must be synchronous: no `await`, or the writes are not atomic. */
  transactionSync<T>(closure: () => T): T;
}

/** `ctx.storage` including the alarm API the job queue needs. */
export interface AlarmStorageHost extends SqlStorageHost {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** Rows touched by statements: the unit Cloudflare bills a Durable Object's SQLite storage in. */
export interface SqlUsage {
  rowsRead: number;
  rowsWritten: number;
}

export type UsageSink = (delta: SqlUsage) => void;

export interface UsageOptions {
  /** Called after every statement that read or wrote rows, with the rows of that statement. */
  onUsage?: UsageSink;
}

/** Runs statements and reports the rows they touched. Every adapter goes through this. */
export class MeteredSql {
  constructor(
    private readonly sql: SqlStorageLike,
    private readonly onUsage?: UsageSink,
  ) {}

  rows<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    const { rowsRead, rowsWritten } = cursor;
    if (rowsRead > 0 || rowsWritten > 0) this.onUsage?.({ rowsRead, rowsWritten });
    return rows;
  }

  /** The first row of the statement, if any. */
  first<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T | undefined {
    return this.rows<T>(query, ...bindings)[0];
  }
}
