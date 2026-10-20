import { useEffect, useSyncExternalStore } from 'react';
import { formatWeekdayTime } from '../../lib/format';

/** Error codes of the free-plan budget guard (docs/architecture.md, "Free-plan budget guard"). */
export const BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED';
export const BUDGET_UNAVAILABLE = 'BUDGET_UNAVAILABLE';

export type BudgetCode = typeof BUDGET_EXHAUSTED | typeof BUDGET_UNAVAILABLE;

export const isBudgetCode = (code: string): code is BudgetCode => code === BUDGET_EXHAUSTED || code === BUDGET_UNAVAILABLE;

/** Used when the response carries no usable Retry-After. */
const DEFAULT_RETRY_SECONDS: Record<BudgetCode, number> = { BUDGET_EXHAUSTED: 300, BUDGET_UNAVAILABLE: 60 };
/** The counters reset daily, so a longer wait is never meaningful (and keeps setTimeout below its 32-bit limit). */
const MAX_RETRY_SECONDS = 86_400;

/** Parses a Retry-After header (whole seconds or an HTTP date) into the epoch ms the caller may retry at. */
export function resumeTimeFromRetryAfter(code: BudgetCode, header: string | null, now: number = Date.now()): number {
  const value = header?.trim() ?? '';
  let seconds = DEFAULT_RETRY_SECONDS[code];
  if (/^\d{1,9}$/.test(value)) seconds = Number(value);
  else if (Date.parse(value) > now) seconds = (Date.parse(value) - now) / 1000;
  return now + Math.min(seconds, MAX_RETRY_SECONDS) * 1000;
}

/** "Mon 02:00": local weekday and time, English weekday, 24-hour time. */
export function formatLocalTime(at: number | string): string {
  const iso = typeof at === 'number' ? new Date(at).toISOString() : at;
  return formatWeekdayTime(iso);
}

/** The plain-language message shown instead of a generic failure for a budget error. */
export function budgetMessage(code: BudgetCode, resumesAt: number): string {
  if (code === BUDGET_EXHAUSTED) return `Paused to stay inside the free plan, resumes at ${formatLocalTime(resumesAt)}.`;
  return 'Usage could not be checked, so changes are paused for a moment. Try again shortly.';
}

export interface BudgetNotice {
  code: BudgetCode;
  /** Epoch ms at which the refusal was seen. */
  reportedAt: number;
  /** Epoch ms after which the notice no longer applies. */
  resumesAt: number;
}

let notice: BudgetNotice | undefined;
const listeners = new Set<() => void>();

function publish(next: BudgetNotice | undefined): void {
  notice = next;
  for (const listener of listeners) listener();
}

/** Called by the API client when a request was refused by the budget guard. */
export function reportBudgetError(code: BudgetCode, resumesAt: number, now: number = Date.now()): void {
  publish({ code, resumesAt, reportedAt: now });
}

/**
 * Called by the API client after a successful request that started at `startedAt`. A success proves the guard is not
 * refusing everything, unless the request started before the refusal was seen (it was already in flight). A
 * BUDGET_UNAVAILABLE notice concerns writes only, so just a successful write clears it.
 */
export function reportRequestSucceeded(method: string, startedAt: number): void {
  if (!notice || startedAt < notice.reportedAt) return;
  if (notice.code === BUDGET_EXHAUSTED || method !== 'GET') publish(undefined);
}

/** Test helper: forget any notice. */
export function resetBudgetNotice(): void {
  publish(undefined);
}

export const getBudgetNotice = (): BudgetNotice | undefined => notice;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The active budget notice (a refused request), cleared automatically once its resume time has passed. */
export function useBudgetNotice(): BudgetNotice | undefined {
  const current = useSyncExternalStore(subscribe, getBudgetNotice);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => publish(undefined), Math.max(0, current.resumesAt - Date.now()));
    return () => clearTimeout(timer);
  }, [current]);
  return current;
}
