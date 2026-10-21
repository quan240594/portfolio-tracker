import { MAX_JOB_STEPS, SCHEDULED_JOBS, toUnixCron, type JobHandler, type JobMessage, type JobName, type JobQueue, type JobRegistry, type ScheduledJob } from '@portfolio/platform';
import type { AlarmJobOutcome, AlarmJobSummary, ArmReason } from './alarm-diagnostics.js';
import { nextCronRun } from './cron.js';
import { MeteredSql, type AlarmStorageHost, type UsageOptions } from './sql.js';

/**
 * Tables of the job queue. Finished jobs are deleted, so `jobs` holds only open jobs and the (pruned) failed ones; that is
 * why it needs no index (an index adds a written row to every write, and the table is a handful of rows).
 */
export const JOBS_SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    job TEXT NOT NULL,
    payload TEXT NOT NULL,
    cursor TEXT,
    due_at INTEGER NOT NULL,
    enqueued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    steps INTEGER NOT NULL,
    state TEXT NOT NULL,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  'CREATE TABLE IF NOT EXISTS schedules (name TEXT PRIMARY KEY, next_run_at INTEGER NOT NULL) WITHOUT ROWID',
] as const;

export interface AlarmJobQueueOptions extends UsageOptions {
  now?: () => Date;
  /** Ids of new jobs. Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  /** The cron schedules to keep alive. Defaults to the shared `SCHEDULED_JOBS`. */
  schedules?: readonly ScheduledJob[];
  /** Deliveries of one step before the job is marked failed. Default 5. */
  maxAttempts?: number;
  /** Retry delay after the first failure; doubles per failure up to `maxBackoffMs`. Default 5 s. */
  baseBackoffMs?: number;
  /** Cap of the retry delay. Default 15 minutes. */
  maxBackoffMs?: number;
  /** Steps run by one alarm before it yields (the rest is re-armed immediately). Default 200. */
  maxStepsPerRun?: number;
  /** Wall-clock time one alarm may spend before it yields. Default 20 s (the alarm CPU cap is tens of seconds). */
  maxRunMs?: number;
  /** How long failed jobs stay inspectable. Default 7 days. */
  failedRetentionMs?: number;
  /** Observability hook: one event per step outcome. Never receives payloads. */
  onEvent?: (event: AlarmEvent) => void;
  /** Called after every `setAlarm` the queue makes (the diagnostics log records them). Must not throw. */
  onArm?: (event: ArmEvent) => void;
}

export interface ArmEvent {
  reason: ArmReason;
  /** The time the alarm was set for (epoch ms). */
  alarmAt: number;
}

export type AlarmEvent =
  | { type: 'completed'; job: string; result: unknown }
  | { type: 'continued'; job: string; delayMs: number }
  | { type: 'retry'; job: string; attempt: number; retryInMs: number; error: string }
  | { type: 'failed'; job: string; error: string };

export interface AlarmReport {
  /** Handler invocations of this run. */
  steps: number;
  completed: number;
  retried: number;
  failed: number;
  /** When the alarm is armed for next (epoch ms), or null when nothing is pending. */
  nextAlarm: number | null;
  /** What each job that ran did (the last step's outcome and the number of steps), in order of first appearance. */
  jobs: AlarmJobSummary[];
  /** True when the run stopped on its step or time budget while work was still due (the rest runs in the next alarm). */
  yielded: boolean;
}

export interface FailedJob {
  id: string;
  job: string;
  attempts: number;
  error: string | null;
  updatedAt: number;
}

/** What is open, without payloads: the pending jobs (earliest first, at most `limit`) and the next slot of each schedule. */
export interface PendingWork {
  jobs: { job: string; dueAt: number; attempts: number }[];
  schedules: { name: string; nextRunAt: number }[];
}

type JobRow = {
  id: string;
  job: string;
  payload: string;
  cursor: string | null;
  attempts: number;
  steps: number;
};

type Outcome = { step: Awaited<ReturnType<JobHandler>> } | { error: unknown };

const DEFAULTS = {
  maxAttempts: 5,
  baseBackoffMs: 5_000,
  maxBackoffMs: 15 * 60_000,
  maxStepsPerRun: 200,
  maxRunMs: 20_000,
  failedRetentionMs: 7 * 24 * 3_600_000,
};

const MAX_ERROR_CHARS = 500;

/** Capped exponential backoff: `base`, `2 * base`, `4 * base` ... up to `max`, for failure number 1, 2, 3 ... */
export function backoffMs(failure: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, failure - 1));
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);

