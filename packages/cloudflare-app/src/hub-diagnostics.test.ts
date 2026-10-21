import { JOBS, type JobHandler } from '@portfolio/platform';
import type { SqlValue } from '@portfolio/cloudflare';
import { alarmDiagnosticsSchema, type AlarmDiagnosticsReport } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { Browser } from '../test/browser.js';
import { createNodeStack, type NodeStackOptions } from '../test/node-stack.js';
import { CORE_JOB_FACTORIES, type JobFactories } from './jobs.js';

const never = (): Promise<never> => new Promise<never>(() => undefined);
const done = (result: unknown = null) => Promise.resolve({ done: true as const, result });
const payload = { all: true } as const;

async function setup(jobFactories: JobFactories, options: NodeStackOptions = {}) {
  const stack = await createNodeStack({ jobFactories, ...options });
  const owner = new Browser(stack);
  await owner.signIn();
  const report = async (query = ''): Promise<AlarmDiagnosticsReport> => {
    const response = await owner.request(`/api/diagnostics/alarms${query}`);
    expect(response.status).toBe(200);
    return alarmDiagnosticsSchema.parse(await response.json());
  };
  const alarm = (info?: Parameters<typeof stack.core.alarm>[0]) => stack.storage.runAlarmHandler(() => stack.core.alarm(info));
  return { stack, owner, report, alarm };
}

const only = (handlers: JobFactories): JobFactories => ({ ...handlers });

/** Runs `step` `times` times in sequence (no `await` in a loop). */
const repeat = async (times: number, step: () => Promise<unknown>): Promise<void> => {
  if (times <= 0) return;
  await step();
  await repeat(times - 1, step);
};

