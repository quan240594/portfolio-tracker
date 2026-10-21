/**
 * Alarm diagnostics REST contract (personal Cloudflare deployment only; the AWS API has no such route).
 *
 * - GET /diagnostics/alarms?limit=50   what the Hub's alarm did lately: the newest runs first (at most 100), the arm records, a
 *                                      24-hour summary and what is armed now. Read-only, owner only like every /api route.
 *
 * A run that has a `startedAt` and no `finishedAt` for longer than two minutes is `unfinished`: the invocation was cancelled
 * or disconnected before it could write its end. All times are epoch milliseconds (UTC).
 */
import { z } from 'zod';

export const DIAGNOSTICS_ROUTES = {
  alarms: 'GET /diagnostics/alarms',
} as const;

export const ALARM_RUN_OUTCOMES = ['completed', 'deferred', 'failed'] as const;
export type AlarmRunOutcome = (typeof ALARM_RUN_OUTCOMES)[number];

export const ALARM_JOB_OUTCOMES = ['done', 'continued', 'skipped', 'retried', 'failed'] as const;
export type AlarmJobOutcome = (typeof ALARM_JOB_OUTCOMES)[number];

export const ALARM_ARM_REASONS = ['start', 'keep-alive', 'job-enqueued', 'rearm-after-run'] as const;
export type AlarmArmReason = (typeof ALARM_ARM_REASONS)[number];

export interface AlarmJobReport {
  job: string;
  outcome: AlarmJobOutcome;
  steps: number;
  delayMs: number | null;
}

export interface AlarmRunReport {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  retryCount: number;
  isRetry: boolean;
  scheduledFor: number | null;
  trigger: string;
  outcome: AlarmRunOutcome | null;
  /** Started, never finished and older than two minutes. */
  unfinished: boolean;
  jobs: AlarmJobReport[];
  subrequests: number | null;
  nextAlarmAt: number | null;
  error: { name: string; message: string } | null;
}

export interface AlarmArmReport {
  id: number;
  at: number;
  reason: AlarmArmReason;
  alarmAt: number;
  runId: number | null;
}

export interface AlarmDiagnosticsReport {
  generatedAt: number;
  /** What is armed now (null while an alarm is running or when nothing is pending) and what is open. */
  armed: {
    alarmAt: number | null;
    dueJobs: { job: string; dueAt: number; attempts: number }[];
    schedules: { name: string; nextRunAt: number }[];
  };
  summary: {
    since: number;
    runs: number;
    completed: number;
    deferred: number;
    failed: number;
    unfinished: number;
    inProgress: number;
    retries: number;
    maxRetryCount: number;
  };
  runs: AlarmRunReport[];
  arms: AlarmArmReport[];
}

const count = z.number().int().nonnegative();
const epoch = z.number().int().nonnegative();

/** Validates the response of `GET /diagnostics/alarms` (the web client parses it with this). */
export const alarmDiagnosticsSchema = z.object({
  generatedAt: epoch,
  armed: z.object({
    alarmAt: epoch.nullable(),
    dueJobs: z.array(z.object({ job: z.string(), dueAt: epoch, attempts: count })),
    schedules: z.array(z.object({ name: z.string(), nextRunAt: epoch })),
  }),
  summary: z.object({
    since: epoch,
    runs: count,
    completed: count,
    deferred: count,
    failed: count,
    unfinished: count,
    inProgress: count,
    retries: count,
    maxRetryCount: count,
  }),
  runs: z.array(
    z.object({
      id: count,
      startedAt: epoch,
      finishedAt: epoch.nullable(),
      durationMs: count.nullable(),
      retryCount: count,
      isRetry: z.boolean(),
      scheduledFor: epoch.nullable(),
      trigger: z.string(),
      outcome: z.enum(ALARM_RUN_OUTCOMES).nullable(),
      unfinished: z.boolean(),
      jobs: z.array(z.object({ job: z.string(), outcome: z.enum(ALARM_JOB_OUTCOMES), steps: count, delayMs: count.nullable() })),
      subrequests: count.nullable(),
      nextAlarmAt: epoch.nullable(),
      error: z.object({ name: z.string(), message: z.string() }).nullable(),
    }),
  ),
  arms: z.array(z.object({ id: count, at: epoch, reason: z.enum(ALARM_ARM_REASONS), alarmAt: epoch, runId: count.nullable() })),
});
