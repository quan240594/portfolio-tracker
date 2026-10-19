import { describe, expect, it } from 'vitest';
import type { UsageStore } from '../budget/usage-store.js';

type Factory = () => UsageStore | Promise<UsageStore>;

/** Behaviour every UsageStore adapter must have. Days are namespaced per run, so a shared backend is fine. */
export function runUsageStoreContract(name: string, create: Factory): void {
  describe(`UsageStore contract: ${name}`, () => {
    // Fixed far-future days that no real run uses; the run id keeps parallel runs on a shared backend apart.
    const run = Number.parseInt(crypto.randomUUID().slice(0, 4), 16) % 5000;
    const day = (offset: number) => `${3000 + run}-01-${String(offset + 1).padStart(2, '0')}`;

    it('reads a day without data as all zeros', async () => {
      expect(await (await create()).read(day(0))).toEqual({
        workerRequests: 0,
        durableObjectRequests: 0,
        durableObjectGbSeconds: 0,
        rowsRead: 0,
        rowsWritten: 0,
      });
    });

    it('adds up the deltas of a day and leaves omitted metrics unchanged', async () => {
      const store = await create();
      await store.add(day(1), { workerRequests: 2, rowsRead: 10 });
      await store.add(day(1), { workerRequests: 3, rowsWritten: 4 });
      await store.add(day(1), {});
      expect(await store.read(day(1))).toEqual({
        workerRequests: 5,
        durableObjectRequests: 0,
        durableObjectGbSeconds: 0,
        rowsRead: 10,
        rowsWritten: 4,
      });
    });

    it('keeps fractional amounts (gigabyte-seconds)', async () => {
      const store = await create();
      await store.add(day(2), { durableObjectGbSeconds: 0.25 });
      await store.add(day(2), { durableObjectGbSeconds: 0.5 });
      expect((await store.read(day(2))).durableObjectGbSeconds).toBe(0.75);
    });

    it('keeps the counters of different days apart', async () => {
      const store = await create();
      await store.add(day(3), { workerRequests: 1 });
      await store.add(day(4), { workerRequests: 10 });
      expect([(await store.read(day(3))).workerRequests, (await store.read(day(4))).workerRequests]).toEqual([1, 10]);
    });

    it('loses no increment when many adds run at the same time', async () => {
      const store = await create();
      await Promise.all(Array.from({ length: 50 }, () => store.add(day(5), { durableObjectRequests: 1, rowsRead: 7 })));
      const counters = await store.read(day(5));
      expect([counters.durableObjectRequests, counters.rowsRead]).toEqual([50, 350]);
    });

    it('returns a copy that cannot change the stored counters', async () => {
      const store = await create();
      await store.add(day(6), { rowsRead: 1 });
      const copy = await store.read(day(6));
      copy.rowsRead = 999;
      expect((await store.read(day(6))).rowsRead).toBe(1);
    });

    it('prunes the days before the given day and keeps that day and later ones', async () => {
      const store = await create();
      await Promise.all([7, 8, 9].map((offset) => store.add(day(offset), { workerRequests: 1 })));
      await store.prune(day(8));
      expect((await store.read(day(7))).workerRequests).toBe(0);
      expect((await store.read(day(8))).workerRequests).toBe(1);
      expect((await store.read(day(9))).workerRequests).toBe(1);
    });

    it('prunes nothing when no day is older; pruning an empty store is a no-op', async () => {
      const store = await create();
      await expect(store.prune(day(10))).resolves.toBeUndefined();
      await store.add(day(11), { workerRequests: 2 });
      await store.prune(day(11));
      expect((await store.read(day(11))).workerRequests).toBe(2);
    });
  });
}
