import { paginate } from '@portfolio/shared';
import { decodeBase64Url, encodeBase64Url } from './encoding.js';

/**
 * ItemStore: the minimal single-table key/value surface the repositories use. Items live under a partition key `PK`
 * and a sort key `SK` (both strings, see `keys` in @portfolio/shared); every other attribute is a JSON value
 * (string, number, boolean, null, arrays and plain objects; no `Date`, no `NaN`; attributes that are `undefined` are dropped).
 *
 * Implementations: DynamoDB (`@portfolio/aws`), in-memory (`MemoryItemStore`, the reference), D1/SQLite later.
 * Every implementation must pass `runItemStoreContract` (`@portfolio/platform/testing`).
 */
export interface ItemKey {
  PK: string;
  SK: string;
}

export type Item = ItemKey & Record<string, unknown>;

export type Scalar = string | number | boolean;

/**
 * Write guard, evaluated atomically against the current item. A comparison on a missing attribute is false (combine
 * with `attrMissing` to express "missing or ...").
 */
export type Condition =
  | { readonly kind: 'exists' }
  | { readonly kind: 'notExists' }
  | { readonly kind: 'attrMissing'; readonly attr: string }
  | { readonly kind: 'compare'; readonly attr: string; readonly op: 'eq' | 'ne' | 'lt'; readonly value: Scalar }
  | { readonly kind: 'in'; readonly attr: string; readonly values: readonly Scalar[] }
  | { readonly kind: 'and' | 'or'; readonly conditions: readonly Condition[] };

/** Builders for `Condition`. */
export const cond = {
  /** The item exists (DynamoDB `attribute_exists(PK)`). */
  exists: { kind: 'exists' } as Condition,
  /** The item does not exist yet: create-only writes (DynamoDB `attribute_not_exists(PK)`). */
  notExists: { kind: 'notExists' } as Condition,
  attrMissing: (attr: string): Condition => ({ kind: 'attrMissing', attr }),
  eq: (attr: string, value: Scalar): Condition => ({ kind: 'compare', attr, op: 'eq', value }),
  ne: (attr: string, value: Scalar): Condition => ({ kind: 'compare', attr, op: 'ne', value }),
  lt: (attr: string, value: Scalar): Condition => ({ kind: 'compare', attr, op: 'lt', value }),
  oneOf: (attr: string, values: readonly Scalar[]): Condition => ({ kind: 'in', attr, values }),
  and: (...conditions: Condition[]): Condition => ({ kind: 'and', conditions }),
  or: (...conditions: Condition[]): Condition => ({ kind: 'or', conditions }),
} as const;

const compare = (actual: unknown, op: 'eq' | 'ne' | 'lt', expected: Scalar): boolean => {
  if (actual === undefined || actual === null) return false;
  if (op === 'eq') return actual === expected;
  if (op === 'ne') return actual !== expected;
  return typeof actual === typeof expected && (actual as Scalar) < expected;
};

/** Reference evaluation of a `Condition` (used by the in-memory store; SQL adapters may evaluate it in the driver). */
export function evaluateCondition(item: Item | undefined, condition: Condition): boolean {
  switch (condition.kind) {
    case 'exists':
      return item !== undefined;
    case 'notExists':
      return item === undefined;
    case 'attrMissing':
      return item?.[condition.attr] === undefined;
    case 'compare':
      return compare(item?.[condition.attr], condition.op, condition.value);
    case 'in':
      return (condition.values as readonly unknown[]).includes(item?.[condition.attr]);
    case 'and':
      return condition.conditions.every((c) => evaluateCondition(item, c));
    case 'or':
      return condition.conditions.some((c) => evaluateCondition(item, c));
  }
}

/** Partial update of one item. Without a `condition` it upserts (creates the item when it does not exist). */
export interface ItemPatch {
  /** Attributes to overwrite. Must not contain `PK` or `SK`. */
  set?: Readonly<Record<string, unknown>>;
  /** Attributes to write only when they are not stored yet (DynamoDB `if_not_exists`). */
  setIfAbsent?: Readonly<Record<string, unknown>>;
  /** Attributes to delete. */
  remove?: readonly string[];
}

