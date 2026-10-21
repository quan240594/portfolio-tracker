import { describe, expect, it } from 'vitest';
import { SqlJsStorage, TestClock } from '../test/sqljs-storage.js';
import {
  AlarmDiagnostics,
  DIAGNOSTICS_SCHEMAS,
  MAX_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_RUNS_PER_QUERY,
  UNFINISHED_AFTER_MS,
  describeDiagnosticError,
  diagnosticErrorName,
  sanitizeDiagnosticMessage,
  type AlarmDiagnosticsOptions,
  type AlarmRunStart,
} from './alarm-diagnostics.js';
import type { SqlUsage } from './sql.js';

const START: AlarmRunStart = { retryCount: 0, isRetry: false, scheduledFor: null, trigger: 'schedule:t212-quotes' };
const FINISH = { outcome: 'completed' as const, jobs: [{ job: 'refreshT212Quotes', outcome: 'done' as const, steps: 1, delayMs: null }], subrequests: 1, nextAlarmAt: 5 };

const setup = async (options: AlarmDiagnosticsOptions = {}) => {
  const storage = await SqlJsStorage.create();
  const clock = new TestClock();
  const diagnostics = new AlarmDiagnostics(storage, { now: clock.now, ...options });
  return { storage, clock, diagnostics };
};

describe('AlarmDiagnostics runs', () => {
  it('records the start of a run and completes it with the outcome, the jobs and the duration', async () => {
    const { diagnostics, clock } = await setup();
    const startedAt = clock.ms;
    const id = diagnostics.begin({ retryCount: 2, isRetry: true, scheduledFor: startedAt - 5, trigger: 'schedule:broker-sync' });
    expect(diagnostics.recentRuns(5)).toEqual([
      expect.objectContaining({ id, startedAt, retryCount: 2, isRetry: true, scheduledFor: startedAt - 5, trigger: 'schedule:broker-sync', finishedAt: null, durationMs: null, outcome: null, jobs: [], error: null }),
    ]);
    clock.advance(1_250);
    diagnostics.finish(id, FINISH);
    expect(diagnostics.recentRuns(5)[0]).toEqual({
      id,
      startedAt,
      retryCount: 2,
      isRetry: true,
      scheduledFor: startedAt - 5,
      trigger: 'schedule:broker-sync',
      finishedAt: startedAt + 1_250,
      durationMs: 1_250,
      outcome: 'completed',
      jobs: FINISH.jobs,
      subrequests: 1,
      nextAlarmAt: 5,
      error: null,
    });
  });

  it('stores a sanitised error with its class name', async () => {
    const { diagnostics } = await setup();
    const id = diagnostics.begin(START);
    diagnostics.finish(id, { ...FINISH, outcome: 'failed', error: { name: 'TypeError', message: 'bad https://api.example.com/x?apikey=abc123 happened' } });
    expect(diagnostics.recentRuns(1)[0]).toMatchObject({ outcome: 'failed', error: { name: 'TypeError', message: 'bad <url> happened' } });
  });

  it('returns the newest runs first, clamps the limit and survives a bad jobs column', async () => {
    const { diagnostics, storage } = await setup();
    const ids = [diagnostics.begin(START), diagnostics.begin(START), diagnostics.begin(START)];
    expect(diagnostics.recentRuns(2).map((run) => run.id)).toEqual([ids[2], ids[1]]);
    expect(diagnostics.recentRuns(0)).toHaveLength(1);
    expect(diagnostics.recentRuns(Number.NaN)).toHaveLength(3);
    expect(MAX_RUNS_PER_QUERY).toBe(100);
    storage.exec('UPDATE alarm_runs SET jobs = ? WHERE id = ?', 'not json', ids[0]!);
    storage.exec('UPDATE alarm_runs SET jobs = ? WHERE id = ?', '{"a":1}', ids[1]!);
    expect(diagnostics.recentRuns(3).map((run) => run.jobs)).toEqual([[], [], []]);
  });

  it('keeps only the last N runs: the oldest is deleted by the insert that goes over', async () => {
    const { diagnostics, storage } = await setup({ keepRuns: 5 });
    const ids = Array.from({ length: 12 }, () => diagnostics.begin(START));
    expect(storage.rows('SELECT id FROM alarm_runs ORDER BY id').map((row) => row.id)).toEqual(ids.slice(-5));
  });

  it('keeps 300 runs by default and never fewer than one', async () => {
    const { diagnostics, storage } = await setup();
    for (let index = 0; index < 305; index++) diagnostics.begin(START);
    expect(storage.rows('SELECT COUNT(*) AS n FROM alarm_runs')[0]!.n).toBe(300);
    const tiny = await setup({ keepRuns: 0, keepArms: 0 });
    tiny.diagnostics.begin(START);
    tiny.diagnostics.begin(START);
    tiny.diagnostics.recordArm('start', 1, null);
    tiny.diagnostics.recordArm('start', 2, null);
    expect(tiny.storage.rows('SELECT COUNT(*) AS n FROM alarm_runs')[0]!.n).toBe(1);
    expect(tiny.storage.rows('SELECT COUNT(*) AS n FROM alarm_arms')[0]!.n).toBe(1);
  });

  it('writes at most 3 rows per run once the buffer is full, and 2 per extra arm', async () => {
    const usage: SqlUsage[] = [];
    const { diagnostics } = await setup({ keepRuns: 3, keepArms: 3, onUsage: (delta) => usage.push(delta) });
    for (let index = 0; index < 3; index++) {
      diagnostics.recordArm('job-enqueued', 1, null);
      diagnostics.finish(diagnostics.begin(START), FINISH);
    }
    usage.length = 0;
    diagnostics.finish(diagnostics.begin(START), FINISH);
    expect(usage.reduce((sum, delta) => sum + delta.rowsWritten, 0)).toBe(3);
    usage.length = 0;
    diagnostics.recordArm('start', 9, 4);
    expect(usage.reduce((sum, delta) => sum + delta.rowsWritten, 0)).toBe(2);
  });

  it('has an index-free schema (no secondary index adds a written row)', () => {
    expect(DIAGNOSTICS_SCHEMAS.join(' ')).not.toMatch(/CREATE (UNIQUE )?INDEX|AUTOINCREMENT/);
  });

  it('refuses a negative retry count', async () => {
    const { diagnostics } = await setup();
    diagnostics.begin({ ...START, retryCount: -3 });
    expect(diagnostics.recentRuns(1)[0]!.retryCount).toBe(0);
  });
});

