import { paginate } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { cond, queryAll, type Item, type ItemPage, type ItemStore } from '../item-store.js';

type Factory = () => ItemStore | Promise<ItemStore>;

/**
 * Behaviour every ItemStore adapter must have. Each test works in its own partitions (a random namespace), so the
 * suite can run against a shared, long-lived table (LocalStack, D1) without cleaning up.
 *
 *   runItemStoreContract('D1', () => new D1ItemStore(db));
 */
export function runItemStoreContract(name: string, create: Factory): void {
  describe(`ItemStore contract: ${name}`, () => {
    const ns = crypto.randomUUID();
    let counter = 0;
    const pk = (label = 'p') => `CONTRACT#${ns}#${label}${++counter}`;
    const item = (partition: string, sk: string, extra: Record<string, unknown> = {}): Item => ({ PK: partition, SK: sk, ...extra });
    const sks = (items: readonly Item[]) => items.map((i) => i.SK);

    describe('get / put', () => {
      it('round-trips an item with nested JSON values and returns undefined for a missing one', async () => {
        const store = await create();
        const p = pk();
        const original = item(p, 'A#1', { n: 1.5, s: 'x', ok: true, none: null, list: [1, 'two', { three: 3 }], nested: { deep: { v: 'y' } } });
        expect(await store.put(original)).toBe(true);
        expect(await store.get({ PK: p, SK: 'A#1' })).toEqual(original);
        expect(await store.get({ PK: p, SK: 'A#1' }, { consistent: true })).toEqual(original);
        expect(await store.get({ PK: p, SK: 'missing' })).toBeUndefined();
      });

      it('replaces the whole item and drops undefined attributes', async () => {
        const store = await create();
        const p = pk();
        await store.put(item(p, 'A', { old: 1, keep: 'a' }));
        await store.put(item(p, 'A', { keep: 'b', skipped: undefined }));
        expect(await store.get({ PK: p, SK: 'A' })).toEqual(item(p, 'A', { keep: 'b' }));
      });

      it('supports keys with unicode, spaces and separators', async () => {
        const store = await create();
        const p = `${pk()}#ü ñ`;
        await store.put(item(p, 'TXN#default#2026-01-01#id with space', { v: 1 }));
        expect((await store.get({ PK: p, SK: 'TXN#default#2026-01-01#id with space' }))?.v).toBe(1);
      });

      it('does not alias returned items', async () => {
        const store = await create();
        const p = pk();
        await store.put(item(p, 'A', { list: [1] }));
        ((await store.get({ PK: p, SK: 'A' }))!.list as number[]).push(2);
        expect((await store.get({ PK: p, SK: 'A' }))!.list).toEqual([1]);
      });

      it('creates only when the item does not exist (cond.notExists)', async () => {
        const store = await create();
        const p = pk();
        expect(await store.put(item(p, 'A', { v: 1 }), { condition: cond.notExists })).toBe(true);
        expect(await store.put(item(p, 'A', { v: 2 }), { condition: cond.notExists })).toBe(false);
        expect((await store.get({ PK: p, SK: 'A' }))?.v).toBe(1);
      });

      it('overwrites only an existing item (cond.exists)', async () => {
        const store = await create();
        const p = pk();
        expect(await store.put(item(p, 'A', { v: 1 }), { condition: cond.exists })).toBe(false);
        expect(await store.get({ PK: p, SK: 'A' })).toBeUndefined();
        await store.put(item(p, 'A', { v: 1 }));
        expect(await store.put(item(p, 'A', { v: 2 }), { condition: cond.exists })).toBe(true);
        expect((await store.get({ PK: p, SK: 'A' }))?.v).toBe(2);
      });
    });

    describe('getMany', () => {
      it('returns the items that exist, whatever their number', async () => {
        const store = await create();
        const p = pk();
        const total = 130;
        const ops = Array.from({ length: total }, (_, i) => ({ type: 'put' as const, item: item(p, `K#${String(i).padStart(3, '0')}`, { i }) }));
        await store.batchWrite(ops);
        const keys = [...ops.map((op) => ({ PK: p, SK: op.item.SK })), { PK: p, SK: 'K#missing' }];
        const found = await store.getMany(keys);
        expect(found).toHaveLength(total);
        expect(sks(found).sort((a, b) => a.localeCompare(b))).toEqual(sks(ops.map((op) => op.item)));
        expect(await store.getMany([])).toEqual([]);
      });
    });

    describe('update', () => {
      it('upserts, then applies set / setIfAbsent / remove and returns the new item', async () => {
        const store = await create();
        const p = pk();
        const key = { PK: p, SK: 'U' };
        const created = await store.update(key, { set: { name: 'a', n: 1 }, setIfAbsent: { createdAt: 't1' } });
        expect(created).toEqual({ ...key, name: 'a', n: 1, createdAt: 't1' });
        const updated = await store.update(key, { set: { name: 'b', list: ['x'] }, setIfAbsent: { createdAt: 't2', extra: 'e' }, remove: ['n'] });
        expect(updated).toEqual({ ...key, name: 'b', createdAt: 't1', extra: 'e', list: ['x'] });
        expect(await store.get(key)).toEqual(updated);
      });

      it('handles attribute names that are reserved words', async () => {
        const store = await create();
        const key = { PK: pk(), SK: 'R' };
        const updated = await store.update(key, { set: { name: 'n', status: 's', errors: [{ row: 1 }], '#odd': 1 } });
        expect(updated).toMatchObject({ name: 'n', status: 's', errors: [{ row: 1 }] });
      });

      it('rejects a patch that is empty or changes the key attributes', async () => {
        const store = await create();
        const key = { PK: pk(), SK: 'V' };
        await expect(store.update(key, {})).rejects.toThrow();
        await expect(store.update(key, { set: { PK: 'other' } })).rejects.toThrow();
        await expect(store.update(key, { remove: ['SK'] })).rejects.toThrow();
        expect(await store.get(key)).toBeUndefined();
      });

      it('writes nothing and resolves undefined when the condition fails', async () => {
        const store = await create();
        const key = { PK: pk(), SK: 'C' };
        expect(await store.update(key, { set: { v: 1 } }, { condition: cond.exists })).toBeUndefined();
        expect(await store.get(key)).toBeUndefined();
        await store.put({ ...key, status: 'IDLE', startedAt: '2026-01-01' });
        expect(await store.update(key, { set: { v: 1 } }, { condition: cond.exists })).toMatchObject({ v: 1, status: 'IDLE' });
      });

      it('evaluates attribute conditions (eq, ne, lt, oneOf, attrMissing, and, or)', async () => {
        const store = await create();
        const key = { PK: pk(), SK: 'S' };
        await store.put({ ...key, status: 'RUNNING', startedAt: '2026-01-02', count: 3 });
        const touch = (condition: Parameters<ItemStore['update']>[2]) => store.update(key, { set: { touched: true } }, condition);

        expect(await touch({ condition: cond.eq('status', 'IDLE') })).toBeUndefined();
        expect(await touch({ condition: cond.eq('status', 'RUNNING') })).toBeDefined();
        expect(await touch({ condition: cond.ne('status', 'RUNNING') })).toBeUndefined();
        expect(await touch({ condition: cond.lt('startedAt', '2026-01-01') })).toBeUndefined();
        expect(await touch({ condition: cond.lt('startedAt', '2026-01-03') })).toBeDefined();
        expect(await touch({ condition: cond.lt('count', 4) })).toBeDefined();
        expect(await touch({ condition: cond.oneOf('status', ['PENDING', 'PROCESSING']) })).toBeUndefined();
        expect(await touch({ condition: cond.oneOf('status', ['PENDING', 'RUNNING']) })).toBeDefined();
        expect(await touch({ condition: cond.attrMissing('finishedAt') })).toBeDefined();
        expect(await touch({ condition: cond.attrMissing('status') })).toBeUndefined();
        // The sync lock: exists AND (not RUNNING OR no start time OR started before the stale limit).
        const claim = (stale: string) =>
          cond.and(cond.exists, cond.or(cond.ne('status', 'RUNNING'), cond.attrMissing('startedAt'), cond.lt('startedAt', stale)));
        expect(await touch({ condition: claim('2026-01-01') })).toBeUndefined();
        expect(await touch({ condition: claim('2026-01-10') })).toBeDefined();
      });
    });

    describe('delete', () => {
      it('removes an item; deleting a missing one is a no-op', async () => {
        const store = await create();
        const key = { PK: pk(), SK: 'D' };
        await store.put({ ...key, v: 1 });
        expect(await store.delete(key)).toBe(true);
        expect(await store.get(key)).toBeUndefined();
        expect(await store.delete(key)).toBe(true);
      });

      it('reports whether the item existed when guarded with cond.exists', async () => {
        const store = await create();
        const key = { PK: pk(), SK: 'D' };
        expect(await store.delete(key, { condition: cond.exists })).toBe(false);
        await store.put({ ...key, v: 1 });
        expect(await store.delete(key, { condition: cond.exists })).toBe(true);
        expect(await store.get(key)).toBeUndefined();
      });
    });

    describe('query', () => {
      const seed = async (store: ItemStore, partition: string) => {
        const names = ['EOD#2026-01-01', 'EOD#2026-01-02', 'EOD#2026-01-03', 'EOD#2026-02-01', 'DIV#2026-01-15', 'PROFILE'];
        await store.batchWrite(names.map((SK, i) => ({ type: 'put' as const, item: item(partition, SK, { i }) })));
        await store.put(item(`${partition}#other`, 'EOD#2026-01-01'));
      };

      it('returns the items of the partition in ascending sort key order', async () => {
        const store = await create();
        const p = pk();
        await seed(store, p);
        const page = await store.query({ pk: p });
        expect(sks(page.items)).toEqual(['DIV#2026-01-15', 'EOD#2026-01-01', 'EOD#2026-01-02', 'EOD#2026-01-03', 'EOD#2026-02-01', 'PROFILE']);
        expect(page.items[0]).toMatchObject({ PK: p, i: 4 });
        expect((await store.query({ pk: `${p}#none` })).items).toEqual([]);
      });

      it('filters by sort key prefix, range and bounds', async () => {
        const store = await create();
        const p = pk();
        await seed(store, p);
        const run = async (sk: Parameters<ItemStore['query']>[0]['sk']) => sks((await store.query({ pk: p, sk })).items);
        expect(await run({ beginsWith: 'EOD#' })).toEqual(['EOD#2026-01-01', 'EOD#2026-01-02', 'EOD#2026-01-03', 'EOD#2026-02-01']);
        expect(await run({ beginsWith: 'EOD#2026-01' })).toEqual(['EOD#2026-01-01', 'EOD#2026-01-02', 'EOD#2026-01-03']);
        expect(await run({ between: ['EOD#2026-01-02', 'EOD#2026-01-03'] })).toEqual(['EOD#2026-01-02', 'EOD#2026-01-03']);
        expect(await run({ gte: 'EOD#2026-01-03' })).toEqual(['EOD#2026-01-03', 'EOD#2026-02-01', 'PROFILE']);
        expect(await run({ lte: 'EOD#2026-01-01' })).toEqual(['DIV#2026-01-15', 'EOD#2026-01-01']);
        expect(await run({ beginsWith: 'NOPE#' })).toEqual([]);
      });

      it('reverses the order and limits the page size', async () => {
        const store = await create();
        const p = pk();
        await seed(store, p);
        const latest = await store.query({ pk: p, sk: { beginsWith: 'EOD#' }, reverse: true, limit: 1 });
        expect(sks(latest.items)).toEqual(['EOD#2026-02-01']);
        const reversed = await store.query({ pk: p, sk: { beginsWith: 'EOD#' }, reverse: true });
        expect(sks(reversed.items)).toEqual(['EOD#2026-02-01', 'EOD#2026-01-03', 'EOD#2026-01-02', 'EOD#2026-01-01']);
      });

      it('pages with opaque cursors without skipping or repeating items', async () => {
        const store = await create();
        const p = pk();
        await seed(store, p);
        const collect = async (reverse: boolean) => {
          const pages = paginate<ItemPage, string>(async (cursor) => {
            const page = await store.query({ pk: p, limit: 2, reverse, cursor });
            expect(page.items.length).toBeLessThanOrEqual(2);
            if (page.cursor !== undefined) expect(typeof page.cursor).toBe('string');
            return { page, next: page.cursor };
          });
          const out: string[] = [];
          for await (const page of pages) out.push(...sks(page.items));
          return out;
        };
        const all = sks((await store.query({ pk: p })).items);
        expect(await collect(false)).toEqual(all);
        expect(await collect(true)).toEqual([...all].reverse());
      });

      it('queryAll follows the cursors', async () => {
        const store = await create();
        const p = pk();
        await seed(store, p);
        expect(sks(await queryAll(store, { pk: p, limit: 4 }))).toHaveLength(6);
        expect(sks(await queryAll(store, { pk: p, sk: { beginsWith: 'EOD#' }, limit: 1, consistent: true }))).toHaveLength(4);
      });

      it('reads its own writes with consistent: true', async () => {
        const store = await create();
        const p = pk();
        await store.put(item(p, 'A'));
        expect((await store.query({ pk: p, consistent: true })).items).toHaveLength(1);
      });
    });

    describe('batchWrite', () => {
      it('applies more operations than one chunk, mixing puts, overwrites and deletes', async () => {
        const store = await create();
        const p = pk();
        const sk = (i: number) => `B#${String(i).padStart(3, '0')}`;
        await store.batchWrite(Array.from({ length: 60 }, (_, i) => ({ type: 'put' as const, item: item(p, sk(i), { v: 'old' }) })));
        await store.batchWrite([
          ...Array.from({ length: 30 }, (_, i) => ({ type: 'put' as const, item: item(p, sk(i), { v: 'new' }) })),
          ...Array.from({ length: 30 }, (_, i) => ({ type: 'delete' as const, key: { PK: p, SK: sk(i + 30) } })),
          { type: 'delete' as const, key: { PK: p, SK: 'B#never-existed' } },
          ...Array.from({ length: 40 }, (_, i) => ({ type: 'put' as const, item: item(p, sk(100 + i), { v: 'added' }) })),
        ]);
        const all = await queryAll(store, { pk: p });
        expect(all).toHaveLength(70);
        expect(all.filter((i) => i.v === 'new')).toHaveLength(30);
        expect(all.filter((i) => i.v === 'old')).toHaveLength(0);
        expect(all.filter((i) => i.v === 'added')).toHaveLength(40);
      });

      it('accepts an empty batch', async () => {
        const store = await create();
        await expect(store.batchWrite([])).resolves.toBeUndefined();
      });

      it('is idempotent: repeating a batch leaves the same state', async () => {
        const store = await create();
        const p = pk();
        const ops = Array.from({ length: 30 }, (_, i) => ({ type: 'put' as const, item: item(p, `I#${i}`, { i }) }));
        await store.batchWrite(ops);
        await store.batchWrite(ops);
        expect(await queryAll(store, { pk: p })).toHaveLength(30);
      });
    });
  });
}
