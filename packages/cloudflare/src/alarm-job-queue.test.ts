import { JOBS, MAX_JOB_STEPS, SCHEDULED_JOBS, type JobHandler, type JobPayloads, type JobRegistry } from '@portfolio/platform';
import { runJobQueueContract } from '@portfolio/platform/testing';
import { describe, expect, it } from 'vitest';
import { SqlJsStorage, TestClock } from '../test/sqljs-storage.js';
import { AlarmJobQueue, backoffMs, runAlarm, type AlarmEvent, type AlarmJobQueueOptions } from './alarm-job-queue.js';
import type { SqlUsage } from './sql.js';

const NOTHING = { schedules: [] } satisfies AlarmJobQueueOptions;
const payload = { userId: 'u1', portfolioId: 'p1' };
const ok = (result: unknown = null) => Promise.resolve({ done: true as const, result });

const setup = async (options: AlarmJobQueueOptions = NOTHING) => {
  const storage = await SqlJsStorage.create();
  const clock = new TestClock();
  let counter = 0;
  const queue = new AlarmJobQueue(storage, { now: clock.now, uuid: () => `job-${++counter}`, ...options });
  return { storage, clock, queue };
};

const registry = (handler: JobHandler<JobPayloads['syncBroker']>): JobRegistry => ({ syncBroker: handler });

runJobQueueContract('AlarmJobQueue (SQLite in Node)', async () => {
  const { queue, clock } = await setup({ ...NOTHING, baseBackoffMs: 1000 });
  const handlers: JobRegistry = {};
  return {
    queue,
    register: (handler) => {
      handlers.syncBroker = handler;
    },
    // What the Durable Object alarm does: run what is due, then wake up at the next due time.
    drain: async function drain(round = 0): Promise<void> {
      if (round >= 50) throw new Error('The queue did not drain');
      await queue.runAlarm(handlers);
      const due = queue.nextJobDueAt();
      if (due === null) return;
      clock.ms = Math.max(clock.ms, due);
      await drain(round + 1);
    },
  };
});

