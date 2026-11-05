import { sanitizeAttemptError, type DividendAttempt, type DividendEvent } from '@portfolio/shared';
import { errorMessage, errorName, RateLimitError } from '../errors.js';
import type { CalendarState } from '../repository.js';
import type { StepContext } from './common.js';

const NO_EXTRA: CalendarState = {};

/** The provider's events with their source recorded (the provider does not say it; a pay date means the dividend was declared). */
export const fromEodhd = (events: readonly DividendEvent[]): DividendEvent[] => events.map((event) => ({ ...event, source: 'eodhd', ...(event.payDate === undefined ? {} : { declared: true }) }));

/** The marker attributes of an attempt: the attempt itself, and `dividendsCheckedAt` when the provider answered. */
export function attemptMarker(attempt: DividendAttempt): CalendarState {
  return {
    dividendsAttemptAt: attempt.at,
    dividendsOutcome: attempt.outcome,
    dividendsReason: attempt.reason,
    dividendsSource: attempt.source,
    dividendsEvents: attempt.events,
    ...(attempt.outcome === 'ok' || attempt.outcome === 'none' ? { dividendsCheckedAt: attempt.at } : {}),
  };
}

/** What a failed check is recorded as: a limit, or a failure with the sanitized cause (`step` says which call it was). */
export function failureAttempt(error: unknown, stamp: string, step: 'splits' | 'dividends'): DividendAttempt {
  const cause = sanitizeAttemptError(errorMessage(error)) || errorName(error);
  return { at: stamp, outcome: error instanceof RateLimitError ? 'rate-limited' : 'failed', reason: step === 'splits' ? `the splits call came first: ${cause}` : cause, source: 'eodhd', events: 0 };
}

/** Records an attempt (with `extra` marker attributes in the same write). Never throws: the Diagnostics record must not fail a job. */
export async function recordAttempt(ctx: StepContext, symbol: string, attempt: DividendAttempt, extra: CalendarState = NO_EXTRA): Promise<void> {
  try {
    await ctx.repo.putState(symbol, { ...extra, ...attemptMarker(attempt) });
  } catch (error) {
    ctx.logger.error('could not record the dividends check', { symbol, error: errorMessage(error) });
  }
}
