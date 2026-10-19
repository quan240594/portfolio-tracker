import { cond, type Item, type ItemStore } from '@portfolio/platform';
import { runItemStoreContract } from '@portfolio/platform/testing';
import { describe, expect, it } from 'vitest';
import { SqlJsStorage } from '../test/sqljs-storage.js';
import { prefixUpperBound, SqlItemStore } from './item-store.js';
import type { SqlUsage } from './sql.js';

runItemStoreContract('SqlItemStore (SQLite in Node)', async () => new SqlItemStore(await SqlJsStorage.create()));

const setup = async () => {
  const storage = await SqlJsStorage.create();
  const usage: SqlUsage[] = [];
  const store = new SqlItemStore(storage, { onUsage: (delta) => usage.push(delta) });
  return { storage, store, usage };
};

const keys = (items: readonly Item[]) => items.map((item) => item.SK);
const put = (...sks: string[]) => sks.map((SK) => ({ type: 'put' as const, item: { PK: 'p', SK } }));
const total = (usage: readonly SqlUsage[], field: keyof SqlUsage) => usage.reduce((sum, delta) => sum + delta[field], 0);

describe('prefixUpperBound', () => {
  it('increments the last character', () => {
    expect(prefixUpperBound('EOD#')).toBe('EOD$');
    expect(prefixUpperBound('a')).toBe('b');
  });

  it('carries over characters that cannot be incremented', () => {
    expect(prefixUpperBound('a\u{10ffff}')).toBe('b');
    expect(prefixUpperBound('\u{10ffff}\u{10ffff}')).toBeUndefined();
  });

  it('jumps over the surrogate range', () => {
    expect(prefixUpperBound('\ud7ff')).toBe('\ue000');
  });

  it('has no bound for the empty prefix', () => {
    expect(prefixUpperBound('')).toBeUndefined();
  });
});

