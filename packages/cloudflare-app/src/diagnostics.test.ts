import type { AlarmReport, AlarmRun, PendingWork } from '@portfolio/cloudflare';
import { describe, expect, it } from 'vitest';
import { alarmReport, finishOf, limitOf, triggerOf } from './diagnostics.js';

const NOW = 1_800_000_000_000;
const pending = (over: Partial<PendingWork> = {}): PendingWork => ({ jobs: [], schedules: [], ...over });
const report = (over: Partial<AlarmReport> = {}): AlarmReport => ({ steps: 0, completed: 0, retried: 0, failed: 0, nextAlarm: NOW + 1, jobs: [], yielded: false, ...over });

describe('triggerOf', () => {
  it('names the schedule slots and the jobs that were due, nothing else', () => {
    expect(
      triggerOf(
        pending({
          jobs: [
            { job: 'syncBroker', dueAt: NOW - 1, attempts: 0 },
            { job: 'syncBroker', dueAt: NOW, attempts: 1 },
            { job: 'notifyDividends', dueAt: NOW + 1, attempts: 0 },
          ],
          schedules: [
            { name: 't212-quotes', nextRunAt: NOW },
            { name: 'prices-refresh', nextRunAt: NOW + 5 },
          ],
        }),
        NOW,
      ),
    ).toBe('schedules: t212-quotes | jobs: syncBroker');
  });

  it('says nothing was due, and cuts a long list', () => {
    expect(triggerOf(pending(), NOW)).toBe('nothing due');
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `s${index}`, nextRunAt: NOW }));
    expect(triggerOf(pending({ schedules: many }), NOW)).toBe('schedules: s0, s1, s2, s3, s4, s5 +3');
  });
});

describe('finishOf', () => {
  it('completes a run that did its work', () => {
    expect(finishOf(report({ jobs: [{ job: 'syncBroker', outcome: 'done', steps: 1, delayMs: null }] }), 3)).toEqual({
      outcome: 'completed',
      jobs: [{ job: 'syncBroker', outcome: 'done', steps: 1, delayMs: null }],
      subrequests: 3,
      nextAlarmAt: NOW + 1,
    });
  });

  it('treats a retried or failed job as part of a completed run, and a continuation without a pause as completed', () => {
    const jobs = [
      { job: 'a', outcome: 'retried' as const, steps: 1, delayMs: 5_000 },
      { job: 'b', outcome: 'failed' as const, steps: 1, delayMs: null },
      { job: 'c', outcome: 'continued' as const, steps: 2, delayMs: 0 },
    ];
    expect(finishOf(report({ jobs }), 0).outcome).toBe('completed');
  });

  it('defers a run that yielded or whose job asked to continue after a pause', () => {
    expect(finishOf(report({ yielded: true }), 0).outcome).toBe('deferred');
    expect(finishOf(report({ jobs: [{ job: 'a', outcome: 'continued', steps: 1, delayMs: 1_000 }] }), 0).outcome).toBe('deferred');
  });
});

describe('limitOf', () => {
  it('accepts whole numbers from 1 to 100 and falls back to 50', () => {
    expect([undefined, '', 'abc', '0', '-3', '2.5', '7', '100', '101', '5000'].map((value) => limitOf(value))).toEqual([50, 50, 50, 50, 50, 50, 7, 100, 100, 100]);
  });
});

describe('alarmReport', () => {
  it('marks a run without a finish as unfinished only once it is old enough', () => {
    const run = (id: number, startedAt: number, finishedAt: number | null): AlarmRun => ({
      id,
      startedAt,
      retryCount: 0,
      isRetry: false,
      scheduledFor: null,
      trigger: 'nothing due',
      finishedAt,
      durationMs: finishedAt === null ? null : finishedAt - startedAt,
      outcome: finishedAt === null ? null : 'completed',
      jobs: [],
      subrequests: null,
      nextAlarmAt: null,
      error: null,
    });
    const body = alarmReport({
      nowMs: NOW,
      runs: [run(3, NOW - 10_000, null), run(2, NOW - 130_000, null), run(1, NOW - 200_000, NOW - 199_000)],
      arms: [{ id: 1, at: NOW, reason: 'start', alarmAt: NOW + 5, runId: null }],
      summary: { since: NOW - 1, runs: 3, completed: 1, deferred: 0, failed: 0, unfinished: 1, inProgress: 1, retries: 0, maxRetryCount: 0 },
      alarmAt: NOW + 5,
      pending: pending(),
    });
    expect(body.runs.map((entry) => entry.unfinished)).toEqual([false, true, false]);
    expect(body.armed).toEqual({ alarmAt: NOW + 5, dueJobs: [], schedules: [] });
    expect(body.arms).toEqual([{ id: 1, at: NOW, reason: 'start', alarmAt: NOW + 5, runId: null }]);
  });
});
