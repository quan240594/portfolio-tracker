import {
  assertValidPatch,
  decodeCursor,
  encodeCursor,
  evaluateCondition,
  type BatchOp,
  type Item,
  type ItemKey,
  type ItemPage,
  type ItemPatch,
  type ItemQuery,
  type ItemStore,
  type ReadOptions,
  type SortKeyCondition,
  type WriteOptions,
} from '@portfolio/platform';
import { settle } from './settle.js';
import { MeteredSql, type SqlStorageHost, type UsageOptions } from './sql.js';

/**
 * The single table behind the ItemStore port.
 *
 * Collation: `pk` and `sk` are TEXT with SQLite's default BINARY collation, which compares the UTF-8 bytes of the
 * strings. That is exactly the sort order of DynamoDB sort keys (UTF-8 byte order), so a range, a `beginsWith` prefix
 * and the descending order return the same items in the same order as the AWS adapter. Do not add a `COLLATE NOCASE`
 * or a locale collation to these columns.
 *
 * `WITHOUT ROWID` makes the primary key the table's only b-tree: a point read or a range scan of one partition touches
 * only the rows it returns, and a write touches one row (a secondary index would add a written row to every write).
 */
export const ITEMS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS items (pk TEXT NOT NULL, sk TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (pk, sk)) WITHOUT ROWID';

const SELECT_ONE = 'SELECT data FROM items WHERE pk = ? AND sk = ?';
const UPSERT = 'INSERT INTO items (pk, sk, data) VALUES (?, ?, ?) ON CONFLICT (pk, sk) DO UPDATE SET data = excluded.data';
const DELETE_ONE = 'DELETE FROM items WHERE pk = ? AND sk = ?';

type DataRow = { data: string };
type ItemRow = { sk: string; data: string };

/** `data` holds every attribute except the key; `undefined` attributes vanish in `JSON.stringify`. */
const serialize = ({ PK: _pk, SK: _sk, ...attributes }: Item): string => JSON.stringify(attributes);

const toItem = (key: ItemKey, data: string): Item => ({ ...(JSON.parse(data) as Record<string, unknown>), PK: key.PK, SK: key.SK });

/**
 * The smallest string that is greater than every string starting with `prefix` (code point order, which is also UTF-8
 * byte order), or undefined when no such bound exists (empty prefix, or only U+10FFFF characters).
 */
export function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix, (char) => char.codePointAt(0)!);
  while (points.length > 0) {
    const last = points.pop()!;
    if (last === 0x10ffff) continue;
    // Surrogate code points are not characters: jump over them.
    points.push(last === 0xd7ff ? 0xe000 : last + 1);
    return String.fromCodePoint(...points);
  }
  return undefined;
}

interface Where {
  clauses: string[];
  bindings: string[];
}

function sortKeyRange(condition: SortKeyCondition | undefined): Where {
  if (!condition) return { clauses: [], bindings: [] };
  if ('beginsWith' in condition) {
    const upper = prefixUpperBound(condition.beginsWith);
    return upper === undefined
      ? { clauses: ['sk >= ?'], bindings: [condition.beginsWith] }
      : { clauses: ['sk >= ?', 'sk < ?'], bindings: [condition.beginsWith, upper] };
  }
  if ('between' in condition) return { clauses: ['sk >= ?', 'sk <= ?'], bindings: [...condition.between] };
  if ('gte' in condition) return { clauses: ['sk >= ?'], bindings: [condition.gte] };
  return { clauses: ['sk <= ?'], bindings: [condition.lte] };
}

/**
 * ItemStore on the SQLite database of a Durable Object (`ctx.storage`).
 *
 * A Durable Object runs one request at a time and `transactionSync` is atomic, so evaluating a write condition in
 * JavaScript against the row read inside the same transaction is as atomic as DynamoDB's conditional expressions.
 * Statements are parameterised: user values only ever travel as bindings, never inside the SQL text.
 * Reads are always consistent, so `consistent` is ignored.
 */
export class SqlItemStore implements ItemStore {
  private readonly db: MeteredSql;

  constructor(
    private readonly storage: SqlStorageHost,
    options: UsageOptions = {},
  ) {
    this.db = new MeteredSql(storage.sql, options.onUsage);
    this.db.rows(ITEMS_SCHEMA);
  }

