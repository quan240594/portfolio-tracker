/**
 * ItemStore on the real D1 binding API (prepare/bind/all/run/batch). Same SQL as the node:sqlite store.
 * Row accounting comes from D1's own `meta.rows_read` / `meta.rows_written` where the runtime returns them.
 */
import { bounds, emptyStats, multiGetStatements, planBatch, type BatchOp, type ItemStore, type Range, type Row, type StoreStats } from '../store/item-store.ts';

interface D1Meta {
  rows_read?: number;
  rows_written?: number;
  changes?: number;
}
interface D1Result<T = Row> {
  results?: T[];
  meta?: D1Meta;
}
interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  all<T = Row>(): Promise<D1Result<T>>;
  first<T = Row>(): Promise<T | null>;
  run(): Promise<D1Result>;
}
export interface D1Like {
  prepare(sql: string): D1Prepared;
  batch<T = unknown>(statements: D1Prepared[]): Promise<D1Result<T>[]>;
}

const MAX_PARAMS = 100;
const UP = 'INSERT INTO items (pk, sk, data) VALUES %V ON CONFLICT (pk, sk) DO UPDATE SET data = excluded.data';

export class D1ItemStore implements ItemStore {
  readonly stats: StoreStats = emptyStats();
  /** Rows read / written as reported by D1 itself (0 when the runtime does not report them). */
  readonly meta = { rowsRead: 0, rowsWritten: 0 };

  constructor(private readonly db: D1Like) {}

  private track(meta: D1Meta | undefined): void {
    this.meta.rowsRead += meta?.rows_read ?? 0;
    this.meta.rowsWritten += meta?.rows_written ?? 0;
  }

  async get(pk: string, sk: string): Promise<Row | null> {
    this.stats.queries++;
    const res = await this.db.prepare('SELECT pk, sk, data FROM items WHERE pk = ? AND sk = ?').bind(pk, sk).all();
    this.track(res.meta);
    const r = res.results?.[0] ?? null;
    if (r) this.stats.rowsRead++;
    return r;
  }

  async query(pk: string, range?: Range): Promise<Row[]> {
    const { lo, hi } = bounds(range);
    this.stats.queries++;
    const res = await this.db.prepare('SELECT pk, sk, data FROM items WHERE pk = ? AND sk >= ? AND sk < ? ORDER BY sk').bind(pk, lo, hi).all();
    this.track(res.meta);
    this.stats.rowsRead += res.results?.length ?? 0;
    return res.results ?? [];
  }

  async queryMany(pks: readonly string[], range?: Range): Promise<Row[]> {
    const { lo, hi } = bounds(range);
    const out: Row[] = [];
    for (let i = 0; i < pks.length; i += MAX_PARAMS - 2) {
      const part = pks.slice(i, i + MAX_PARAMS - 2);
      this.stats.queries++;
      const res = await this.db
        .prepare(`SELECT pk, sk, data FROM items WHERE pk IN (${part.map(() => '?').join(',')}) AND sk >= ? AND sk < ? ORDER BY pk, sk`)
        .bind(...part, lo, hi)
        .all();
      this.track(res.meta);
      this.stats.rowsRead += res.results?.length ?? 0;
      out.push(...(res.results ?? []));
    }
    return out;
  }

  async getMany(keys: readonly { pk: string; sk: string }[]): Promise<Row[]> {
    const out: Row[] = [];
    for (const { sql, params } of multiGetStatements(keys, MAX_PARAMS)) {
      this.stats.queries++;
      const res = await this.db.prepare(sql).bind(...params).all();
      this.track(res.meta);
      this.stats.rowsRead += res.results?.length ?? 0;
      out.push(...(res.results ?? []));
    }
    return out;
  }

  async put(pk: string, sk: string, data: string, opts: { ifNotExists?: boolean } = {}): Promise<boolean> {
    this.stats.queries++;
    const sql = opts.ifNotExists
      ? 'INSERT INTO items (pk, sk, data) VALUES (?, ?, ?) ON CONFLICT (pk, sk) DO NOTHING'
      : UP.replace('%V', '(?, ?, ?)');
    const res = await this.db.prepare(sql).bind(pk, sk, data).run();
    this.track(res.meta);
    const changed = res.meta?.changes ?? 1;
    this.stats.rowsWritten += changed;
    return opts.ifNotExists ? changed > 0 : true;
  }

  async delete(pk: string, sk: string, opts: { ifExists?: boolean } = {}): Promise<boolean> {
    this.stats.queries++;
    const res = await this.db.prepare('DELETE FROM items WHERE pk = ? AND sk = ?').bind(pk, sk).run();
    this.track(res.meta);
    const changed = res.meta?.changes ?? 0;
    this.stats.rowsWritten += changed;
    return opts.ifExists ? changed > 0 : true;
  }

  /** Multi-row statements (33 upserts / 50 deletes each, 100 bound parameters max) sent as one `db.batch()` round trip. */
  async batch(ops: readonly BatchOp[]): Promise<void> {
    const statements: D1Prepared[] = planBatch(ops).map((part) => {
      if (part[0]!.type === 'put') {
        const sql = UP.replace('%V', part.map(() => '(?,?,?)').join(','));
        return this.db.prepare(sql).bind(...part.flatMap((o) => (o.type === 'put' ? [o.pk, o.sk, o.data] : [])));
      }
      return this.db.prepare(`DELETE FROM items WHERE (pk, sk) IN (VALUES ${part.map(() => '(?,?)').join(',')})`).bind(...part.flatMap((o) => [o.pk, o.sk]));
    });
    this.stats.queries += statements.length;
    this.stats.batchedStatements += statements.length;
    this.stats.batches++;
    for (const r of await this.db.batch(statements)) {
      this.track(r.meta);
      this.stats.rowsWritten += r.meta?.changes ?? 0;
    }
  }
}
