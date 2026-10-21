import { describe, expect, it } from 'vitest';
import { alarmDiagnosticsSchema, DIAGNOSTICS_ROUTES, type AlarmDiagnosticsReport } from './diagnostics-api.js';

const report = (): AlarmDiagnosticsReport => ({
  generatedAt: 1_800_000_000_000,
  armed: { alarmAt: 1_800_000_900_000, dueJobs: [{ job: 'refreshT212Quotes', dueAt: 1_800_000_900_000, attempts: 0 }], schedules: [{ name: 't212-quotes', nextRunAt: 1_800_000_900_000 }] },
  summary: { since: 1_799_913_600_000, runs: 2, completed: 1, deferred: 0, failed: 0, unfinished: 1, inProgress: 0, retries: 0, maxRetryCount: 0 },
  runs: [
    {
      id: 2,
      startedAt: 1_800_000_000_000,
      finishedAt: null,
      durationMs: null,
      retryCount: 0,
      isRetry: false,
      scheduledFor: null,
      trigger: 'schedule:t212-quotes',
      outcome: null,
      unfinished: true,
      jobs: [],
      subrequests: null,
      nextAlarmAt: null,
      error: null,
    },
    {
      id: 1,
      startedAt: 1_799_999_000_000,
      finishedAt: 1_799_999_001_000,
      durationMs: 1_000,
      retryCount: 1,
      isRetry: true,
      scheduledFor: 1_799_999_000_000,
      trigger: 'jobs:syncBroker',
      outcome: 'completed',
      unfinished: false,
      jobs: [{ job: 'syncBroker', outcome: 'done', steps: 2, delayMs: null }],
      subrequests: 4,
      nextAlarmAt: 1_800_000_900_000,
      error: null,
    },
  ],
  arms: [{ id: 1, at: 1_799_999_000_000, reason: 'job-enqueued', alarmAt: 1_799_999_000_000, runId: null }],
});

describe('alarm diagnostics contract', () => {
  it('names the route', () => {
    expect(DIAGNOSTICS_ROUTES.alarms).toBe('GET /diagnostics/alarms');
  });

  it('accepts a valid report', () => {
    expect(alarmDiagnosticsSchema.parse(report())).toEqual(report());
  });

  it('rejects an unknown outcome, a negative duration and a missing section', () => {
    const bad = report();
    (bad.runs[1] as { outcome: string }).outcome = 'exploded';
    expect(alarmDiagnosticsSchema.safeParse(bad).success).toBe(false);
    const negative = report();
    negative.runs[1]!.durationMs = -1;
    expect(alarmDiagnosticsSchema.safeParse(negative).success).toBe(false);
    const { arms: _arms, ...partial } = report();
    expect(alarmDiagnosticsSchema.safeParse(partial).success).toBe(false);
  });
});