describe('SqlItemStore', () => {
  it('stores keys in the primary key of a WITHOUT ROWID table and nothing else', async () => {
    const { storage, store } = await setup();
    await store.put({ PK: 'p', SK: 's', a: 1 });
    expect(storage.rows("SELECT sql FROM sqlite_master WHERE name = 'items'")[0]!.sql).toMatch(/WITHOUT ROWID/);
    expect(storage.rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'")).toEqual([]);
    expect(storage.rows('SELECT pk, sk, data FROM items')).toEqual([{ pk: 'p', sk: 's', data: '{"a":1}' }]);
  });

  it('is safe against quotes and SQL in user values', async () => {
    const { store } = await setup();
    const evil = "x'; DROP TABLE items; --";
    await store.put({ PK: evil, SK: evil, name: evil });
    expect(await store.get({ PK: evil, SK: evil })).toEqual({ PK: evil, SK: evil, name: evil });
    expect((await store.query({ pk: evil, sk: { beginsWith: "x'" } })).items).toHaveLength(1);
    expect(await store.update({ PK: evil, SK: evil }, { set: { [evil]: 1 } })).toMatchObject({ [evil]: 1 });
  });

  it('orders sort keys by UTF-8 bytes, like DynamoDB (an astral character sorts after U+FFFF)', async () => {
    const { store } = await setup();
    // In UTF-16 order the emoji (a surrogate pair) would come before U+FFFF; in UTF-8 byte order it comes after.
    await store.batchWrite(put('k#\u{1f600}', 'k#\uffff', 'k#z', 'k#é', 'k#A'));
    expect(keys((await store.query({ pk: 'p' })).items)).toEqual(['k#A', 'k#z', 'k#é', 'k#\uffff', 'k#\u{1f600}']);
    expect(keys((await store.query({ pk: 'p', reverse: true })).items)).toEqual(['k#\u{1f600}', 'k#\uffff', 'k#é', 'k#z', 'k#A']);
    // A prefix query includes every continuation, astral ones included.
    expect(keys((await store.query({ pk: 'p', sk: { beginsWith: 'k#' } })).items)).toHaveLength(5);
  });

  it('matches every sort key for an empty prefix and a prefix of maximum code points', async () => {
    const { store } = await setup();
    await store.batchWrite(put('a', '\u{10ffff}\u{10ffff}x'));
    expect(keys((await store.query({ pk: 'p', sk: { beginsWith: '' } })).items)).toEqual(['a', '\u{10ffff}\u{10ffff}x']);
    expect(keys((await store.query({ pk: 'p', sk: { beginsWith: '\u{10ffff}\u{10ffff}' } })).items)).toEqual(['\u{10ffff}\u{10ffff}x']);
  });

  it('returns a cursor only when another item follows, and resumes strictly after the last item', async () => {
    const { store } = await setup();
    await store.batchWrite(put('a', 'b', 'c'));
    expect((await store.query({ pk: 'p', limit: 3 })).cursor).toBeUndefined();
    const first = await store.query({ pk: 'p', limit: 2 });
    expect(keys(first.items)).toEqual(['a', 'b']);
    expect(keys((await store.query({ pk: 'p', limit: 2, cursor: first.cursor })).items)).toEqual(['c']);
    const reversed = await store.query({ pk: 'p', limit: 2, reverse: true });
    expect(keys((await store.query({ pk: 'p', reverse: true, cursor: reversed.cursor })).items)).toEqual(['a']);
  });

  it('combines a cursor with a sort key range', async () => {
    const { store } = await setup();
    await store.batchWrite(put('A#1', 'A#2', 'A#3', 'B#1'));
    const page = await store.query({ pk: 'p', sk: { beginsWith: 'A#' }, limit: 1 });
    expect(keys((await store.query({ pk: 'p', sk: { beginsWith: 'A#' }, cursor: page.cursor })).items)).toEqual(['A#2', 'A#3']);
  });

  it('rejects an invalid cursor and an invalid limit', async () => {
    const { store } = await setup();
    await expect(store.query({ pk: 'p', cursor: 'not a cursor' })).rejects.toThrow('Invalid query cursor');
    await expect(store.query({ pk: 'p', cursor: btoa('{"SK":5}') })).rejects.toThrow('Invalid query cursor');
    const refused = [0, -1, 1.5, Number.NaN].map((limit) => expect(store.query({ pk: 'p', limit })).rejects.toThrow(RangeError));
    await Promise.all(refused);
  });

  it('lets exactly one of two racing conditional updates win', async () => {
    const { store } = await setup();
    await store.put({ PK: 'p', SK: 'lock', status: 'IDLE' });
    const claim = { condition: cond.eq('status', 'IDLE') };
    const results = await Promise.all([
      store.update({ PK: 'p', SK: 'lock' }, { set: { status: 'RUNNING' } }, claim),
      store.update({ PK: 'p', SK: 'lock' }, { set: { status: 'RUNNING' } }, claim),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('rolls the whole batch back when one operation fails', async () => {
    const { store } = await setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      store.batchWrite([
        { type: 'put', item: { PK: 'p', SK: 'ok' } },
        { type: 'put', item: { PK: 'p', SK: 'bad', circular } },
      ]),
    ).rejects.toThrow();
    expect((await store.query({ pk: 'p' })).items).toEqual([]);
  });

  it('guards deletes and puts with conditions', async () => {
    const { store } = await setup();
    await store.put({ PK: 'p', SK: 'a', n: 1 });
    expect(await store.delete({ PK: 'p', SK: 'a' }, { condition: cond.eq('n', 2) })).toBe(false);
    expect(await store.get({ PK: 'p', SK: 'a' })).toBeDefined();
    expect(await store.put({ PK: 'p', SK: 'a', n: 3 }, { condition: cond.lt('n', 1) })).toBe(false);
    expect(await store.delete({ PK: 'p', SK: 'a' }, { condition: cond.eq('n', 1) })).toBe(true);
    expect(await store.get({ PK: 'p', SK: 'a' })).toBeUndefined();
  });

  it('keeps null and nested values, and returns from update exactly what a later get returns', async () => {
    const { store } = await setup();
    const updated = await store.update({ PK: 'p', SK: 'u' }, { set: { none: null, nested: { list: [1, { a: 'b' }] }, skipped: undefined } });
    expect(updated).toEqual({ PK: 'p', SK: 'u', none: null, nested: { list: [1, { a: 'b' }] } });
    expect(await store.get({ PK: 'p', SK: 'u' })).toEqual(updated);
  });

  it('reports the rows each statement read and wrote, and reads only what it returns', async () => {
    const { store, usage } = await setup();
    await store.batchWrite(Array.from({ length: 20 }, (_, i) => ({ type: 'put' as const, item: { PK: 'p', SK: `K#${String(i).padStart(2, '0')}` } })));
    expect(total(usage, 'rowsWritten')).toBe(20);

    usage.length = 0;
    await store.get({ PK: 'p', SK: 'K#05' });
    await store.query({ pk: 'p', sk: { beginsWith: 'K#1' }, limit: 3 });
    expect(total(usage, 'rowsRead')).toBe(1 + 4); // one point read, and 3 rows + 1 look-ahead row of the page
  });

  it('works without a usage callback', async () => {
    const store: ItemStore = new SqlItemStore(await SqlJsStorage.create());
    expect(await store.getMany([{ PK: 'p', SK: 'x' }])).toEqual([]);
  });
});
