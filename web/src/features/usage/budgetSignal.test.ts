import { act, renderHook } from '@testing-library/react';
import {
  BUDGET_EXHAUSTED,
  BUDGET_UNAVAILABLE,
  budgetMessage,
  formatLocalTime,
  isBudgetCode,
  reportBudgetError,
  reportRequestSucceeded,
  resetBudgetNotice,
  resumeTimeFromRetryAfter,
  useBudgetNotice,
} from './budgetSignal';
import { localWeekdayTime } from '../../test/localTime';

const NOW = Date.parse('2026-10-19T10:00:00Z');

afterEach(() => {
  act(() => resetBudgetNotice());
  vi.useRealTimers();
});

/** The English weekday and 24-hour time, built without the code under test. */
const local = localWeekdayTime;

describe('isBudgetCode', () => {
  it('recognises exactly the two guard codes', () => {
    expect(isBudgetCode('BUDGET_EXHAUSTED')).toBe(true);
    expect(isBudgetCode('BUDGET_UNAVAILABLE')).toBe(true);
    expect(isBudgetCode('RATE_LIMITED')).toBe(false);
  });
});

describe('resumeTimeFromRetryAfter', () => {
  it('reads whole seconds', () => {
    expect(resumeTimeFromRetryAfter(BUDGET_EXHAUSTED, '3600', NOW)).toBe(NOW + 3_600_000);
    expect(resumeTimeFromRetryAfter(BUDGET_EXHAUSTED, ' 0 ', NOW)).toBe(NOW);
  });

  it('reads an HTTP date in the future', () => {
    expect(resumeTimeFromRetryAfter(BUDGET_EXHAUSTED, 'Mon, 19 Oct 2026 11:00:00 GMT', NOW)).toBe(NOW + 3_600_000);
  });

  it('falls back to a default per code for a missing, past or unreadable header', () => {
    expect(resumeTimeFromRetryAfter(BUDGET_EXHAUSTED, null, NOW)).toBe(NOW + 300_000);
    expect(resumeTimeFromRetryAfter(BUDGET_UNAVAILABLE, '', NOW)).toBe(NOW + 60_000);
    expect(resumeTimeFromRetryAfter(BUDGET_UNAVAILABLE, 'soon', NOW)).toBe(NOW + 60_000);
    expect(resumeTimeFromRetryAfter(BUDGET_EXHAUSTED, 'Mon, 19 Oct 2026 09:00:00 GMT', NOW)).toBe(NOW + 300_000);
  });

  it('never waits longer than a day', () => {
    expect(resumeTimeFromRetryAfter(BUDGET_EXHAUSTED, '999999999', NOW)).toBe(NOW + 86_400_000);
  });
});

describe('formatLocalTime', () => {
  it('prints the local weekday and time in English, from a timestamp or an ISO string', () => {
    const iso = '2026-10-20T00:00:00.000Z';
    expect(formatLocalTime(iso)).toBe(local(iso));
    expect(formatLocalTime(Date.parse(iso))).toBe(local(iso));
    expect(formatLocalTime(iso)).toMatch(/\d{2}:\d{2}/);
  });
});

describe('budgetMessage', () => {
  it('says the app paused itself and when it resumes', () => {
    const resumesAt = Date.parse('2026-10-20T00:00:00Z');
    expect(budgetMessage(BUDGET_EXHAUSTED, resumesAt)).toBe(`Paused to stay inside the free plan, resumes at ${local('2026-10-20T00:00:00Z')}.`);
  });

  it('has its own short message when the usage could not be checked', () => {
    expect(budgetMessage(BUDGET_UNAVAILABLE, NOW)).toBe('Usage could not be checked, so changes are paused for a moment. Try again shortly.');
  });
});

describe('useBudgetNotice', () => {
  it('follows reported refusals', () => {
    const { result } = renderHook(() => useBudgetNotice());
    expect(result.current).toBeUndefined();
    act(() => reportBudgetError(BUDGET_EXHAUSTED, Date.now() + 60_000));
    expect(result.current?.code).toBe(BUDGET_EXHAUSTED);
  });

  it('is cleared by any successful request after a 429, but only by a write after a 503', () => {
    const { result } = renderHook(() => useBudgetNotice());
    act(() => reportBudgetError(BUDGET_EXHAUSTED, Date.now() + 60_000));
    act(() => reportRequestSucceeded('GET', Date.now()));
    expect(result.current).toBeUndefined();

    act(() => reportBudgetError(BUDGET_UNAVAILABLE, Date.now() + 60_000));
    act(() => reportRequestSucceeded('GET', Date.now()));
    expect(result.current?.code).toBe(BUDGET_UNAVAILABLE);
    act(() => reportRequestSucceeded('POST', Date.now()));
    expect(result.current).toBeUndefined();
  });

  it('ignores a success of a request that was already in flight when the refusal came', () => {
    const { result } = renderHook(() => useBudgetNotice());
    act(() => reportBudgetError(BUDGET_EXHAUSTED, NOW + 60_000, NOW));
    act(() => reportRequestSucceeded('GET', NOW - 1));
    expect(result.current?.reportedAt).toBe(NOW);
    act(() => reportRequestSucceeded('GET', NOW));
    expect(result.current).toBeUndefined();
  });

  it('ignores successes while nothing is reported', () => {
    const { result } = renderHook(() => useBudgetNotice());
    act(() => reportRequestSucceeded('POST', Date.now()));
    expect(result.current).toBeUndefined();
  });

  it('expires by itself at the resume time', () => {
    vi.useFakeTimers({ now: NOW });
    const { result } = renderHook(() => useBudgetNotice());
    act(() => reportBudgetError(BUDGET_EXHAUSTED, NOW + 60_000));
    act(() => void vi.advanceTimersByTime(59_000));
    expect(result.current).toBeDefined();
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current).toBeUndefined();
  });

  it('shares one notice between every subscriber and stops listening on unmount', () => {
    const first = renderHook(() => useBudgetNotice());
    const second = renderHook(() => useBudgetNotice());
    act(() => reportBudgetError(BUDGET_UNAVAILABLE, Date.now() + 60_000));
    expect(first.result.current).toEqual(second.result.current);
    second.unmount();
    act(() => resetBudgetNotice());
    expect(first.result.current).toBeUndefined();
  });
});
