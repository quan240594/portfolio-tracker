import { BudgetGuard } from '@portfolio/platform';
import { runUsageStoreContract } from '@portfolio/platform/testing';
import { describe, expect, it } from 'vitest';
import { SqlJsStorage, TestClock } from '../test/sqljs-storage.js';
import { SqlUsageStore } from './usage-store.js';
import type { SqlUsage } from './sql.js';

runUsageStoreContract('SqlUsageStore (SQLite in Node)', async () => new SqlUsageStore(await SqlJsStorage.create()));

describe('SqlUsageStore', () => {
  it('keeps one row per day, whatever the number of adds', async () => {
    const storage = await SqlJsStorage.create();
    const store = new SqlUsageStore(storage);
    await Promise.all(Array.from({ length: 10 }, () => store.add('2026-01-05', { workerRequests: 1 })));
    await store.add('2026-01-06', { rowsRead: 3 });
    expect(storage.rows('SELECT day FROM usage ORDER BY day')).toEqual([{ day: '2026-01-05' }, { day: '2026-01-06' }]);
  });

  it('writes nothing for an empty delta', async () => {
    const usage: SqlUsage[] = [];
    const store = new SqlUsageStore(await SqlJsStorage.create(), { onUsage: (delta) => usage.push(delta) });
    await store.add('2026-01-05', {});
    await store.add('2026-01-05', { rowsRead: 0 });
    expect(usage).toEqual([]);
  });

  it('costs one row written per add and one row read per read', async () => {
    const usage: SqlUsage[] = [];
    const store = new SqlUsageStore(await SqlJsStorage.create(), { onUsage: (delta) => usage.push(delta) });
    await store.add('2026-01-05', { workerRequests: 4, rowsWritten: 2 });
    await store.read('2026-01-05');
    expect(usage).toEqual([
      { rowsRead: 0, rowsWritten: 1 },
      { rowsRead: 1, rowsWritten: 0 },
    ]);
  });

  it.each([
    ['a negative amount', { rowsRead: -1 }],
    ['NaN', { rowsRead: Number.NaN }],
    ['infinity', { workerRequests: Number.POSITIVE_INFINITY }],
  ])('rejects %s without touching the ledger', async (_name, delta) => {
    const store = new SqlUsageStore(await SqlJsStorage.create());
    await expect(store.add('2026-01-05', delta)).rejects.toThrow(RangeError);
    expect((await store.read('2026-01-05')).rowsRead).toBe(0);
  });

  it.each(['today', '2026-1-5', '2026-01-05T00:00:00Z', "2026-01-05'; DROP TABLE usage; --"])('rejects the day %j everywhere', async (day) => {
    const store = new SqlUsageStore(await SqlJsStorage.create());
    await expect(store.add(day, { workerRequests: 1 })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(store.read(day)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(store.prune(day)).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('survives a restart of the object: a second store over the same storage sees the ledger', async () => {
    const storage = await SqlJsStorage.create();
    await new SqlUsageStore(storage).add('2026-01-05', { durableObjectGbSeconds: 1.5 });
    expect((await new SqlUsageStore(storage).read('2026-01-05')).durableObjectGbSeconds).toBe(1.5);
  });

  it('drives the budget guard: write-behind flushes land in the ledger and block at 80 %', async () => {
    const storage = await SqlJsStorage.create();
    const clock = new TestClock(Date.UTC(2026, 0, 5, 12));
    const store = new SqlUsageStore(storage);
    const guard = new BudgetGuard({ store, now: clock.now, flushAfter: 20, readStorageBytes: () => 0 });
    await guard.record({ workerRequests: 79_999 });
    expect((await guard.check('read')).allowed).toBe(true);
    expect(storage.rows('SELECT * FROM usage')).toEqual([]); // still buffered: the check reads the buffer too
    await guard.flush();
    expect(storage.rows<{ worker_requests: number }>('SELECT worker_requests FROM usage')).toEqual([{ worker_requests: 79_999 }]);
    await guard.record({ workerRequests: 1 });
    expect(await guard.check('read')).toMatchObject({ allowed: false, state: 'blocked', blockedMetrics: ['workerRequests'] });
  });
});