describe('alarm diagnostics in the Hub', () => {
  it('records a completed run: what was due, the jobs, the subrequests, the retry info and the next alarm', async () => {
    const { stack, report, alarm } = await setup(only({ syncBroker: () => () => done({ ok: true }) }));
    await stack.enqueue('syncBroker', payload);
    const scheduledFor = stack.clock.ms - 7;
    await alarm({ retryCount: 0, isRetry: false, scheduledTime: scheduledFor });
    const { runs, summary } = await report();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      startedAt: stack.clock.ms,
      finishedAt: stack.clock.ms,
      durationMs: 0,
      retryCount: 0,
      isRetry: false,
      scheduledFor,
      trigger: 'jobs: syncBroker',
      outcome: 'completed',
      unfinished: false,
      jobs: [{ job: 'syncBroker', outcome: 'done', steps: 1, delayMs: null }],
      subrequests: 0,
      error: null,
    });
    expect(runs[0]!.nextAlarmAt).toBeGreaterThanOrEqual(stack.clock.ms);
    expect(summary).toMatchObject({ runs: 1, completed: 1, deferred: 0, failed: 0, unfinished: 0, retries: 0 });
  });

  it('reads the alarm time from the storage when the runtime gives none, and counts the platform retries', async () => {
    const { stack, report, alarm } = await setup(only({ syncBroker: () => () => done() }));
    await alarm({ retryCount: 2, isRetry: true });
    await alarm();
    const armed = stack.storage.alarm;
    await stack.core.alarm(); // outside the runtime's handler `getAlarm` still has the time
    const { runs, summary } = await report();
    expect(runs.map((run) => [run.retryCount, run.isRetry])).toEqual([
      [0, false],
      [0, false],
      [2, true],
    ]);
    // Inside a handler the runtime reports no alarm and gives no time here: unknown, never a wrong one.
    expect(runs.slice(1).map((run) => run.scheduledFor)).toEqual([null, null]);
    expect(runs[0]!.scheduledFor).toBe(armed);
    expect(summary).toMatchObject({ retries: 1, maxRetryCount: 2 });
  });

  it('says what was due when a schedule slot fired, with names only', async () => {
    const { stack, report, alarm } = await setup(CORE_JOB_FACTORIES);
    const slot = stack.storage.rows<{ next_run_at: number }>("SELECT next_run_at FROM schedules WHERE name = 't212-quotes'")[0]!.next_run_at;
    stack.clock.ms = slot;
    await alarm();
    const first = (await report()).runs[0]!;
    expect(first.trigger).toContain('schedules:');
    expect(first.trigger).toContain('t212-quotes');
    expect(first.jobs.map((job) => job.job)).toContain('refreshT212Quotes');
    expect(first.trigger).not.toContain('payload');
  });

  it('ends a run that handed work to a later alarm as deferred, and shows the pause', async () => {
    const pause: JobHandler<never> = () => Promise.resolve({ done: false as const, next: 'later', delayMs: 60_000 });
    const { stack, report, alarm } = await setup(only({ syncBroker: () => pause as never }));
    await stack.enqueue('syncBroker', payload);
    await alarm();
    const { runs, summary } = await report();
    expect(runs[0]).toMatchObject({ outcome: 'deferred', jobs: [{ job: 'syncBroker', outcome: 'continued', steps: 1, delayMs: 60_000 }], nextAlarmAt: stack.clock.ms + 60_000 });
    expect(summary.deferred).toBe(1);
  });

  it('keeps the start of a run whose invocation never ends: no finish, reported as unfinished once it is old enough', async () => {
    const { stack, report } = await setup(only({ syncBroker: () => never }));
    await stack.enqueue('syncBroker', payload);
    const hung = stack.storage.runAlarmHandler(() => stack.core.alarm());
    await new Promise((resolve) => setTimeout(resolve, 0));
    let live = await report();
    expect(live.runs[0]).toMatchObject({ finishedAt: null, outcome: null, unfinished: false });
    expect(live.summary).toMatchObject({ runs: 1, unfinished: 0, inProgress: 1 });
    stack.advance!(3 * 60_000);
    live = await report();
    expect(live.runs[0]).toMatchObject({ finishedAt: null, durationMs: null, outcome: null, jobs: [], unfinished: true });
    expect(live.summary).toMatchObject({ unfinished: 1, inProgress: 0, completed: 0 });
    void hung;
  });

  it('records a run that threw with the error class and a sanitised, short message, and still throws for the platform retry', async () => {
    const { stack, alarm } = await setup(only({ syncBroker: () => () => done() }));
    stack.storage.exec('DROP TABLE jobs');
    await expect(alarm({ retryCount: 1, isRetry: true })).rejects.toThrow();
    const runs = stack.core.diagnostics.recentRuns(5);
    const summary = stack.core.diagnostics.summary();
    expect(runs[0]).toMatchObject({ outcome: 'failed', retryCount: 1, isRetry: true, trigger: 'unknown', error: { name: expect.any(String) } });
    expect(runs[0]!.error!.message.length).toBeLessThanOrEqual(200);
    expect(runs[0]!.error!.message).not.toContain('https://');
    expect(summary).toMatchObject({ failed: 1, unfinished: 0, retries: 1 });
  });

  it('never lets a broken diagnostics log break the alarm', async () => {
    let ran = 0;
    const { stack, alarm } = await setup(only({ syncBroker: () => () => (ran++, done()) }));
    await stack.enqueue('syncBroker', payload);
    stack.storage.exec('DROP TABLE alarm_runs');
    stack.storage.exec('DROP TABLE alarm_arms');
    await alarm();
    expect(ran).toBe(1);
    await stack.enqueue('syncBroker', payload); // an arm that cannot be recorded
    await alarm();
    expect(ran).toBe(2);
  });

  it('survives a log that breaks while the run is executing (the end of the run cannot be written)', async () => {
    const { stack, alarm } = await setup(
      only({
        syncBroker: () => () => {
          stack.storage.exec('DROP TABLE alarm_runs');
          return done();
        },
      }),
    );
    await stack.enqueue('syncBroker', payload);
    await expect(alarm()).resolves.toBeUndefined();
    expect(stack.core.platform.jobs.pending().jobs).toEqual([]);
  });

  it('sets the alarm once per run, at its end, also for a job that enqueues another one', async () => {
    const factories = only({
      syncBroker: ({ queue }) => async () => {
        await queue.enqueue({ job: JOBS.notifyDividends, payload: { trigger: 'sync', userId: 'github-424242' } });
        return { done: true as const, result: null };
      },
      notifyDividends: () => () => done(),
    });
    const { stack, report, alarm } = await setup(factories);
    await stack.enqueue('syncBroker', payload);
    stack.storage.alarmCalls.length = 0;
    await alarm();
    expect(stack.storage.alarmCalls).toHaveLength(1);
    const { runs, arms } = await report();
    expect(runs[0]!.jobs.map((job) => job.job)).toEqual(['syncBroker', 'notifyDividends']);
    expect(arms.filter((arm) => arm.runId !== null)).toEqual([]);
  });

  it('records the arms made outside a run with their reason: start, a job enqueued, the cron keep-alive', async () => {
    const { stack, report } = await setup(only({ syncBroker: () => () => done() }));
    await stack.enqueue('syncBroker', payload);
    await stack.cron(); // already armed for exactly that time: no call, no row
    const { arms } = await report();
    expect(arms.map((arm) => [arm.reason, arm.runId])).toEqual([
      ['job-enqueued', null],
      ['start', null],
    ]);
    stack.storage.alarm = null;
    await stack.cron();
    expect((await report()).arms.map((arm) => arm.reason)).toEqual(['keep-alive', 'job-enqueued', 'start']);
  });

  it('records a second end-of-run alarm (something asked for the alarm while it was being set) with its run', async () => {
    const { stack, report, alarm } = await setup(only({ syncBroker: () => () => done() }));
    await stack.enqueue('syncBroker', payload);
    await stack.enqueue('syncBroker', payload);
    stack.storage.exec("UPDATE jobs SET due_at = due_at + 60000 WHERE id = (SELECT id FROM jobs ORDER BY id DESC LIMIT 1)");
    const realSet = stack.storage.setAlarm.bind(stack.storage);
    let late = false;
    stack.storage.setAlarm = async (time: number) => {
      await realSet(time);
      if (!late) {
        late = true;
        await stack.core.platform.jobs.enqueue({ job: JOBS.syncBroker, payload, delayMs: 1_000 });
      }
    };
    await alarm();
    const { runs, arms } = await report();
    expect(arms.filter((arm) => arm.reason === 'rearm-after-run')).toEqual([expect.objectContaining({ runId: runs[0]!.id, alarmAt: stack.clock.ms + 1_000 })]);
    expect(runs[0]!.nextAlarmAt).toBe(stack.clock.ms + 1_000);
  });

  it('keeps only the last 300 runs', async () => {
    const { stack, report, alarm } = await setup(only({ syncBroker: () => () => done() }));
    await repeat(305, () => alarm());
    expect(stack.storage.rows('SELECT COUNT(*) AS n FROM alarm_runs')[0]!.n).toBe(300);
    const { runs, summary } = await report('?limit=100');
    expect(runs).toHaveLength(100);
    expect(runs[0]!.id).toBe(305);
    expect(summary.runs).toBe(300);
  });

  it('writes at most 3 diagnostic rows for a run (the start, the end and the prune of the oldest)', async () => {
    const { stack, alarm } = await setup(only({ syncBroker: () => () => done() }));
    await repeat(300, () => alarm());
    const written: number[] = [];
    const exec = stack.storage.exec.bind(stack.storage);
    stack.storage.exec = <T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) => {
      const cursor = exec<T>(query, ...bindings);
      if (/alarm_(runs|arms)/.test(query)) written.push(cursor.rowsWritten);
      return cursor;
    };
    await alarm();
    expect(written.reduce((sum, rows) => sum + rows, 0)).toBe(3);
  });
});

