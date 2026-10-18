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
} from '../item-store.js';

const idOf = ({ PK, SK }: ItemKey): string => `${PK}\u0000${SK}`;

/** What a store returns: a deep copy, so callers can never alias stored state. */
const clone = <T>(value: T): T => structuredClone(value);

/** Runs a synchronous step as a promise: a thrown error becomes a rejection, like in a real adapter. */
const settle = <T>(step: () => T): Promise<T> => Promise.resolve().then(step);

const compareText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const matches = (sk: string, condition: SortKeyCondition | undefined): boolean => {
  if (!condition) return true;
  if ('beginsWith' in condition) return sk.startsWith(condition.beginsWith);
  if ('between' in condition) return sk >= condition.between[0] && sk <= condition.between[1];
  if ('gte' in condition) return sk >= condition.gte;
  return sk <= condition.lte;
};

/**
 * In-memory ItemStore: the reference implementation of the port, the test double of every repository test and the
 * backing store of dry runs. Items are kept as deep copies.
 */
export class MemoryItemStore implements ItemStore {
  private readonly items = new Map<string, Item>();

  /** Every stored item (copies), in insertion order. For assertions in tests. */
  snapshot(): Item[] {
    return [...this.items.values()].map((item) => clone(item));
  }

  /** Stores the items right away (synchronously), e.g. to seed a store before the first await. */
  load(items: readonly Item[]): this {
    for (const item of items) this.items.set(idOf(item), clone(item));
    return this;
  }

  get size(): number {
    return this.items.size;
  }

  get(key: ItemKey, _options?: ReadOptions): Promise<Item | undefined> {
    const item = this.items.get(idOf(key));
    return Promise.resolve(item ? clone(item) : undefined);
  }

  getMany(keys: readonly ItemKey[]): Promise<Item[]> {
    return Promise.resolve(keys.flatMap((key) => this.items.get(idOf(key)) ?? []).map((item) => clone(item)));
  }

  put(item: Item, options?: WriteOptions): Promise<boolean> {
    if (!this.allowed(this.items.get(idOf(item)), options)) return Promise.resolve(false);
    this.items.set(idOf(item), clone(item));
    return Promise.resolve(true);
  }

  update(key: ItemKey, patch: ItemPatch, options?: WriteOptions): Promise<Item | undefined> {
    return settle(() => {
      assertValidPatch(patch);
      const current = this.items.get(idOf(key));
      if (!this.allowed(current, options)) return undefined;
      const next: Item = { ...clone(current ?? { PK: key.PK, SK: key.SK }) };
      for (const [attr, value] of Object.entries(patch.setIfAbsent ?? {})) if (next[attr] === undefined) next[attr] = value;
      Object.assign(next, patch.set);
      for (const attr of patch.remove ?? []) delete next[attr];
      this.items.set(idOf(key), clone(next));
      return clone(next);
    });
  }

  delete(key: ItemKey, options?: WriteOptions): Promise<boolean> {
    if (!this.allowed(this.items.get(idOf(key)), options)) return Promise.resolve(false);
    this.items.delete(idOf(key));
    return Promise.resolve(true);
  }

  query(query: ItemQuery): Promise<ItemPage> {
    return settle(() => this.page(query));
  }

  private page(query: ItemQuery): ItemPage {
    const sign = query.reverse ? -1 : 1;
    const matching = [...this.items.values()]
      .filter((item) => item.PK === query.pk && matches(item.SK, query.sk))
      .sort((a, b) => sign * compareText(a.SK, b.SK));
    const after = query.cursor === undefined ? undefined : decodeCursor<{ SK: string }>(query.cursor).SK;
    const rest = after === undefined ? matching : matching.filter((item) => sign * compareText(item.SK, after) > 0);
    const items = query.limit === undefined ? rest : rest.slice(0, query.limit);
    const more = items.length < rest.length;
    return { items: items.map((item) => clone(item)), ...(more ? { cursor: encodeCursor({ SK: items.at(-1)!.SK }) } : {}) };
  }

  batchWrite(operations: readonly BatchOp[]): Promise<void> {
    for (const op of operations) {
      if (op.type === 'put') this.items.set(idOf(op.item), clone(op.item));
      else this.items.delete(idOf(op.key));
    }
    return Promise.resolve();
  }

  private allowed(current: Item | undefined, options: WriteOptions | undefined): boolean {
    return !options?.condition || evaluateCondition(current, options.condition);
  }
}
