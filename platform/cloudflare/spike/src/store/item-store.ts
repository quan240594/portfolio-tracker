/**
 * The storage primitive of the Cloudflare data-layer model: a single `items(pk, sk, data)` table, the same key scheme
 * as the DynamoDB table (PK/SK strings, entity fields in `data` as JSON).
 *
 * D1 accounting used everywhere in the spike:
 *   queries      = prepared statements sent to the database (each one counts against the Workers Free cap of
 *                  50 subrequests/invocation; whether the statements of one `db.batch()` count once is UNVERIFIED -> the
 *                  design never relies on it)
 *   rowsRead     = rows scanned (for a PRIMARY KEY lookup/range that is exactly the rows returned)
 *   rowsWritten  = rows inserted/updated/deleted (no secondary index exists, so 1 row per write)
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  pk   TEXT NOT NULL,
  sk   TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (pk, sk)
) WITHOUT ROWID;
`;

export interface Row {
  pk: string;
  sk: string;
  data: string;
}

export interface Range {
  /** `sk LIKE prefix%` expressed as a range on the primary key. */
  begins?: string;
  from?: string;
  to?: string;
}

export type BatchOp = { type: 'put'; pk: string; sk: string; data: string } | { type: 'delete'; pk: string; sk: string };

export interface StoreStats {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  /** Statements sent through `batch()` (they are one round trip but several statements). */
  batchedStatements: number;
  /** `batch()` round trips. */
  batches: number;
}

export const emptyStats = (): StoreStats => ({ queries: 0, rowsRead: 0, rowsWritten: 0, batchedStatements: 0, batches: 0 });

/** D1 allows 100 bound parameters per statement: 33 upsert rows (3 params) or 50 delete keys (2 params) per statement. */
export const PUT_ROWS_PER_STATEMENT = 33;
export const DELETE_ROWS_PER_STATEMENT = 50;

/** Groups consecutive ops of the same type into multi-row statements, the way D1 statements are built. */
export function planBatch(ops: readonly BatchOp[]): BatchOp[][] {
  const out: BatchOp[][] = [];
  for (let i = 0; i < ops.length; ) {
    const type = ops[i]!.type;
    const cap = type === 'put' ? PUT_ROWS_PER_STATEMENT : DELETE_ROWS_PER_STATEMENT;
    let j = i;
    while (j < ops.length && ops[j]!.type === type && j - i < cap) j++;
    out.push(ops.slice(i, j) as BatchOp[]);
    i = j;
  }
  return out;
}

export interface ItemStore {
  readonly stats: StoreStats;
  get(pk: string, sk: string): Promise<Row | null>;
  /** Rows of one partition, ascending by sk. */
  query(pk: string, range?: Range): Promise<Row[]>;
  /** Rows of several partitions in ONE statement (`pk IN (...)`), ordered by pk, sk. */
  queryMany(pks: readonly string[], range?: Range): Promise<Row[]>;
  /** Exact keys in ONE statement, e.g. every symbol's PROFILE row. */
  getMany(keys: readonly { pk: string; sk: string }[]): Promise<Row[]>;
  /** Resolves false when `ifNotExists` and the row exists (Dynamo `attribute_not_exists(PK)`). */
  put(pk: string, sk: string, data: string, opts?: { ifNotExists?: boolean }): Promise<boolean>;
  /** Resolves false when `ifExists` and the row is missing. */
  delete(pk: string, sk: string, opts?: { ifExists?: boolean }): Promise<boolean>;
  /** Several puts/deletes as one atomic round trip (D1 `batch()` = one SQL transaction). */
  batch(ops: readonly BatchOp[]): Promise<void>;
}

/** Exclusive upper bound that turns `begins_with(sk, prefix)` into a range on the primary key. */
export const prefixEnd = (prefix: string): string => prefix + '\u{10FFFF}';

export function bounds(range: Range = {}): { lo: string; hi: string } {
  if (range.begins !== undefined) return { lo: range.begins, hi: prefixEnd(range.begins) };
  return { lo: range.from ?? '', hi: range.to ?? '\u{10FFFF}' };
}

/**
 * Statements for an exact-key multi-get. Same pk (e.g. the year rows of one symbol) -> `pk = ? AND sk IN (...)`;
 * same sk (e.g. every symbol's PROFILE) -> `pk IN (...) AND sk = ?`; otherwise a `(pk, sk) IN (VALUES ...)` list.
 * All of them are primary-key searches; 100 bound parameters per statement (D1 limit).
 */
export function multiGetStatements(keys: readonly { pk: string; sk: string }[], maxParams = 100): { sql: string; params: string[] }[] {
  const out: { sql: string; params: string[] }[] = [];
  if (keys.length === 0) return out;
  const pks = [...new Set(keys.map((k) => k.pk))];
  const sks = [...new Set(keys.map((k) => k.sk))];
  const head = 'SELECT pk, sk, data FROM items WHERE';
  if (pks.length === 1) {
    for (let i = 0; i < sks.length; i += maxParams - 1) {
      const part = sks.slice(i, i + maxParams - 1);
      out.push({ sql: `${head} pk = ? AND sk IN (${part.map(() => '?').join(',')})`, params: [pks[0]!, ...part] });
    }
  } else if (sks.length === 1) {
    for (let i = 0; i < pks.length; i += maxParams - 1) {
      const part = pks.slice(i, i + maxParams - 1);
      out.push({ sql: `${head} pk IN (${part.map(() => '?').join(',')}) AND sk = ?`, params: [...part, sks[0]!] });
    }
  } else {
    const per = Math.floor(maxParams / 2);
    for (let i = 0; i < keys.length; i += per) {
      const part = keys.slice(i, i + per);
      out.push({ sql: `${head} (pk, sk) IN (VALUES ${part.map(() => '(?,?)').join(',')})`, params: part.flatMap((k) => [k.pk, k.sk]) });
    }
  }
  return out;
}