describe('the alarm of a woken Hub', () => {
  const dueSlot = async () => {
    const setupped = await setup(only({ syncBroker: () => () => done() }));
    const { stack } = setupped;
    const slot = stack.storage.rows<{ next_run_at: number }>("SELECT MIN(next_run_at) AS next_run_at FROM schedules")[0]!.next_run_at;
    stack.clock.ms = slot;
    stack.storage.alarmCalls.length = 0;
    return { ...setupped, slot };
  };

  it('sets the alarm once, at the end of the run, when the slot it was woken for is due', async () => {
    const { stack, alarm, report } = await dueSlot();
    await alarm();
    expect(stack.storage.alarmCalls).toHaveLength(1);
    expect(stack.storage.alarmCalls[0]).toBeGreaterThan(stack.clock.ms);
    expect((await report()).runs[0]!.jobs.map((job) => job.job)).toEqual(['syncBroker']);
  });

  it('would set it twice if the start of the Hub armed it inside the running handler: the first one (for right now) is superseded by the second', async () => {
    const { stack } = await dueSlot();
    await stack.storage.runAlarmHandler(async () => {
      await stack.core.start(); // what `Hub.alarm` used to do first: the slot is due, so this arms the alarm for right now
      await stack.core.alarm();
    });
    expect(stack.storage.alarmCalls).toHaveLength(2);
    expect(stack.storage.alarmCalls[0]).toBe(stack.clock.ms);
    expect(stack.storage.alarmCalls[1]).toBeGreaterThan(stack.clock.ms);
  });

  it('leaves the alarm alone when the start of the Hub (a request) arrives while a run is in progress', async () => {
    const release: { current?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    const { stack, slot } = await (async () => {
      const made = await setup(only({ syncBroker: () => async () => (await gate, { done: true as const, result: null }) }));
      await made.stack.enqueue('syncBroker', payload);
      return { ...made, slot: made.stack.clock.ms };
    })();
    stack.storage.alarmCalls.length = 0;
    const running = stack.storage.runAlarmHandler(() => stack.core.alarm());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await stack.core.start(); // a request waking the object while the alarm is mid-run
    expect(stack.storage.alarmCalls).toEqual([]);
    release.current!();
    await running;
    expect(stack.storage.alarmCalls).toHaveLength(1);
    expect(slot).toBe(stack.clock.ms);
  });
});

describe('GET /api/diagnostics/alarms', () => {
  it('answers the owner with the documented shape, newest first, and never caches it', async () => {
    const { stack, owner, alarm } = await setup(only({ syncBroker: () => () => done() }));
    await stack.enqueue('syncBroker', payload);
    await alarm();
    await alarm();
    const response = await owner.request('/api/diagnostics/alarms');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = alarmDiagnosticsSchema.parse(await response.json());
    expect(body.runs.map((run) => run.id)).toEqual([2, 1]);
    expect(body.generatedAt).toBe(stack.clock.ms);
    expect(body.armed.alarmAt).toBe(stack.storage.alarm);
    expect(body.armed.schedules.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/userId|payload|secret/i);
  });

  it('lists what is due and armed, and honours the limit (clamped, a bad value means 50)', async () => {
    const { stack, owner, report, alarm } = await setup(only({ syncBroker: () => () => done() }));
    await stack.enqueue('syncBroker', payload);
    expect((await report()).armed.dueJobs).toEqual([{ job: 'syncBroker', dueAt: stack.clock.ms, attempts: 0 }]);
    await repeat(3, () => alarm());
    expect((await report('?limit=2')).runs).toHaveLength(2);
    expect((await report('?limit=0')).runs).toHaveLength(3);
    expect((await report('?limit=abc')).runs).toHaveLength(3);
    expect((await report('?limit=1000')).runs).toHaveLength(3);
    expect((await owner.request('/api/diagnostics/alarms', { method: 'POST', body: {} })).status).toBeGreaterThanOrEqual(400);
  });

  it('needs the owner: anonymous callers get 401, a cross-origin change 403, no CORS grant, and the Hub refuses a request without the verified subject', async () => {
    const { stack, owner } = await setup(only({}));
    const anonymous = await new Browser(stack).request('/api/diagnostics/alarms');
    expect(anonymous.status).toBe(401);
    expect((await owner.request('/api/diagnostics/alarms', { method: 'POST', body: {}, origin: 'https://evil.example' })).status).toBe(403);
    expect((await owner.request('/api/diagnostics/alarms', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).toBeNull();
    expect((await stack.core.handle(new Request('https://hub.internal/api/diagnostics/alarms'))).status).toBe(401);
    expect((await stack.core.handle(new Request('https://hub.internal/api/diagnostics/alarms', { headers: { 'x-pt-subject': 'someone-else' } }))).status).toBe(401);
  });
});