/**
 * JobQueue on the alarm of a Durable Object. `enqueue` stores the job and arms the object's single alarm at the earliest
 * due time; the alarm handler calls `runAlarm(handlers)`, which runs the due jobs through the resumable `JobHandler`
 * contract: a `{ done: false, next, delayMs }` step persists `next` as the job's cursor and schedules the next step, a
 * failing step is retried with capped exponential backoff and, after `maxAttempts` deliveries, the job is marked failed
 * (kept for inspection, pruned later) instead of looping. Delivery is at-least-once: a step may run again after a crash.
 *
 * The cron schedules (`SCHEDULED_JOBS`, read on the clock of their time zone) are kept in the same alarm: when a schedule is
 * due its job is enqueued under the id `schedule:<name>:<time>`, so an alarm that fires twice enqueues it once.
 *
 * A second `runAlarm` while one is running joins the running one (same report), so a duplicated alarm cannot run a step
 * twice at the same time; run sequentially, a second alarm finds nothing due and changes nothing.
 */
export class AlarmJobQueue implements JobQueue {
  private readonly db: MeteredSql;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly schedules: readonly ScheduledJob[];
  private readonly policy: typeof DEFAULTS;
  private running: Promise<AlarmReport> | undefined;
  /** True from the first instruction of a run to its last (set before the first handler can run, unlike `running`). */
  private active = false;
  /** Set when something asked for the alarm while a run was in progress: the run arms it once, at its end. */
  private rearmRequested = false;

  constructor(
    private readonly storage: AlarmStorageHost,
    private readonly options: AlarmJobQueueOptions = {},
  ) {
    this.db = new MeteredSql(storage.sql, options.onUsage);
    const clock = options.now ?? (() => new Date());
    this.now = () => clock().getTime();
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.schedules = options.schedules ?? SCHEDULED_JOBS;
    this.policy = { ...DEFAULTS, ...definedOnly(options) };
    for (const schema of JOBS_SCHEMAS) this.db.rows(schema);
  }

  async enqueue<N extends JobName>(message: JobMessage<N>): Promise<void> {
    const delay = message.delayMs ?? 0;
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError('delayMs must be a non-negative number');
    const nowMs = this.now();
    const dueAt = nowMs + delay;
    this.db.rows(
      "INSERT INTO jobs (id, job, payload, cursor, due_at, enqueued_at, attempts, steps, state, last_error, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 0, 0, 'pending', NULL, ?)",
      this.uuid(),
      message.job,
      JSON.stringify(message.payload),
      dueAt,
      nowMs,
      nowMs,
    );
    if (this.active) {
      // The run in progress picks the job up (or arms for it at its end): setting the alarm now would only supersede it.
      this.rearmRequested = true;
      return;
    }
    const current = await this.storage.getAlarm();
    if (current === null || dueAt < current) await this.setAlarm('job-enqueued', dueAt);
  }

  /**
   * Initialises the cron schedules and arms the alarm for the earliest pending job or schedule. Call it when the Durable
   * Object starts (inside `blockConcurrencyWhile`), so the schedules survive a deploy that cleared the alarm. While an alarm
   * run is in progress it changes nothing: the run keeps the schedules and arms the alarm itself when it ends, and a
   * `setAlarm` from here would replace the alarm of the invocation that is executing.
   */
  async arm(reason: Extract<ArmReason, 'start' | 'keep-alive'> = 'start'): Promise<number | null> {
    if (this.active) {
      this.rearmRequested = true;
      return this.target();
    }
    this.syncSchedules();
    return await this.rearm(reason);
  }

  /** Runs everything that is due now (see the class comment) and re-arms the alarm. Call it from `alarm()`. */
  runAlarm(handlers: JobRegistry): Promise<AlarmReport> {
    if (!this.running) {
      this.active = true;
      this.running = this.execute(handlers).finally(() => {
        this.running = undefined;
        this.active = false;
      });
    }
    return this.running;
  }

  /** The jobs that ran out of attempts, newest first. */
  failedJobs(): FailedJob[] {
    return this.db
      .rows<{ id: string; job: string; attempts: number; last_error: string | null; updated_at: number }>(
        "SELECT id, job, attempts, last_error, updated_at FROM jobs WHERE state = 'failed' ORDER BY updated_at DESC, id",
      )
      .map((row) => ({ id: row.id, job: row.job, attempts: row.attempts, error: row.last_error, updatedAt: row.updated_at }));
  }

  /** The open work, for diagnostics (names and times only). */
  pending(limit = 20): PendingWork {
    return {
      jobs: this.db
        .rows<{ job: string; due_at: number; attempts: number }>("SELECT job, due_at, attempts FROM jobs WHERE state = 'pending' ORDER BY due_at, enqueued_at, id LIMIT ?", limit)
        .map((row) => ({ job: row.job, dueAt: row.due_at, attempts: row.attempts })),
      schedules: this.db.rows<{ name: string; next_run_at: number }>('SELECT name, next_run_at FROM schedules ORDER BY next_run_at, name').map((row) => ({ name: row.name, nextRunAt: row.next_run_at })),
    };
  }

