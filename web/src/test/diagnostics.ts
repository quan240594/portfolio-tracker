import type { AlarmDiagnosticsReport, AlarmRunReport } from '@portfolio/shared';

/** 20-10-2026 11:27:05 in the local time zone of the test run (the page prints local time). */
export const T = new Date(2026, 9, 20, 11, 27, 5).getTime();

export const run = (over: Partial<AlarmRunReport> = {}): AlarmRunReport => ({
  id: 1,
  startedAt: T,
  finishedAt: T + 850,
  durationMs: 850,
  retryCount: 0,
  isRetry: false,
  scheduledFor: T,
  trigger: 'schedules: t212-quotes',
  outcome: 'completed',
  unfinished: false,
  jobs: [{ job: 'refreshT212Quotes', outcome: 'done', steps: 1, delayMs: null }],
  subrequests: 1,
  nextAlarmAt: T + 900_000,
  error: null,
  ...over,
});

export const report = (over: Partial<AlarmDiagnosticsReport> = {}): AlarmDiagnosticsReport => ({
  generatedAt: T + 60_000,
  armed: { alarmAt: T + 900_000, dueJobs: [{ job: 'refreshT212Quotes', dueAt: T + 900_000, attempts: 0 }], schedules: [{ name: 't212-quotes', nextRunAt: T + 900_000 }] },
  summary: { since: T - 86_400_000, runs: 4, completed: 1, deferred: 1, failed: 1, unfinished: 1, inProgress: 0, retries: 1, maxRetryCount: 2 },
  runs: [
    run({ id: 4, startedAt: T + 3_600_000, finishedAt: null, durationMs: null, outcome: null, unfinished: true, jobs: [], subrequests: null, nextAlarmAt: null }),
    run({ id: 3, startedAt: T + 1_800_000, outcome: 'failed', retryCount: 2, isRetry: true, jobs: [], error: { name: 'Error', message: 'no such table: jobs' } }),
    run({ id: 2, startedAt: T + 900_000, outcome: 'deferred', durationMs: 2_400, jobs: [{ job: 'syncBroker', outcome: 'continued', steps: 2, delayMs: 60_000 }] }),
    run({ id: 1 }),
  ],
  arms: [{ id: 1, at: T, reason: 'job-enqueued', alarmAt: T, runId: null }],
  ...over,
});