/** Rejects a patch that does nothing or touches the key attributes (every adapter validates with this). */
export function assertValidPatch(patch: ItemPatch): void {
  const attrs = [...Object.keys(patch.set ?? {}), ...Object.keys(patch.setIfAbsent ?? {}), ...(patch.remove ?? [])];
  if (attrs.length === 0) throw new Error('An item patch needs at least one attribute to set or remove');
  if (attrs.some((attr) => attr === 'PK' || attr === 'SK')) throw new Error('An item patch must not change the key attributes PK/SK');
}

export interface ReadOptions {
  /** Read-your-writes. DynamoDB: ConsistentRead. Stores that are always consistent ignore it. */
  consistent?: boolean;
}

export interface WriteOptions {
  condition?: Condition;
}

export type SortKeyCondition =
  | { readonly beginsWith: string }
  | { readonly between: readonly [string, string] }
  | { readonly gte: string }
  | { readonly lte: string };

export interface ItemQuery extends ReadOptions {
  pk: string;
  sk?: SortKeyCondition;
  /** Maximum number of items per page. */
  limit?: number;
  /** Newest first: descending sort key order. */
  reverse?: boolean;
  /** Opaque cursor from the previous page. */
  cursor?: string;
}

export interface ItemPage {
  items: Item[];
  /** Present when more items may follow; pass it as `cursor` for the next page. */
  cursor?: string;
}

export type BatchOp = { readonly type: 'put'; readonly item: Item } | { readonly type: 'delete'; readonly key: ItemKey };

/** Raised by `batchWrite` when the store still refuses some operations after the adapter's bounded retries. */
export class UnprocessedItemsError extends Error {
  constructor(
    public readonly unprocessed: number,
    attempts: number,
  ) {
    super(`BatchWrite: ${unprocessed} unprocessed items after ${attempts} attempts`);
    this.name = 'UnprocessedItemsError';
  }
}

export interface ItemStore {
  /** The item, or undefined when it does not exist. */
  get(key: ItemKey, options?: ReadOptions): Promise<Item | undefined>;
  /** The items that exist among `keys` (any order; missing keys are omitted). Keys must be distinct. */
  getMany(keys: readonly ItemKey[]): Promise<Item[]>;
  /** Writes the item, replacing any existing one. Resolves false (and writes nothing) when `options.condition` fails. */
  put(item: Item, options?: WriteOptions): Promise<boolean>;
  /** Applies the patch and resolves the updated item; resolves undefined (and writes nothing) when the condition fails. */
  update(key: ItemKey, patch: ItemPatch, options?: WriteOptions): Promise<Item | undefined>;
  /** Resolves false when `options.condition` fails (e.g. `cond.exists` on a missing item). Deleting a missing item is a no-op. */
  delete(key: ItemKey, options?: WriteOptions): Promise<boolean>;
  /** One page of the items under `pk`, in ascending (or, with `reverse`, descending) sort key order. */
  query(query: ItemQuery): Promise<ItemPage>;
  /**
   * Applies every operation (puts and deletes, no conditions) and resolves only when all of them are stored: the
   * adapter chunks to the store's limit and retries what the store reports as unprocessed, rejecting with
   * `UnprocessedItemsError` when it still cannot. Not atomic: after a rejection callers retry the whole batch, which
   * is safe because puts and deletes are idempotent. The operations must not contain duplicate keys.
   */
  batchWrite(operations: readonly BatchOp[]): Promise<void>;
}

/** Encodes a store-specific continuation value as an opaque cursor string. */
export const encodeCursor = (value: unknown): string => encodeBase64Url(JSON.stringify(value));

export function decodeCursor<T>(cursor: string): T {
  try {
    return JSON.parse(decodeBase64Url(cursor)) as T;
  } catch {
    throw new Error('Invalid query cursor');
  }
}

/** Every item of the query (all pages, fetched one after another). `limit` is the page size. */
export async function queryAll(store: ItemStore, query: Omit<ItemQuery, 'cursor'>): Promise<Item[]> {
  const pages = paginate<ItemPage, string>(async (cursor) => {
    const page = await store.query({ ...query, cursor });
    return { page, next: page.cursor };
  });
  const out: Item[] = [];
  for await (const page of pages) out.push(...page.items);
  return out;
}

/** The sort key condition `begins_with(prefix)` as a query. */
export const beginsWith = (pk: string, prefix: string, options?: ReadOptions): ItemQuery => ({ pk, sk: { beginsWith: prefix }, ...options });