  /** Earliest due time among the open jobs (epoch ms), or null. Cron schedules are not included. */
  nextJobDueAt(): number | null {
    return this.db.first<{ due: number | null }>("SELECT MIN(due_at) AS due FROM jobs WHERE state = 'pending'")?.due ?? null;
  }

  private async execute(handlers: JobRegistry): Promise<AlarmReport> {
    const report: AlarmReport = { steps: 0, completed: 0, retried: 0, failed: 0, nextAlarm: null, jobs: [], yielded: false };
    this.syncSchedules();
    this.db.rows("DELETE FROM jobs WHERE state = 'failed' AND updated_at < ?", this.now() - this.policy.failedRetentionMs);
    await this.drain(handlers, report, this.now() + this.policy.maxRunMs);
    report.yielded = this.nextDue() !== undefined;
    report.nextAlarm = await this.rearmAfterRun();
    return report;
  }

  /** The one `setAlarm` of a run, at its end; once more for each time something asked for the alarm while it was being set. */
  private async rearmAfterRun(): Promise<number | null> {
    this.rearmRequested = false;
    const next = await this.rearm('rearm-after-run');
    return this.rearmRequested ? await this.rearmAfterRun() : next;
  }

  /** Runs the due jobs one step at a time (recursively, so no `await` sits in a loop) until none is due or the budget is spent. */
  private async drain(handlers: JobRegistry, report: AlarmReport, deadline: number): Promise<void> {
    if (report.steps >= this.policy.maxStepsPerRun || this.now() >= deadline) return;
    const job = this.nextDue();
    if (!job) return;
    report.steps++;
    this.record(job, await this.invoke(handlers, job), report);
    await this.drain(handlers, report, deadline);
  }

  private nextDue(): JobRow | undefined {
    return this.db.first<JobRow>(
      "SELECT id, job, payload, cursor, attempts, steps FROM jobs WHERE state = 'pending' AND due_at <= ? ORDER BY due_at, enqueued_at, id LIMIT 1",
      this.now(),
    );
  }

  private async invoke(handlers: JobRegistry, row: JobRow): Promise<Outcome> {
    const handler = handlers[row.job as JobName] as JobHandler<unknown> | undefined;
    try {
      if (!handler) throw new Error(`No handler registered for job "${row.job}"`);
      return { step: await handler({ payload: JSON.parse(row.payload), cursor: row.cursor ?? undefined }) };
    } catch (error) {
      return { error };
    }
  }

  private record(row: JobRow, outcome: Outcome, report: AlarmReport): void {
    if ('error' in outcome) this.recordFailure(row, describeError(outcome.error), report);
    else if (outcome.step.done) this.recordDone(row, outcome.step.result, report);
    else this.recordContinuation(row, outcome.step, report);
  }

  /** Keeps one summary per job name: the outcome of its latest step and how many steps it took. */
  private note(report: AlarmReport, job: string, outcome: AlarmJobOutcome, delayMs: number | null): void {
    const existing = report.jobs.find((entry) => entry.job === job);
    if (existing) Object.assign(existing, { outcome, delayMs, steps: existing.steps + 1 });
    else report.jobs.push({ job, outcome, steps: 1, delayMs });
  }

  private recordDone(row: JobRow, result: unknown, report: AlarmReport): void {
    this.db.rows('DELETE FROM jobs WHERE id = ?', row.id);
    report.completed++;
    this.note(report, row.job, isSkipped(result) ? 'skipped' : 'done', null);
    this.options.onEvent?.({ type: 'completed', job: row.job, result });
  }

  private recordContinuation(row: JobRow, step: { next: string; delayMs?: number }, report: AlarmReport): void {
    if (row.steps + 1 >= MAX_JOB_STEPS) {
      this.markFailed(row, `Job did not finish within ${MAX_JOB_STEPS} steps`, report);
      return;
    }
    const nowMs = this.now();
    const delayMs = Math.max(0, step.delayMs ?? 0);
    this.db.rows('UPDATE jobs SET cursor = ?, due_at = ?, attempts = 0, steps = steps + 1, last_error = NULL, updated_at = ? WHERE id = ?', step.next, nowMs + delayMs, nowMs, row.id);
    this.note(report, row.job, 'continued', delayMs);
    this.options.onEvent?.({ type: 'continued', job: row.job, delayMs });
  }