  get(key: ItemKey, _options?: ReadOptions): Promise<Item | undefined> {
    return settle(() => this.read(key));
  }

  getMany(keys: readonly ItemKey[]): Promise<Item[]> {
    // One indexed lookup per key: an in-process SQLite call is cheap and touches exactly the rows asked for.
    return settle(() => keys.flatMap((key) => this.read(key) ?? []));
  }

  put(item: Item, options?: WriteOptions): Promise<boolean> {
    return settle(() => {
      if (!options?.condition) {
        this.write(item);
        return true;
      }
      return this.storage.transactionSync(() => {
        if (!evaluateCondition(this.read(item), options.condition!)) return false;
        this.write(item);
        return true;
      });
    });
  }

  update(key: ItemKey, patch: ItemPatch, options?: WriteOptions): Promise<Item | undefined> {
    return settle(() => {
      assertValidPatch(patch);
      return this.storage.transactionSync(() => {
        const current = this.read(key);
        if (options?.condition && !evaluateCondition(current, options.condition)) return undefined;
        const next: Item = { ...current, PK: key.PK, SK: key.SK };
        for (const [attr, value] of Object.entries(patch.setIfAbsent ?? {})) if (next[attr] === undefined) next[attr] = value;
        Object.assign(next, patch.set);
        for (const attr of patch.remove ?? []) delete next[attr];
        this.write(next);
        // Round-trip through the stored form, so the result is exactly what a later `get` returns.
        return toItem(key, serialize(next));
      });
    });
  }

  delete(key: ItemKey, options?: WriteOptions): Promise<boolean> {
    return settle(() => {
      if (!options?.condition) {
        this.db.rows(DELETE_ONE, key.PK, key.SK);
        return true;
      }
      return this.storage.transactionSync(() => {
        if (!evaluateCondition(this.read(key), options.condition!)) return false;
        this.db.rows(DELETE_ONE, key.PK, key.SK);
        return true;
      });
    });
  }

  query(query: ItemQuery): Promise<ItemPage> {
    return settle(() => this.page(query));
  }

  batchWrite(operations: readonly BatchOp[]): Promise<void> {
    return settle(() => {
      this.storage.transactionSync(() => {
        for (const op of operations) {
          if (op.type === 'put') this.write(op.item);
          else this.db.rows(DELETE_ONE, op.key.PK, op.key.SK);
        }
      });
    });
  }

  private read(key: ItemKey): Item | undefined {
    const row = this.db.first<DataRow>(SELECT_ONE, key.PK, key.SK);
    return row ? toItem(key, row.data) : undefined;
  }

  private write(item: Item): void {
    this.db.rows(UPSERT, item.PK, item.SK, serialize(item));
  }

  private page(query: ItemQuery): ItemPage {
    const { limit, reverse, cursor } = query;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new RangeError('The query limit must be a positive integer');
    const { clauses, bindings } = sortKeyRange(query.sk);
    if (cursor !== undefined) {
      const after = decodeCursor<{ SK?: unknown }>(cursor).SK;
      if (typeof after !== 'string') throw new Error('Invalid query cursor');
      clauses.push(reverse ? 'sk < ?' : 'sk > ?');
      bindings.push(after);
    }
    // Only constant fragments are joined into the statement; every value is a binding.
    const select = ['SELECT sk, data FROM items WHERE', ['pk = ?', ...clauses].join(' AND '), 'ORDER BY sk', reverse ? 'DESC' : 'ASC'];
    // One row beyond the page tells whether another page exists, so a cursor is only returned when there is more.
    const rows =
      limit === undefined
        ? this.db.rows<ItemRow>(select.join(' '), query.pk, ...bindings)
        : this.db.rows<ItemRow>([...select, 'LIMIT ?'].join(' '), query.pk, ...bindings, limit + 1);
    const pageRows = limit === undefined ? rows : rows.slice(0, limit);
    const items = pageRows.map((row) => toItem({ PK: query.pk, SK: row.sk }, row.data));
    return { items, ...(pageRows.length < rows.length ? { cursor: encodeCursor({ SK: pageRows.at(-1)!.sk }) } : {}) };
  }
}