describe('AlarmDiagnostics arms', () => {
  it('records each setAlarm with its reason, newest first, with the run that was executing', async () => {
    const { diagnostics, clock } = await setup();
    diagnostics.recordArm('start', clock.ms + 10, null);
    clock.advance(5);
    diagnostics.recordArm('job-enqueued', clock.ms + 20, 7);
    expect(diagnostics.recentArms(10)).toEqual([
      expect.objectContaining({ at: clock.ms, reason: 'job-enqueued', alarmAt: clock.ms + 20, runId: 7 }),
      expect.objectContaining({ at: clock.ms - 5, reason: 'start', alarmAt: clock.ms - 5 + 10, runId: null }),
    ]);
  });

  it('prunes to the last N arms', async () => {
    const { diagnostics } = await setup({ keepArms: 4 });
    for (let index = 0; index < 9; index++) diagnostics.recordArm('keep-alive', index, null);
    expect(diagnostics.recentArms(100).map((arm) => arm.alarmAt)).toEqual([8, 7, 6, 5]);
  });
});

describe('AlarmDiagnostics summary', () => {
  it('counts the runs of the last 24 hours by outcome, with the runs that never finished and the retries', async () => {
    const { diagnostics, clock, storage } = await setup();
    const old = diagnostics.begin(START);
    diagnostics.finish(old, FINISH);
    clock.advance(25 * 3_600_000); // the first run is now outside the window
    const completed = diagnostics.begin(START);
    diagnostics.finish(completed, FINISH);
    diagnostics.finish(diagnostics.begin(START), { ...FINISH, outcome: 'deferred' });
    diagnostics.finish(diagnostics.begin({ ...START, retryCount: 3, isRetry: true }), { ...FINISH, outcome: 'failed', error: { name: 'Error', message: 'x' } });
    diagnostics.begin(START); // started, never finished
    clock.advance(UNFINISHED_AFTER_MS + 1);
    diagnostics.begin(START); // started just now: in progress
    storage.exec("UPDATE alarm_runs SET outcome = 'strange' WHERE id = ?", completed);
    expect(diagnostics.summary()).toEqual({
      since: clock.ms - 24 * 3_600_000,
      runs: 5,
      completed: 0,
      deferred: 1,
      failed: 1,
      unfinished: 1,
      inProgress: 1,
      retries: 1,
      maxRetryCount: 3,
    });
  });

  it('is empty without runs', async () => {
    const { diagnostics, clock } = await setup();
    expect(diagnostics.summary()).toMatchObject({ since: clock.ms - 24 * 3_600_000, runs: 0, unfinished: 0, retries: 0, maxRetryCount: 0 });
  });
});

describe('sanitising', () => {
  it('drops URLs with their query strings, credentials, bearer values and long tokens', () => {
    expect(sanitizeDiagnosticMessage('GET https://api.example.com/v1/x?apikey=SECRET&b=1 failed')).toBe('GET <url> failed');
    expect(sanitizeDiagnosticMessage('http://a.b/c')).toBe('<url>');
    expect(sanitizeDiagnosticMessage('apikey=abc123 and token: xyz')).toBe('api<redacted> and <redacted>');
    expect(sanitizeDiagnosticMessage('Authorization: Bearer abc')).toBe('<redacted>');
    expect(sanitizeDiagnosticMessage('sent Bearer abc')).toBe('sent <redacted>');
    expect(sanitizeDiagnosticMessage('key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end')).toBe('key <redacted> end');
    expect(sanitizeDiagnosticMessage('no key found for this symbol')).toBe('no key found for this symbol');
  });

  it('collapses whitespace, accepts non-strings and cuts to 200 characters', () => {
    expect(sanitizeDiagnosticMessage('a \n\t b')).toBe('a b');
    expect(sanitizeDiagnosticMessage(42)).toBe('42');
    expect(sanitizeDiagnosticMessage('word '.repeat(100))).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_CHARS);
  });

  it('keeps only identifier-like error class names', () => {
    expect(diagnosticErrorName(new RangeError('x'))).toBe('RangeError');
    expect(diagnosticErrorName('plain string')).toBe('Error');
    const odd = new Error('x');
    odd.name = 'has spaces and https://x';
    expect(diagnosticErrorName(odd)).toBe('Error');
    expect(describeDiagnosticError(new TypeError('boom https://x.y/?k=v'))).toEqual({ name: 'TypeError', message: 'boom <url>' });
    expect(describeDiagnosticError('just text')).toEqual({ name: 'Error', message: 'just text' });
  });

  it('sanitises the stored trigger and the stored error message even when the caller did not', async () => {
    const { diagnostics } = await setup();
    const id = diagnostics.begin({ ...START, trigger: 'https://x.example/a?token=1' });
    diagnostics.finish(id, { ...FINISH, outcome: 'failed', error: { name: 'Error', message: 'password=hunter2' } });
    expect(diagnostics.recentRuns(1)[0]).toMatchObject({ trigger: '<url>', error: { message: '<redacted>' } });
  });
});