  private recordFailure(row: JobRow, error: string, report: AlarmReport): void {
    const attempt = row.attempts + 1;
    if (attempt >= this.policy.maxAttempts) {
      this.markFailed(row, error, report, attempt);
      return;
    }
    const nowMs = this.now();
    const retryInMs = backoffMs(attempt, this.policy.baseBackoffMs, this.policy.maxBackoffMs);
    this.db.rows('UPDATE jobs SET attempts = ?, due_at = ?, last_error = ?, updated_at = ? WHERE id = ?', attempt, nowMs + retryInMs, error, nowMs, row.id);
    report.retried++;
    this.note(report, row.job, 'retried', retryInMs);
    this.options.onEvent?.({ type: 'retry', job: row.job, attempt, retryInMs, error });
  }

  private markFailed(row: JobRow, error: string, report: AlarmReport, attempts = row.attempts): void {
    this.db.rows("UPDATE jobs SET state = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?", attempts, error, this.now(), row.id);
    report.failed++;
    this.note(report, row.job, 'failed', null);
    this.options.onEvent?.({ type: 'failed', job: row.job, error });
  }

  /** Enqueues the schedules that are due (once per slot) and moves each to its next slot. */
  private syncSchedules(): void {
    if (this.schedules.length === 0) return;
    const nowMs = this.now();
    this.storage.transactionSync(() => {
      const known = new Map(this.db.rows<{ name: string; next_run_at: number }>('SELECT name, next_run_at FROM schedules').map((row) => [row.name, row.next_run_at]));
      for (const schedule of this.schedules) {
        const slot = known.get(schedule.name);
        if (slot === undefined) {
          this.db.rows('INSERT INTO schedules (name, next_run_at) VALUES (?, ?)', schedule.name, nextSlot(schedule, nowMs));
        } else if (slot <= nowMs) {
          this.enqueueSlot(schedule, slot, nowMs);
          this.db.rows('UPDATE schedules SET next_run_at = ? WHERE name = ?', nextSlot(schedule, nowMs), schedule.name);
        }
      }
    });
  }

  private enqueueSlot(schedule: ScheduledJob, slot: number, nowMs: number): void {
    // The slot is part of the id: the same slot can only be enqueued once, whatever fires twice.
    this.db.rows(
      "INSERT OR IGNORE INTO jobs (id, job, payload, cursor, due_at, enqueued_at, attempts, steps, state, last_error, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 0, 0, 'pending', NULL, ?)",
      `schedule:${schedule.name}:${slot}`,
      schedule.job,
      JSON.stringify(schedule.payload),
      nowMs,
      nowMs,
      nowMs,
    );
  }

  /** The time the alarm should be armed for: the earliest open job or schedule, never in the past; null when nothing is pending. */
  private target(): number | null {
    const dueTimes = [this.nextJobDueAt(), this.db.first<{ due: number | null }>('SELECT MIN(next_run_at) AS due FROM schedules')?.due ?? null].filter(
      (time): time is number => time !== null,
    );
    return dueTimes.length === 0 ? null : Math.max(Math.min(...dueTimes), this.now());
  }

  /** Arms the alarm for `target()` unless it is armed for exactly that time. */
  private async rearm(reason: ArmReason): Promise<number | null> {
    const target = this.target();
    if (target === null) return null;
    if ((await this.storage.getAlarm()) !== target) await this.setAlarm(reason, target);
    return target;
  }

  private async setAlarm(reason: ArmReason, alarmAt: number): Promise<void> {
    await this.storage.setAlarm(alarmAt);
    this.options.onArm?.({ reason, alarmAt });
  }
}

const isSkipped = (result: unknown): boolean => typeof result === 'object' && result !== null && 'skipped' in result;

const nextSlot = (schedule: ScheduledJob, afterMs: number): number => nextCronRun(toUnixCron(schedule), afterMs, schedule.timezone);

/** Copy of the options that are set, so an explicit `undefined` does not override a default. */
function definedOnly(options: AlarmJobQueueOptions): Partial<typeof DEFAULTS> {
  const keys = Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[];
  return Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]])) as Partial<typeof DEFAULTS>;
}

export interface RunAlarmOptions extends AlarmJobQueueOptions {
  storage: AlarmStorageHost;
  handlers: JobRegistry;
}

/**
 * Runs the due jobs of the Durable Object behind `storage` once. A Hub that keeps its `AlarmJobQueue` (the factory does)
 * should call the queue's `runAlarm` instead: this function builds a queue per call, so it cannot join a run in progress.
 */
export async function runAlarm({ storage, handlers, ...options }: RunAlarmOptions): Promise<AlarmReport> {
  return await new AlarmJobQueue(storage, options).runAlarm(handlers);
}
