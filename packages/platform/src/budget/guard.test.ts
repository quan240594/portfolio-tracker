import { describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '@portfolio/shared';
import { usageSnapshotSchema } from '@portfolio/shared';
import { MemoryUsageStore } from '../memory/usage-store.js';
import { FlakyStore, at, clock, spyLogger } from '../testing/budget-helpers.js';
import { BudgetGuard } from './guard.js';
import { FREE_PLAN_LIMITS, METRIC_LIMITS, classifyUsage, durableObjectGbSeconds, nextUtcMidnight, secondsUntilReset, usagePercent, utcDay, utcDayBefore } from './limits.js';

describe('limits table and helpers', () => {
  it('documents the Free-plan caps', () => {
    expect(FREE_PLAN_LIMITS).toEqual({
      workerRequestsPerDay: 100_000,
      durableObjectRequestsPerDay: 100_000,
      durableObjectGbSecondsPerDay: 13_000,
      sqliteRowsReadPerDay: 5_000_000,
      sqliteRowsWrittenPerDay: 100_000,
      workersAiNeuronsPerDay: 10_000,
      durableObjectStorageBytesPerAccount: 5_000_000_000,
      durableObjectStorageBytesPerObject: 1_000_000_000,
      subrequestsPerInvocation: 50,
    });
    expect(METRIC_LIMITS.storageBytes).toBe(FREE_PLAN_LIMITS.durableObjectStorageBytesPerObject);
  });

  it('names the UTC day of an instant, also around midnight and with an offset input', () => {
    expect(utcDay(at('2026-10-19T23:59:59.999Z'))).toBe('2026-10-19');
    expect(utcDay(at('2026-10-20T00:00:00.000Z'))).toBe('2026-10-20');
    expect(utcDay(at('2026-10-20T01:30:00+02:00'))).toBe('2026-10-19');
    expect(utcDay(Date.UTC(2026, 11, 31, 12))).toBe('2026-12-31');
  });

  it('finds the next UTC midnight strictly after the instant', () => {
    expect(nextUtcMidnight(at('2026-10-19T10:15:00Z')).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(nextUtcMidnight(at('2026-10-20T00:00:00Z')).toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(nextUtcMidnight(at('2026-12-31T23:59:59.999Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('counts whole seconds until the reset, rounded up and never below one', () => {
    expect(secondsUntilReset(at('2026-10-19T23:00:00Z'))).toBe(3600);
    expect(secondsUntilReset(at('2026-10-19T23:59:59.100Z'))).toBe(1);
    expect(secondsUntilReset(at('2026-10-20T00:00:00Z'))).toBe(86_400);
  });

  it('goes back whole UTC days', () => {
    expect(utcDayBefore('2026-03-02', 7)).toBe('2026-02-23');
    expect(utcDayBefore('2026-01-03', 3)).toBe('2025-12-31');
  });

  it('classifies exactly at 60 and 80 percent', () => {
    expect(classifyUsage(59_999, 100_000)).toBe('ok');
    expect(classifyUsage(60_000, 100_000)).toBe('warn');
    expect(classifyUsage(79_999, 100_000)).toBe('warn');
    expect(classifyUsage(80_000, 100_000)).toBe('blocked');
    expect(classifyUsage(130_000, 100_000)).toBe('blocked');
    expect(classifyUsage(0, 100_000)).toBe('ok');
  });

  it('computes percentages with two decimals and treats a zero cap as full', () => {
    expect(usagePercent(1, 3)).toBe(33.33);
    expect(usagePercent(50, 100)).toBe(50);
    expect(usagePercent(5, 0)).toBe(100);
  });

  it('converts Durable Object duration to GB-s (128 MB)', () => {
    expect(durableObjectGbSeconds(1000)).toBeCloseTo(0.128, 10);
    expect(durableObjectGbSeconds(500)).toBeCloseTo(0.064, 10);
    expect(durableObjectGbSeconds(-5)).toBe(0);
  });
});

describe('BudgetGuard', () => {
  const setup = (start = '2026-10-19T10:00:00Z', extra: Partial<ConstructorParameters<typeof BudgetGuard>[0]> = {}) => {
    const store = new FlakyStore();
    const time = clock(start);
    const log = spyLogger();
    const guard = new BudgetGuard({ store, now: time.now, logger: log.logger, ...extra });
    return { store, time, log, guard };
  };

  it('lists the Workers AI neurons but never lets them pause the app: they gate only the work that spends them', async () => {
    const { guard } = setup();
    await guard.record({ aiNeurons: 9500 });
    const snapshot = await guard.snapshot();
    expect(snapshot.metrics.aiNeurons).toEqual({ used: 9500, limit: 10_000, percent: 95, state: 'blocked' });
    expect(snapshot.state).toBe('ok');
    expect(await guard.check('write')).toMatchObject({ allowed: true, state: 'ok', blockedMetrics: [] });
    expect(await guard.check('job')).toMatchObject({ allowed: true });
  });

  it('reports the AI allowance with the 60 % and 80 % thresholds and the reset', async () => {
    const { guard, store } = setup();
    expect(await guard.aiAllowance()).toEqual({ state: 'ok', used: 0, limit: 10_000, resetsAt: '2026-10-20T00:00:00.000Z' });
    await guard.record({ aiNeurons: 5999 });
    expect((await guard.aiAllowance()).state).toBe('ok');
    await guard.record({ aiNeurons: 1 });
    expect((await guard.aiAllowance()).state).toBe('warn');
    await guard.record({ aiNeurons: 1999 });
    expect((await guard.aiAllowance()).state).toBe('warn');
    await guard.record({ aiNeurons: 1 });
    expect(await guard.aiAllowance()).toMatchObject({ state: 'blocked', used: 8000 });
    store.failing = true;
    await guard.flush();
    expect((await guard.aiAllowance()).state).toBe('unavailable');
  });

  it('starts the AI counter again on the next UTC day', async () => {
    const { guard, time } = setup('2026-10-19T23:59:00Z', { flushAfter: 1 });
    await guard.record({ aiNeurons: 9000 });
    time.set('2026-10-20T00:00:30Z');
    expect(await guard.aiAllowance()).toMatchObject({ state: 'ok', used: 0 });
  });

  it('starts ok with everything at zero and a snapshot that matches the contract', async () => {
    const { guard } = setup();
    const snapshot = await guard.snapshot();
    expect(usageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      day: '2026-10-19',
      generatedAt: '2026-10-19T10:00:00.000Z',
      resetsAt: '2026-10-20T00:00:00.000Z',
      state: 'ok',
      thresholds: { warnPercent: 60, blockPercent: 80 },
    });
    expect(snapshot.metrics.workerRequests).toEqual({ used: 0, limit: 100_000, percent: 0, state: 'ok' });
    expect(snapshot.metrics.storageBytes.limit).toBe(1_000_000_000);
  });

  it('records usage and reports used, limit, percent and state per metric', async () => {
    const { guard } = setup();
    await guard.record({ workerRequests: 25_000, durableObjectGbSeconds: 7_800 });
    const { metrics, state } = await guard.snapshot();
    expect(metrics.workerRequests).toEqual({ used: 25_000, limit: 100_000, percent: 25, state: 'ok' });
    expect(metrics.durableObjectGbSeconds).toEqual({ used: 7_800, limit: 13_000, percent: 60, state: 'warn' });
    expect(state).toBe('warn');
  });

  it('is warn at exactly 60 % and blocked at exactly 80 %, and one below stays in the lower state', async () => {
    const { guard } = setup();
    await guard.record({ rowsWritten: 59_999 });
    expect((await guard.snapshot()).state).toBe('ok');
    await guard.record({ rowsWritten: 1 });
    expect((await guard.snapshot()).metrics.rowsWritten.state).toBe('warn');
    await guard.record({ rowsWritten: 19_999 });
    expect((await guard.snapshot()).state).toBe('warn');
    await guard.record({ rowsWritten: 1 });
    const blocked = await guard.snapshot();
    expect(blocked.metrics.rowsWritten).toEqual({ used: 80_000, limit: 100_000, percent: 80, state: 'blocked' });
    expect(blocked.state).toBe('blocked');
  });

  it('takes the worst metric as the overall state', async () => {
    const { guard } = setup();
    await guard.record({ workerRequests: 61_000, rowsRead: 4_100_000 });
    const snapshot = await guard.snapshot();
    expect([snapshot.metrics.workerRequests.state, snapshot.metrics.rowsRead.state, snapshot.state]).toEqual(['warn', 'blocked', 'blocked']);
  });

  it('records rows read and written for the Durable Object adapters', async () => {
    const { guard } = setup();
    await guard.recordRows({ read: 120, written: 3 });
    await guard.recordRows({ read: 5 });
    await guard.recordRows({});
    const { metrics } = await guard.snapshot();
    expect([metrics.rowsRead.used, metrics.rowsWritten.used]).toEqual([125, 3]);
  });

  it('ignores negative, zero, NaN and infinite amounts', async () => {
    const { guard, store } = setup();
    await guard.record({ workerRequests: -5, rowsRead: Number.NaN, rowsWritten: Number.POSITIVE_INFINITY, durableObjectRequests: 0 });
    expect(store.adds).toBe(0);
    expect((await guard.snapshot()).metrics.workerRequests.used).toBe(0);
  });

  it('measures the storage gauge from the injected reader, not from the ledger', async () => {
    const bytes = vi.fn(() => 800_000_000);
    const { guard } = setup(undefined, { readStorageBytes: bytes });
    const decision = await guard.check('read');
    expect(decision).toMatchObject({ allowed: false, state: 'blocked', blockedMetrics: ['storageBytes'], retryAfterSeconds: 3600 });
    bytes.mockReturnValue(600_000_000);
    expect((await guard.snapshot()).metrics.storageBytes).toMatchObject({ used: 600_000_000, percent: 60, state: 'warn' });
  });

  it('fails closed when the storage reader fails or returns nonsense', async () => {
    const reader = vi.fn<() => number | Promise<number>>().mockRejectedValue(new Error('no size'));
    const { guard } = setup(undefined, { readStorageBytes: reader });
    expect((await guard.check('write')).state).toBe('unavailable');
    reader.mockRejectedValue('plain text failure');
    expect((await guard.check('write')).state).toBe('unavailable');
    reader.mockResolvedValue(Number.NaN);
    expect((await guard.check('write')).allowed).toBe(false);
    reader.mockReturnValue(-1);
    expect((await guard.check('write')).allowed).toBe(false);
  });

  describe('check', () => {
    it('allows every kind of work while ok or warn and refuses all of it when blocked', async () => {
      const { guard } = setup();
      for (const kind of ['read', 'write', 'job'] as const) expect((await guard.check(kind)).allowed).toBe(true);
      await guard.record({ workerRequests: 60_000 });
      expect(await guard.check('write')).toMatchObject({ allowed: true, state: 'warn', blockedMetrics: [] });
      await guard.record({ workerRequests: 20_000 });
      for (const kind of ['read', 'write', 'job'] as const) {
        expect(await guard.check(kind)).toMatchObject({ allowed: false, state: 'blocked', blockedMetrics: ['workerRequests'] });
      }
    });

    it('tells when to retry: the next UTC midnight', async () => {
      const { guard } = setup('2026-10-19T22:30:00Z');
      await guard.record({ durableObjectRequests: 80_000 });
      expect((await guard.check('read')).retryAfterSeconds).toBe(5400);
    });

    it('starts the new UTC day at zero after midnight and unblocks', async () => {
      const { guard, time } = setup('2026-10-19T23:59:59.999Z');
      await guard.record({ workerRequests: 90_000 });
      expect((await guard.check('read')).allowed).toBe(false);
      time.set('2026-10-20T00:00:00.000Z');
      expect(await guard.check('read')).toMatchObject({ allowed: true, state: 'ok' });
      const snapshot = await guard.snapshot();
      expect([snapshot.day, snapshot.metrics.workerRequests.used, snapshot.resetsAt]).toEqual(['2026-10-20', 0, '2026-10-21T00:00:00.000Z']);
    });

    it('counts usage recorded just before and just after midnight on their own days', async () => {
      const { guard, time, store } = setup('2026-10-19T23:59:59.999Z');
      await guard.record({ rowsRead: 10 });
      time.set('2026-10-20T00:00:00.000Z');
      await guard.record({ rowsRead: 3 });
      expect((await store.read('2026-10-19')).rowsRead).toBe(10);
      expect((await store.read('2026-10-20')).rowsRead).toBe(3);
    });

    it('logs a warning when the state gets worse and an info line when it recovers, once per change', async () => {
      const { guard, log, time } = setup();
      await guard.record({ workerRequests: 61_000 });
      await guard.check('read');
      await guard.check('read');
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenLastCalledWith('Budget guard state is warn', { state: 'warn', blockedMetrics: [] });
      await guard.record({ workerRequests: 20_000 });
      await guard.check('read');
      expect(log.warn).toHaveBeenLastCalledWith('Budget guard state is blocked', { state: 'blocked', blockedMetrics: ['workerRequests'] });
      time.set('2026-10-20T00:00:00Z');
      await guard.check('read');
      expect(log.info).toHaveBeenCalledWith('Budget guard back under the warning threshold', { state: 'ok', blockedMetrics: [] });
    });
  });

  describe('when the store fails (fail closed)', () => {
    it('allows only reads, reports unavailable and logs one warning', async () => {
      const { guard, store, log } = setup();
      store.failing = true;
      expect(await guard.check('read')).toEqual({ allowed: true, state: 'unavailable', blockedMetrics: [], retryAfterSeconds: 60 });
      expect((await guard.check('write')).allowed).toBe(false);
      expect((await guard.check('job')).allowed).toBe(false);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith('Budget guard state is unavailable', { state: 'unavailable', blockedMetrics: [], error: 'store down' });
    });

    it('still answers the snapshot, flagged unavailable and built from what is buffered', async () => {
      const { guard, store } = setup(undefined, { flushAfter: 10 });
      await guard.record({ workerRequests: 4 });
      store.failing = true;
      const snapshot = await guard.snapshot();
      expect(snapshot.state).toBe('unavailable');
      expect(snapshot.metrics.workerRequests.used).toBe(4);
    });

    it('recovers when the store is back', async () => {
      const { guard, store } = setup();
      store.failing = true;
      await guard.check('write');
      store.failing = false;
      expect(await guard.check('write')).toMatchObject({ allowed: true, state: 'ok' });
    });

    it('keeps usage that could not be written and writes it with the next flush', async () => {
      const { guard, store, log } = setup();
      store.failing = true;
      await expect(guard.record({ rowsRead: 5 })).resolves.toBeUndefined();
      await guard.record({ rowsRead: 6 });
      expect(log.warn).toHaveBeenCalledTimes(1);
      store.failing = false;
      await guard.flush();
      expect((await store.read('2026-10-19')).rowsRead).toBe(11);
      await guard.record({ rowsRead: 1 });
      expect((await store.read('2026-10-19')).rowsRead).toBe(12);
    });

    it('does not fail when pruning fails', async () => {
      const { guard, store, log } = setup();
      store.failPrune = true;
      await expect(guard.record({ rowsRead: 1 })).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith('Budget guard could not prune old usage', { error: 'prune failed' });
    });
  });

  describe('concurrency and buffering', () => {
    it('loses no increment when many record calls run at once', async () => {
      const { guard } = setup();
      await Promise.all(Array.from({ length: 200 }, () => guard.record({ workerRequests: 1, rowsWritten: 2 })));
      const { metrics } = await guard.snapshot();
      expect([metrics.workerRequests.used, metrics.rowsWritten.used]).toEqual([200, 400]);
    });

    it('loses no increment when records and checks interleave with a failing, then recovering, store', async () => {
      const { guard, store } = setup();
      store.failing = true;
      await Promise.all(Array.from({ length: 20 }, () => guard.record({ rowsRead: 1 })));
      store.failing = false;
      await Promise.all(Array.from({ length: 20 }, () => guard.record({ rowsRead: 1 })));
      await guard.flush();
      expect((await store.read('2026-10-19')).rowsRead).toBe(40);
    });

    it('buffers writes until flushAfter calls, counts the buffer in checks and writes one row per flush', async () => {
      const { guard, store } = setup(undefined, { flushAfter: 5 });
      for (let i = 0; i < 4; i++) await guard.record({ workerRequests: 1 });
      expect(store.adds).toBe(0);
      expect((await guard.snapshot()).metrics.workerRequests.used).toBe(4);
      await guard.record({ workerRequests: 1 });
      expect(store.adds).toBe(1);
      expect((await store.read('2026-10-19')).workerRequests).toBe(5);
    });

    it('flushes usage buffered for two UTC days to their own days and ignores an empty flush', async () => {
      const { guard, time, store } = setup('2026-10-19T23:59:00Z', { flushAfter: 100 });
      await guard.flush();
      expect(store.adds).toBe(0);
      await guard.record({ rowsRead: 1 });
      time.set('2026-10-20T00:01:00Z');
      await guard.record({ rowsRead: 2 });
      await guard.flush();
      expect([(await store.read('2026-10-19')).rowsRead, (await store.read('2026-10-20')).rowsRead]).toEqual([1, 2]);
    });

    it('prunes days older than the retention when a new day is written, once per day', async () => {
      const { guard, time, store } = setup('2026-10-01T10:00:00Z', { retainDays: 3 });
      await guard.record({ rowsRead: 1 });
      for (const day of ['02', '03', '04', '05']) {
        time.set(`2026-10-${day}T10:00:00Z`);
        await guard.record({ rowsRead: 1 });
      }
      expect(store.inner.days).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
      time.set('2026-10-05T11:00:00Z');
      const prune = vi.spyOn(store, 'prune');
      await guard.record({ rowsRead: 1 });
      expect(prune).not.toHaveBeenCalled();
    });
  });

  it('uses the defaults for clock, logger, limits and flush settings', async () => {
    const guard = new BudgetGuard({ store: new MemoryUsageStore(), flushAfter: 0, retainDays: 0 });
    await guard.record({ workerRequests: 1 });
    const snapshot: UsageSnapshot = await guard.snapshot();
    expect(snapshot.metrics.workerRequests.used).toBe(1);
    expect(snapshot.metrics.workerRequests.limit).toBe(100_000);
  });

  it('measures against custom limits', async () => {
    const { guard } = setup(undefined, { limits: { ...METRIC_LIMITS, rowsRead: 10 } });
    await guard.record({ rowsRead: 8 });
    expect((await guard.check('read')).allowed).toBe(false);
  });
});
