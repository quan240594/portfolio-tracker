import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SCHEMA, bounds, emptyStats, multiGetStatements, planBatch, type BatchOp, type ItemStore, type Range, type Row, type StoreStats } from './item-store.ts';

/** Max bound parameters per D1 statement (D1 limits: 100). */
export const MAX_PARAMS = 100;

interface Planned {
  sql: string;
  plan: string[];
}

/**
 * node:sqlite implementation of the items table. SQLite is the engine D1 and SQLite-backed Durable Objects run, so
 * query plans (EXPLAIN QUERY PLAN) and the stored layout are representative; row counters follow the D1 definitions
 * in item-store.ts (rows scanned == rows returned for primary-key lookups and ranges, which the plan check proves).
 */
export class SqliteItemStore implements ItemStore {
  readonly stats: StoreStats = emptyStats();
  readonly db: DatabaseSync;
  /** Distinct statements used, with their EXPLAIN QUERY PLAN, to prove index/PK use. */
  readonly plans = new Map<string, Planned>();
  private readonly cache = new Map<string, StatementSync>();

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
    this.db.exec(SCHEMA);
  }

  resetStats(): void {
    Object.assign(this.stats, emptyStats());
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** Records the plan of a statement the first time it is seen (parameters are bound to representative values). */
  private note(label: string, sql: string, params: (string | number)[]): void {
    if (this.plans.has(label)) return;
    const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
    this.plans.set(label, { sql, plan: rows.map((r) => r.detail) });
  }

  bulkLoad(rows: readonly Row[]): void {
    const ins = this.db.prepare('INSERT OR REPLACE INTO items (pk, sk, data) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    for (const r of rows) ins.run(r.pk, r.sk, r.data);
    this.db.exec('COMMIT');
  }

  rowCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM items').get() as { n: number }).n;
  }

  get(pk: string, sk: string): Promise<Row | null> {
    const sql = 'SELECT pk, sk, data FROM items WHERE pk = ? AND sk = ?';
    this.note('get', sql, [pk, sk]);
    this.stats.queries++;
    const r = this.stmt(sql).get(pk, sk) as unknown as Row | undefined;
    if (r) this.stats.rowsRead++;
    return Promise.resolve(r ?? null);
  }

  query(pk: string, range?: Range): Promise<Row[]> {
    const { lo, hi } = bounds(range);
    const sql = 'SELECT pk, sk, data FROM items WHERE pk = ? AND sk >= ? AND sk < ? ORDER BY sk';
    this.note('query(pk, sk range)', sql, [pk, lo, hi]);
    this.stats.queries++;
    const rows = this.stmt(sql).all(pk, lo, hi) as unknown as Row[];
    this.stats.rowsRead += rows.length;
    return Promise.resolve(rows);
  }

  queryMany(pks: readonly string[], range?: Range): Promise<Row[]> {
    const { lo, hi } = bounds(range);
    const out: Row[] = [];
    const chunk = MAX_PARAMS - 2;
    for (let i = 0; i < pks.length; i += chunk) {
      const part = pks.slice(i, i + chunk);
      const sql = `SELECT pk, sk, data FROM items WHERE pk IN (${part.map(() => '?').join(',')}) AND sk >= ? AND sk < ? ORDER BY pk, sk`;
      this.note(`queryMany(pk IN (...), sk range) n=${part.length > 1 ? 'N' : 1}`, sql, [...part, lo, hi]);
      this.stats.queries++;
      const rows = this.stmt(sql).all(...part, lo, hi) as unknown as Row[];
      this.stats.rowsRead += rows.length;
      out.push(...rows);
    }
    return Promise.resolve(out);
  }

  getMany(keys: readonly { pk: string; sk: string }[]): Promise<Row[]> {
    const out: Row[] = [];
    for (const { sql, params } of multiGetStatements(keys, MAX_PARAMS)) {
      this.note(`getMany(${sql.includes('(pk, sk) IN') ? '(pk, sk) IN VALUES' : sql.includes('pk = ?') ? 'pk = ? AND sk IN (...)' : 'pk IN (...) AND sk = ?'})`, sql, params);
      this.stats.queries++;
      const rows = this.stmt(sql).all(...params) as unknown as Row[];
      this.stats.rowsRead += rows.length;
      out.push(...rows);
    }
    return Promise.resolve(out);
  }

  put(pk: string, sk: string, data: string, opts: { ifNotExists?: boolean } = {}): Promise<boolean> {
    this.stats.queries++;
    if (opts.ifNotExists) {
      const sql = 'INSERT INTO items (pk, sk, data) VALUES (?, ?, ?) ON CONFLICT (pk, sk) DO NOTHING';
      this.note('put if not exists', sql, [pk, sk, data]);
      const res = this.stmt(sql).run(pk, sk, data);
      this.stats.rowsWritten += Number(res.changes);
      return Promise.resolve(Number(res.changes) > 0);
    }
    const sql = 'INSERT INTO items (pk, sk, data) VALUES (?, ?, ?) ON CONFLICT (pk, sk) DO UPDATE SET data = excluded.data';
    this.note('put (upsert)', sql, [pk, sk, data]);
    this.stmt(sql).run(pk, sk, data);
    this.stats.rowsWritten++;
    return Promise.resolve(true);
  }

  delete(pk: string, sk: string, opts: { ifExists?: boolean } = {}): Promise<boolean> {
    const sql = 'DELETE FROM items WHERE pk = ? AND sk = ?';
    this.note('delete', sql, [pk, sk]);
    this.stats.queries++;
    const res = this.stmt(sql).run(pk, sk);
    this.stats.rowsWritten += Number(res.changes);
    return Promise.resolve(opts.ifExists ? Number(res.changes) > 0 : true);
  }

  /** One round trip = one SQL transaction of multi-row statements (33 upserts / 50 deletes each, D1's 100-parameter cap). */
  batch(ops: readonly BatchOp[]): Promise<void> {
    const groups = planBatch(ops);
    this.stats.queries += groups.length;
    this.stats.batchedStatements += groups.length;
    this.stats.batches++;
    this.db.exec('BEGIN');
    try {
      for (const g of groups) {
        if (g[0]!.type === 'put') {
          const sql = `INSERT INTO items (pk, sk, data) VALUES ${g.map(() => '(?,?,?)').join(',')} ON CONFLICT (pk, sk) DO UPDATE SET data = excluded.data`;
          const params = g.flatMap((o) => (o.type === 'put' ? [o.pk, o.sk, o.data] : []));
          this.note(`batch: multi-row upsert (n=${g.length === 33 ? 33 : 'k'})`, sql, params);
          const res = this.stmt(sql).run(...params);
          this.stats.rowsWritten += Number(res.changes);
        } else {
          const sql = `DELETE FROM items WHERE (pk, sk) IN (VALUES ${g.map(() => '(?,?)').join(',')})`;
          const params = g.flatMap((o) => [o.pk, o.sk]);
          this.note(`batch: multi-row delete (n=${g.length === 50 ? 50 : 'k'})`, sql, params);
          const res = this.stmt(sql).run(...params);
          this.stats.rowsWritten += Number(res.changes);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve();
  }

  /** Runs `fn` atomically (small transactions); statements inside count normally. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    return fn().then(
      (v) => (this.db.exec('COMMIT'), v),
      (e) => (this.db.exec('ROLLBACK'), Promise.reject(e)),
    );
  }
}
