import { bounds, emptyStats, multiGetStatements, planBatch, type BatchOp, type ItemStore, type Range, type Row, type StoreStats } from './item-store.ts';

interface Partition {
  /** Rows ascending by sk. */
  rows: Row[];
}

const lowerBound = (rows: readonly Row[], sk: string): number => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.sk < sk) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * In-memory table with the same observable behaviour as the SQLite one: rows are kept as JSON TEXT and decoded by the
 * caller, like the `data` column of D1. `wire: true` additionally models the way D1 hands rows to the Worker (one JSON
 * document per result set whose `data` cells are escaped JSON strings): an extra JSON.parse per query.
 */
export class MemoryItemStore implements ItemStore {
  readonly stats: StoreStats = emptyStats();
  private readonly parts = new Map<string, Partition>();
  /** `wire` rows: pre-serialised result rows so the stringify side is not charged to the handler. */
  private readonly wireRows = new WeakMap<Row, string>();

  constructor(private readonly opts: { wire?: boolean } = {}) {}

  resetStats(): void {
    Object.assign(this.stats, emptyStats());
  }

  /** Bulk load (not counted): appends and sorts once. */
  load(rows: readonly Row[]): void {
    const touched = new Set<Partition>();
    for (const r of rows) {
      let p = this.parts.get(r.pk);
      if (!p) this.parts.set(r.pk, (p = { rows: [] }));
      p.rows.push(r);
      touched.add(p);
    }
    for (const p of touched) p.rows.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    if (this.opts.wire) for (const r of rows) this.wireRows.set(r, JSON.stringify(r));
  }

  rowCount(): number {
    let n = 0;
    for (const p of this.parts.values()) n += p.rows.length;
    return n;
  }

  private find(pk: string, sk: string): Row | undefined {
    const p = this.parts.get(pk);
    if (!p) return undefined;
    const i = lowerBound(p.rows, sk);
    const r = p.rows[i];
    return r && r.sk === sk ? r : undefined;
  }

  /** Result decode: a copy of the row, plus the wire round trip in `wire` mode. */
  private out(rows: Row[]): Row[] {
    this.stats.rowsRead += rows.length;
    if (!this.opts.wire || rows.length === 0) return rows.map((r) => ({ ...r }));
    return JSON.parse(`[${rows.map((r) => this.wireRows.get(r) ?? JSON.stringify(r)).join(',')}]`) as Row[];
  }

  private slice(pk: string, range?: Range): Row[] {
    const p = this.parts.get(pk);
    if (!p) return [];
    const { lo, hi } = bounds(range);
    const out: Row[] = [];
    for (let i = lowerBound(p.rows, lo); i < p.rows.length; i++) {
      const r = p.rows[i]!;
      if (r.sk >= hi) break;
      out.push(r);
    }
    return out;
  }

  get(pk: string, sk: string): Promise<Row | null> {
    this.stats.queries++;
    const r = this.find(pk, sk);
    return Promise.resolve(r ? this.out([r])[0]! : null);
  }

  query(pk: string, range?: Range): Promise<Row[]> {
    this.stats.queries++;
    return Promise.resolve(this.out(this.slice(pk, range)));
  }

  queryMany(pks: readonly string[], range?: Range): Promise<Row[]> {
    this.stats.queries++;
    return Promise.resolve(this.out([...pks].sort().flatMap((pk) => this.slice(pk, range))));
  }

  getMany(keys: readonly { pk: string; sk: string }[]): Promise<Row[]> {
    this.stats.queries += multiGetStatements(keys).length;
    const rows = keys.map((k) => this.find(k.pk, k.sk)).filter((r): r is Row => r !== undefined);
    return Promise.resolve(this.out(rows));
  }

  private upsert(pk: string, sk: string, data: string): void {
    let p = this.parts.get(pk);
    if (!p) this.parts.set(pk, (p = { rows: [] }));
    const i = lowerBound(p.rows, sk);
    const row = { pk, sk, data };
    if (p.rows[i]?.sk === sk) p.rows[i] = row;
    else p.rows.splice(i, 0, row);
    if (this.opts.wire) this.wireRows.set(row, JSON.stringify(row));
    this.stats.rowsWritten++;
  }

  private remove(pk: string, sk: string): boolean {
    const p = this.parts.get(pk);
    if (!p) return false;
    const i = lowerBound(p.rows, sk);
    if (p.rows[i]?.sk !== sk) return false;
    p.rows.splice(i, 1);
    this.stats.rowsWritten++;
    return true;
  }

  put(pk: string, sk: string, data: string, opts: { ifNotExists?: boolean } = {}): Promise<boolean> {
    this.stats.queries++;
    if (opts.ifNotExists && this.find(pk, sk)) return Promise.resolve(false);
    this.upsert(pk, sk, data);
    return Promise.resolve(true);
  }

  delete(pk: string, sk: string, opts: { ifExists?: boolean } = {}): Promise<boolean> {
    this.stats.queries++;
    const existed = this.remove(pk, sk);
    return Promise.resolve(opts.ifExists ? existed : true);
  }

  batch(ops: readonly BatchOp[]): Promise<void> {
    const statements = planBatch(ops).length;
    this.stats.queries += statements;
    this.stats.batchedStatements += statements;
    this.stats.batches++;
    for (const op of ops) {
      if (op.type === 'put') this.upsert(op.pk, op.sk, op.data);
      else this.remove(op.pk, op.sk);
    }
    return Promise.resolve();
  }
}