describe('backoffMs', () => {
  it('doubles per failure up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6].map((failure) => backoffMs(failure, 5_000, 30_000))).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  });

  it('never goes below the base delay or overflows for a huge failure count', () => {
    expect(backoffMs(0, 100, 1_000)).toBe(100);
    expect(backoffMs(5_000, 100, 1_000)).toBe(1_000);
  });
});

describe('AlarmJobQueue.enqueue', () => {
  it('stores the job and arms the alarm at its due time', async () => {
    const { queue, storage, clock } = await setup();
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    await queue.enqueue({ job: JOBS.syncBroker, payload: { all: true }, delayMs: 60_000 });
    expect(storage.rows('SELECT id, job, payload, due_at, state FROM jobs ORDER BY id')).toEqual([
      { id: 'job-1', job: 'syncBroker', payload: JSON.stringify(payload), due_at: clock.ms, state: 'pending' },
      { id: 'job-2', job: 'syncBroker', payload: '{"all":true}', due_at: clock.ms + 60_000, state: 'pending' },
    ]);
    expect(storage.alarm).toBe(clock.ms); // the earlier due time wins, the later job did not move it
  });

  it('moves the alarm earlier, never later, and does not re-set an alarm that is already right', async () => {
    const { queue, storage, clock } = await setup();
    await queue.enqueue({ job: JOBS.syncBroker, payload, delayMs: 5_000 });
    await queue.enqueue({ job: JOBS.syncBroker, payload, delayMs: 9_000 });
    expect(storage.alarm).toBe(clock.ms + 5_000);
    await queue.enqueue({ job: JOBS.syncBroker, payload, delayMs: 1_000 });
    expect(storage.alarm).toBe(clock.ms + 1_000);
    expect(storage.alarmCalls).toEqual([clock.ms + 5_000, clock.ms + 1_000]);
  });

  it('rejects a negative or non-finite delay', async () => {
    const { queue, storage } = await setup();
    const refused = [-1, Number.NaN, Number.POSITIVE_INFINITY].map((delayMs) => expect(queue.enqueue({ job: JOBS.syncBroker, payload, delayMs })).rejects.toThrow(RangeError));
    await Promise.all(refused);
    expect(storage.rows('SELECT id FROM jobs')).toEqual([]);
  });

  it('uses random ids by default', async () => {
    const storage = await SqlJsStorage.create();
    const queue = new AlarmJobQueue(storage, NOTHING);
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    expect(storage.rows<{ id: string }>('SELECT id FROM jobs')[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AlarmJobQueue.runAlarm', () => {
  it('does not run a job before its delay has passed', async () => {
    const { queue, clock } = await setup();
    const calls: unknown[] = [];
    await queue.enqueue({ job: JOBS.syncBroker, payload, delayMs: 10_000 });
    const handlers = registry((invocation) => {
      calls.push(invocation);
      return ok();
    });
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 0, nextAlarm: clock.ms + 10_000 });
    clock.advance(10_000);
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 1, completed: 1, nextAlarm: null });
    expect(calls).toEqual([{ payload, cursor: undefined }]);
  });

  it('runs due jobs oldest due time first', async () => {
    const { queue, clock } = await setup();
    const order: string[] = [];
    await queue.enqueue({ job: JOBS.syncBroker, payload: { userId: 'late', portfolioId: 'p' }, delayMs: 5 });
    await queue.enqueue({ job: JOBS.syncBroker, payload: { userId: 'early', portfolioId: 'p' } });
    clock.advance(10);
    await queue.runAlarm(
      registry(({ payload: p }) => {
        order.push((p as { userId: string }).userId);
        return ok();
      }),
    );
    expect(order).toEqual(['early', 'late']);
  });

  it('persists the cursor between steps and honours the delay of a step', async () => {
    const { queue, storage, clock } = await setup();
    const seen: (string | undefined)[] = [];
    const handlers = registry(({ cursor }) => {
      seen.push(cursor);
      if (cursor === undefined) return Promise.resolve({ done: false, next: '{"page":2}', delayMs: 30_000 });
      return ok('finished');
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    const first = await queue.runAlarm(handlers);
    expect(first).toMatchObject({ steps: 1, completed: 0, nextAlarm: clock.ms + 30_000 });
    expect(storage.alarm).toBe(clock.ms + 30_000);
    expect(storage.rows('SELECT cursor, attempts, steps FROM jobs')).toEqual([{ cursor: '{"page":2}', attempts: 0, steps: 1 }]);
    clock.advance(30_000);
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 1, completed: 1 });
    expect(seen).toEqual([undefined, '{"page":2}']);
    expect(storage.rows('SELECT id FROM jobs')).toEqual([]);
  });

  it('runs the steps of a job without delay back to back in one alarm', async () => {
    const { queue } = await setup();
    const handlers = registry(({ cursor }) => (Number(cursor ?? 0) < 3 ? Promise.resolve({ done: false, next: String(Number(cursor ?? 0) + 1) }) : ok()));
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 4, completed: 1 });
  });

  it('retries a failing step with capped exponential backoff and then marks the job failed', async () => {
    const events: AlarmEvent[] = [];
    const { queue, storage, clock } = await setup({ ...NOTHING, baseBackoffMs: 1_000, maxBackoffMs: 3_000, maxAttempts: 5, onEvent: (event) => events.push(event) });
    let calls = 0;
    const handlers = registry(() => {
      calls++;
      return Promise.reject(new Error('upstream down'));
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    // Runs the alarm whenever it is due, and collects how long the queue waited before every retry.
    const waits = async (delays: number[] = []): Promise<number[]> => {
      const report = await queue.runAlarm(handlers);
      if (report.nextAlarm === null || delays.length >= 8) return delays;
      delays.push(report.nextAlarm - clock.ms);
      clock.ms = report.nextAlarm;
      return waits(delays);
    };
    const delays = await waits();
    expect(calls).toBe(5);
    expect(delays).toEqual([1_000, 2_000, 3_000, 3_000]);
    expect(queue.failedJobs()).toEqual([{ id: 'job-1', job: 'syncBroker', attempts: 5, error: 'upstream down', updatedAt: clock.ms }]);
    expect(events.map((event) => event.type)).toEqual(['retry', 'retry', 'retry', 'retry', 'failed']);
    expect(events[0]).toEqual({ type: 'retry', job: 'syncBroker', attempt: 1, retryInMs: 1_000, error: 'upstream down' });
    expect(storage.rows<{ state: string }>('SELECT state FROM jobs')).toEqual([{ state: 'failed' }]);
    // Failed for good: later alarms do nothing.
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 0, nextAlarm: null });
    expect(calls).toBe(5);
  });

  it('redelivers a failed step with the same cursor, and a success clears the attempts', async () => {
    const { queue, storage, clock } = await setup();
    let failures = 1;
    const cursors: (string | undefined)[] = [];
    const handlers = registry(({ cursor }) => {
      cursors.push(cursor);
      if (cursor === undefined) return Promise.resolve({ done: false, next: 'p2', delayMs: 1 });
      if (failures-- > 0) return Promise.reject(new Error('flaky'));
      return ok();
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    await queue.runAlarm(handlers);
    clock.advance(1);
    await queue.runAlarm(handlers);
    expect(storage.rows('SELECT attempts, last_error, cursor FROM jobs')).toEqual([{ attempts: 1, last_error: 'flaky', cursor: 'p2' }]);
    clock.advance(5_000);
    await queue.runAlarm(handlers);
    expect(cursors).toEqual([undefined, 'p2', 'p2']);
    expect(storage.rows('SELECT id FROM jobs')).toEqual([]);
  });

  it('retries and eventually fails a job that has no handler, and keeps the error short and free of the payload', async () => {
    const { queue, clock } = await setup({ ...NOTHING, maxAttempts: 2 });
    await queue.enqueue({ job: JOBS.refreshPrices, payload: { trigger: 'scheduled' } });
    await queue.runAlarm({});
    clock.advance(60_000);
    await queue.runAlarm({});
    expect(queue.failedJobs()).toMatchObject([{ job: 'refreshPrices', error: 'No handler registered for job "refreshPrices"' }]);

    await queue.enqueue({ job: JOBS.syncBroker, payload: { userId: 'secret-user', portfolioId: 'p' } });
    const long = 'x'.repeat(2_000);
    await queue.runAlarm(registry(() => Promise.reject(new Error(long))));
    clock.advance(60_000);
    await queue.runAlarm(registry(() => Promise.reject(long)));
    const failed = queue.failedJobs().find((job) => job.job === 'syncBroker')!;
    expect(failed.error).toHaveLength(500);
    expect(JSON.stringify(failed)).not.toContain('secret-user');
  });

  it('fails a job that never finishes instead of looping forever', async () => {
    const { queue, storage } = await setup();
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    storage.rows('UPDATE jobs SET steps = ?', MAX_JOB_STEPS - 1);
    const report = await queue.runAlarm(registry(() => Promise.resolve({ done: false, next: 'again' })));
    expect(report).toMatchObject({ steps: 1, failed: 1, nextAlarm: null });
    expect(queue.failedJobs()[0]!.error).toBe(`Job did not finish within ${MAX_JOB_STEPS} steps`);
  });

  it('is idempotent when the alarm fires twice in a row', async () => {
    const { queue, storage } = await setup();
    let calls = 0;
    const handlers = registry(() => {
      calls++;
      return ok();
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    await queue.runAlarm(handlers);
    const before = storage.rows('SELECT * FROM jobs');
    expect(await queue.runAlarm(handlers)).toEqual({ steps: 0, completed: 0, retried: 0, failed: 0, nextAlarm: null });
    expect(storage.rows('SELECT * FROM jobs')).toEqual(before);
    expect(calls).toBe(1);
  });

  it('joins a run in progress when the alarm fires twice at once, so a step never runs twice in parallel', async () => {
    const { queue } = await setup();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers = registry(async () => {
      calls++;
      await gate;
      return { done: true, result: null };
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    const [first, second] = [queue.runAlarm(handlers), queue.runAlarm(handlers)];
    expect(second).toBe(first);
    release();
    expect(await first).toMatchObject({ steps: 1, completed: 1 });
    expect(calls).toBe(1);
    // A later alarm starts a new run.
    expect(queue.runAlarm(handlers)).not.toBe(first);
  });

  it('survives a crash mid-step: the unfinished step is delivered again by the next alarm', async () => {
    const { queue, storage } = await setup();
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    // A restarted object is a new queue over the same storage; the first one never recorded the step.
    const restarted = new AlarmJobQueue(storage, { ...NOTHING, now: () => new Date(Date.UTC(2026, 0, 5, 9)) });
    let calls = 0;
    await restarted.runAlarm(registry(() => {
      calls++;
      return ok();
    }));
    expect(calls).toBe(1);
  });

  it('yields after maxStepsPerRun and re-arms the alarm for right now', async () => {
    const { queue, clock, storage } = await setup({ ...NOTHING, maxStepsPerRun: 2 });
    await Promise.all(Array.from({ length: 5 }, () => queue.enqueue({ job: JOBS.syncBroker, payload })));
    let calls = 0;
    const handlers = registry(() => {
      calls++;
      return ok();
    });
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 2, completed: 2, nextAlarm: clock.ms });
    expect(storage.alarm).toBe(clock.ms);
    await queue.runAlarm(handlers);
    await queue.runAlarm(handlers);
    expect(calls).toBe(5);
  });

  it('yields after maxRunMs of wall-clock time', async () => {
    const { queue, clock } = await setup({ ...NOTHING, maxRunMs: 25_000 });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    const handlers = registry(() => {
      clock.advance(10_000);
      return Promise.resolve({ done: false, next: 'more' });
    });
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 3, completed: 0, nextAlarm: clock.ms });
  });

  it('prunes failed jobs after the retention time', async () => {
    const { queue, clock, storage } = await setup({ ...NOTHING, maxAttempts: 1, failedRetentionMs: 60_000 });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    await queue.runAlarm(registry(() => Promise.reject(new Error('x'))));
    expect(queue.failedJobs()).toHaveLength(1);
    clock.advance(59_000);
    await queue.runAlarm({});
    expect(queue.failedJobs()).toHaveLength(1);
    clock.advance(2_000);
    await queue.runAlarm({});
    expect(storage.rows('SELECT id FROM jobs')).toEqual([]);
  });

  it('ignores options that are explicitly undefined', async () => {
    const { queue } = await setup({ ...NOTHING, maxAttempts: undefined, baseBackoffMs: undefined });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    expect(await queue.runAlarm(registry(() => Promise.reject(new Error('x'))))).toMatchObject({ retried: 1 });
  });

  it('reports step outcomes through onEvent', async () => {
    const events: AlarmEvent[] = [];
    const { queue } = await setup({ ...NOTHING, onEvent: (event) => events.push(event) });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    await queue.runAlarm(registry(({ cursor }) => (cursor === undefined ? Promise.resolve({ done: false, next: 'n', delayMs: -5 }) : ok({ synced: 2 }))));
    expect(events).toEqual([
      { type: 'continued', job: 'syncBroker', delayMs: 0 },
      { type: 'completed', job: 'syncBroker', result: { synced: 2 } },
    ]);
  });

  it('reports the rows it reads and writes', async () => {
    const usage: SqlUsage[] = [];
    const { queue } = await setup({ ...NOTHING, onUsage: (delta) => usage.push(delta) });
    await queue.enqueue({ job: JOBS.syncBroker, payload });
    await queue.runAlarm(registry(() => ok()));
    expect(usage.reduce((sum, delta) => sum + delta.rowsWritten, 0)).toBe(2); // insert, delete
  });
});

describe('cron schedules', () => {
  // The price and broker schedules; the Trading 212 quote schedules have their own test below.
  const SHARED = { schedules: SCHEDULED_JOBS.filter((job) => job.job !== JOBS.refreshT212Quotes) } satisfies AlarmJobQueueOptions;
  // The clock starts Monday 2026-01-05 09:00 UTC = 10:00 in Amsterdam; the next prices slot is 13:00 local = 12:00 UTC.
  const SLOTS = { prices: Date.UTC(2026, 0, 5, 12), nextPrices: Date.UTC(2026, 0, 5, 17), calendar: Date.UTC(2026, 0, 6, 4, 30), broker: Date.UTC(2026, 0, 6, 5, 30) };

  it('arm() records the next slot of every schedule and arms the alarm for the earliest', async () => {
    const { queue, storage } = await setup(SHARED);
    expect(await queue.arm()).toBe(SLOTS.prices);
    expect(storage.alarm).toBe(SLOTS.prices);
    expect(storage.rows('SELECT name, next_run_at FROM schedules ORDER BY name')).toEqual(
      [
        { name: 'broker-sync', next_run_at: SLOTS.broker },
        { name: 'prices-calendar', next_run_at: SLOTS.calendar },
        { name: 'prices-refresh', next_run_at: SLOTS.prices },
      ],
    );
    // Arming again changes nothing and does not set the alarm again.
    expect(await queue.arm()).toBe(SLOTS.prices);
    expect(storage.alarmCalls).toEqual([SLOTS.prices]);
  });

  it('arm() has nothing to arm without schedules or jobs', async () => {
    const { queue, storage } = await setup();
    expect(await queue.arm()).toBeNull();
    expect(storage.alarm).toBeNull();
  });

  it('enqueues the due job once, runs it, and moves the alarm to the next slot', async () => {
    const { queue, storage, clock } = await setup(SHARED);
    await queue.arm();
    const calls: unknown[] = [];
    const handlers: JobRegistry = {
      refreshPrices: (invocation) => {
        calls.push(invocation);
        return ok('refreshed');
      },
    };
    clock.ms = SLOTS.prices;
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 1, completed: 1, nextAlarm: SLOTS.nextPrices });
    expect(calls).toEqual([{ payload: { trigger: 'scheduled' }, cursor: undefined }]);
    // The alarm fires again for the same slot: nothing is enqueued twice.
    expect(await queue.runAlarm(handlers)).toMatchObject({ steps: 0, nextAlarm: SLOTS.nextPrices });
    expect(calls).toHaveLength(1);
    expect(storage.rows('SELECT next_run_at FROM schedules WHERE name = ?', 'prices-refresh')).toEqual([{ next_run_at: SLOTS.nextPrices }]);
  });

  it('enqueues a slot only once even when the alarm fires twice before the job could run', async () => {
    const { queue, storage, clock } = await setup(SHARED);
    await queue.arm();
    clock.ms = SLOTS.prices;
    await queue.runAlarm({}); // no handler: the job stays open (retried later)
    await queue.runAlarm({});
    expect(storage.rows("SELECT id FROM jobs WHERE id LIKE 'schedule:%'")).toEqual([{ id: `schedule:prices-refresh:${SLOTS.prices}` }]);
  });

  it('runs a schedule once after a long absence instead of once per missed slot', async () => {
    const { queue, clock } = await setup(SHARED);
    await queue.arm();
    let calls = 0;
    clock.ms = Date.UTC(2026, 0, 9, 12); // Friday: four days of missed slots
    await queue.runAlarm({
      refreshPrices: () => {
        calls++;
        return ok();
      },
    });
    expect(calls).toBe(1);
  });

  it('keeps jobs and schedules in one alarm: the earlier due time wins', async () => {
    const { queue, storage, clock } = await setup(SHARED);
    await queue.arm();
    await queue.enqueue({ job: JOBS.syncBroker, payload, delayMs: 1_000 });
    expect(storage.alarm).toBe(clock.ms + 1_000);
    clock.advance(1_000);
    await queue.runAlarm(registry(() => ok()));
    expect(storage.alarm).toBe(SLOTS.prices);
  });

  it('uses the shared schedules by default', () => {
    expect(SCHEDULED_JOBS.map((job) => job.name).sort((a, b) => a.localeCompare(b))).toEqual(['broker-sync', 'broker-sync-intraday', 'notify-dividends', 'prices-calendar', 'prices-refresh', 't212-quotes', 't212-quotes-close']);
  });

  it('arms the alarm for the Trading 212 quote schedules and enqueues the job per slot', async () => {
    const { queue, storage, clock } = await setup({});
    // Monday 2026-01-05 09:00Z = 10:00 local: the next quote slot is 10:15 local = 09:15Z.
    const slot = Date.UTC(2026, 0, 5, 9, 15);
    expect(await queue.arm()).toBe(slot);
    expect(storage.rows("SELECT next_run_at FROM schedules WHERE name = 't212-quotes'")).toEqual([{ next_run_at: slot }]);
    clock.ms = slot;
    const calls: unknown[] = [];
    const report = await queue.runAlarm({
      refreshT212Quotes: (invocation) => {
        calls.push(invocation);
        return ok();
      },
    });
    expect(calls).toEqual([{ payload: { trigger: 'scheduled' }, cursor: undefined }]);
    expect(report).toMatchObject({ steps: 1, completed: 1, nextAlarm: slot + 15 * 60_000 });
  });

  it('sleeps over the weekend: the next quote slot is the only wake-up', async () => {
    const quotesOnly = { schedules: SCHEDULED_JOBS.filter((job) => job.job === JOBS.refreshT212Quotes) };
    const { queue, storage, clock } = await setup(quotesOnly);
    clock.ms = Date.UTC(2026, 0, 9, 21, 5); // Friday 22:05 local: the close run was the last of the week
    expect(await queue.arm()).toBe(Date.UTC(2026, 0, 12, 6, 0)); // Monday 07:00 local
    expect(storage.alarm).toBe(Date.UTC(2026, 0, 12, 6, 0));
  });
});

describe('runAlarm', () => {
  it('runs the due jobs of a storage', async () => {
    const storage = await SqlJsStorage.create();
    const clock = new TestClock();
    await new AlarmJobQueue(storage, { ...NOTHING, now: clock.now }).enqueue({ job: JOBS.syncBroker, payload });
    const report = await runAlarm({ storage, handlers: registry(() => ok()), now: clock.now, ...NOTHING });
    expect(report).toMatchObject({ steps: 1, completed: 1 });
  });
});
