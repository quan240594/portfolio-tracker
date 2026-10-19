import { createRequire } from 'node:module';
import initSqlJs, { type Database, type SqlValue as SqlJsValue } from 'sql.js';
import type { AlarmStorageHost, SqlCursor, SqlStorageLike, SqlValue } from '../src/sql.js';

const require = createRequire(import.meta.url);
const sqlJs = initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });

const isWrite = (query: string): boolean => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query);

const fromJs = (value: SqlJsValue): SqlValue =>
  value instanceof Uint8Array ? (value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer) : value;

const toJs = (value: SqlValue): SqlJsValue => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);

/**
 * Test double of a Durable Object's storage: real SQLite (compiled to WebAssembly, BINARY collation like the real thing)
 * behind the structural `SqlStorageLike`/`transactionSync`/alarm surface. It lets the adapters run in Node, where the
 * coverage is measured; `workerd.test.ts` runs the same suites against the real runtime. `rowsRead` is the number of rows
 * returned and `rowsWritten` the rows changed: a lower bound of what Cloudflare counts.
 */
export class SqlJsStorage implements AlarmStorageHost, SqlStorageLike {
  readonly sql: SqlStorageLike = this;
  alarm: number | null = null;
  readonly alarmCalls: number[] = [];
  private depth = 0;

  private constructor(private readonly db: Database) {}

  static async create(): Promise<SqlJsStorage> {
    const SQL = await sqlJs;
    return new SqlJsStorage(new SQL.Database());
  }

  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
    const statement = this.db.prepare(query);
    try {
      statement.bind(bindings.map((value) => toJs(value)));
      const rows: T[] = [];
      while (statement.step()) {
        rows.push(Object.fromEntries(Object.entries(statement.getAsObject()).map(([column, value]) => [column, fromJs(value)])) as T);
      }
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: isWrite(query) ? this.db.getRowsModified() : 0 };
    } finally {
      statement.free();
    }
  }

  transactionSync<T>(closure: () => T): T {
    if (this.depth > 0) return closure();
    this.db.run('BEGIN');
    this.depth++;
    try {
      const result = closure();
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    this.alarmCalls.push(scheduledTime);
    return Promise.resolve();
  }

  /** Every row of a query (for assertions on the stored form). */
  rows<T extends Record<string, SqlValue> = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
    return this.exec<T>(query, ...bindings).toArray();
  }
}

/** A clock tests move by hand. */
export class TestClock {
  constructor(public ms = Date.UTC(2026, 0, 5, 9, 0, 0)) {}

  now = (): Date => new Date(this.ms);

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}
