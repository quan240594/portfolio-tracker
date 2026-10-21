import { describe, expect, it } from 'vitest';
import { formatDuration, formatInstant, jobLine, retryLabel, statusOf } from './runFormat';
import { run, T } from '../../test/diagnostics';

describe('formatInstant', () => {
  it('uses the app date format: dd-mm-yyyy, hh:mm in local time', () => {
    expect(formatInstant(T)).toBe('20-10-2026, 11:27');
  });
});

describe('formatDuration', () => {
  it('reads in ms, seconds or minutes', () => {
    expect([0, 850, 999.4, 1_000, 2_449, 59_949, 60_000, 185_000].map((ms) => formatDuration(ms))).toEqual(['0 ms', '850 ms', '999 ms', '1.0 s', '2.4 s', '59.9 s', '1 min 0 s', '3 min 5 s']);
  });
});

describe('statusOf', () => {
  it('is the outcome, or no finish / running for a run without one', () => {
    expect(statusOf(run({ outcome: 'deferred' }))).toBe('deferred');
    expect(statusOf(run({ outcome: null, unfinished: true }))).toBe('no-finish');
    expect(statusOf(run({ outcome: null, unfinished: false }))).toBe('running');
  });
});

describe('retryLabel', () => {
  it('says No, or the retry number', () => {
    expect(retryLabel(run())).toBe('No');
    expect(retryLabel(run({ isRetry: true, retryCount: 3 }))).toBe('Retry 3');
  });
});

describe('jobLine', () => {
  it('names the job and its outcome, with the steps and the pause when there are some', () => {
    expect(jobLine({ job: 'syncBroker', outcome: 'done', steps: 1, delayMs: null })).toBe('syncBroker: done');
    expect(jobLine({ job: 'syncBroker', outcome: 'continued', steps: 2, delayMs: 0 })).toBe('syncBroker: continued (2 steps)');
    expect(jobLine({ job: 'refreshPrices', outcome: 'continued', steps: 1, delayMs: 1_000 })).toBe('refreshPrices: continued (next in 1.0 s)');
    expect(jobLine({ job: 'a', outcome: 'retried', steps: 3, delayMs: 5_000 })).toBe('a: retried (3 steps, next in 5.0 s)');
  });
});
