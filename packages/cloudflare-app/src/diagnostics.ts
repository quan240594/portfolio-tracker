import {
  UNFINISHED_AFTER_MS,
  type AlarmArm,
  type AlarmReport,
  type AlarmRun,
  type AlarmRunFinish,
  type AlarmSummary,
  type PendingWork,
} from '@portfolio/cloudflare';
import type { AlarmArmReport, AlarmDiagnosticsReport, AlarmRunReport } from '@portfolio/shared';

/** What the platform tells an alarm handler (`alarm(alarmInfo)`); every field may be missing. */
export interface AlarmInfo {
  retryCount?: number;
  isRetry?: boolean;
  scheduledTime?: number;
}

export const DEFAULT_RUNS_LIMIT = 50;
const MAX_TRIGGER_NAMES = 6;

/** Names only (never payloads): what was due when the alarm fired, e.g. `schedules: t212-quotes | jobs: syncBroker`. */
export function triggerOf(pending: PendingWork, nowMs: number): string {
  const schedules = pending.schedules.filter((schedule) => schedule.nextRunAt <= nowMs).map((schedule) => schedule.name);
  const jobs = [...new Set(pending.jobs.filter((job) => job.dueAt <= nowMs).map((job) => job.job))];
  const parts = [list('schedules', schedules), list('jobs', jobs)].filter((part) => part !== '');
  return parts.length === 0 ? 'nothing due' : parts.join(' | ');
}

const list = (label: string, names: readonly string[]): string => {
  if (names.length === 0) return '';
  const shown = names.slice(0, MAX_TRIGGER_NAMES).join(', ');
  const more = names.length > MAX_TRIGGER_NAMES ? ' +' + String(names.length - MAX_TRIGGER_NAMES) : '';
  return `${label}: ${shown}${more}`;
};

/**
 * How a run that did not throw ended: `deferred` when it handed work to a later alarm (it ran out of steps or time with jobs still
 * due, or a job asked to continue after a pause: the budget guard or the subrequest budget held it back), else `completed`.
 */
export function finishOf(report: AlarmReport, subrequests: number): AlarmRunFinish {
  const paused = report.jobs.some((job) => job.outcome === 'continued' && (job.delayMs ?? 0) > 0);
  return { outcome: report.yielded || paused ? 'deferred' : 'completed', jobs: report.jobs, subrequests, nextAlarmAt: report.nextAlarm };
}

const toRunReport = (run: AlarmRun, nowMs: number): AlarmRunReport => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  durationMs: run.durationMs,
  retryCount: run.retryCount,
  isRetry: run.isRetry,
  scheduledFor: run.scheduledFor,
  trigger: run.trigger,
  outcome: run.outcome,
  unfinished: run.finishedAt === null && nowMs - run.startedAt > UNFINISHED_AFTER_MS,
  jobs: run.jobs,
  subrequests: run.subrequests,
  nextAlarmAt: run.nextAlarmAt,
  error: run.error,
});

const toArmReport = (arm: AlarmArm): AlarmArmReport => ({ id: arm.id, at: arm.at, reason: arm.reason, alarmAt: arm.alarmAt, runId: arm.runId });

export interface AlarmReportInput {
  nowMs: number;
  runs: readonly AlarmRun[];
  arms: readonly AlarmArm[];
  summary: AlarmSummary;
  alarmAt: number | null;
  pending: PendingWork;
}

/** The body of `GET /api/diagnostics/alarms`. */
export function alarmReport({ nowMs, runs, arms, summary, alarmAt, pending }: AlarmReportInput): AlarmDiagnosticsReport {
  return {
    generatedAt: nowMs,
    armed: { alarmAt, dueJobs: pending.jobs, schedules: pending.schedules },
    summary,
    runs: runs.map((run) => toRunReport(run, nowMs)),
    arms: arms.map((arm) => toArmReport(arm)),
  };
}

/** The `limit` query parameter: a whole number from 1 to 100, 50 when absent or unreadable. */
export function limitOf(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 100) : DEFAULT_RUNS_LIMIT;
}
