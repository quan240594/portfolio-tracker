import { drain, sequentially } from '@portfolio/shared';
import { silentLogger, type JobStep, type Logger } from '@portfolio/platform';
import type { ZodType } from 'zod';
import { SubrequestBudgetError } from '../errors.js';
import { budgetedFetch, type BudgetedFetch } from '../http.js';
import { createMarketData, type MarketData, type MarketDataDeps } from '../market.js';
import { PriceRepository } from '../repository.js';

/** Cloudflare's free plan allows 50 subrequests per invocation; a step uses at most 40 of them (retries included). */
export const DEFAULT_STEP_SUBREQUESTS = 40;

/** One provider call can use up to 1 + maxRetries (3) fetches; a unit only starts when its worst case still fits. */
export const CALL_RESERVE = 4;

export interface PriceJobDeps extends MarketDataDeps {
  /** Subrequests (fetches, retries included) one step may use. Default 40. */
  stepSubrequests?: number;
}

/** What one step works with: providers around a budgeted `fetch`, the repository and the logger. */
export interface StepContext {
  md: MarketData;
  repo: PriceRepository;
  budget: BudgetedFetch;
  logger: Logger;
  deps: PriceJobDeps;
  /** Whether `calls` more provider calls (worst case, every call retried) still fit in the step. */
  affords(calls: number): boolean;
  /** Whether `calls` more fetches fit, assuming no retries (units that write only at their end may be cut off and rerun). */
  hasCalls(calls: number): boolean;
}

export function createStepContext(deps: PriceJobDeps): StepContext {
  const budget = budgetedFetch(deps.fetch, deps.stepSubrequests ?? DEFAULT_STEP_SUBREQUESTS);
  return {
    md: (deps.marketData ?? createMarketData)(deps, budget.fetch),
    repo: new PriceRepository(deps.store),
    budget,
    logger: deps.logger ?? silentLogger,
    deps,
    // A fresh step always runs one unit, so that a tiny budget cannot stall a job.
    affords: (calls) => budget.used() === 0 || budget.remaining() >= calls * CALL_RESERVE,
    hasCalls: (calls) => budget.used() === 0 || budget.remaining() >= calls,
  };
}

/** Rethrows the budget error (the unit is unfinished); every other error is the caller's to count. */
export function rethrowBudget(error: unknown): void {
  if (error instanceof SubrequestBudgetError) throw error;
}

/** Items of `queue` front to back, for as long as `affordable()` holds; the task removes an item when it is done. */
export function* whileAffordable<T>(queue: readonly T[], affordable: () => boolean): Generator<T, void, undefined> {
  while (queue.length > 0 && affordable()) yield queue[0]!;
}

/** Runs `task` for the items one after another (see `whileAffordable`). */
export const runUnits = <T>(items: Iterable<T>, task: (item: T) => Promise<void>): Promise<void> => drain(sequentially(items, task));

export function decodeState<S>(schema: ZodType<S>, cursor: string): S {
  return schema.parse(JSON.parse(cursor));
}

export const encodeState = (state: unknown): string => JSON.stringify(state);

/** A not-finished step: the adapter calls the handler again with `next`, after `delayMs` when given. */
export function pendingStep(state: unknown, delayMs?: number): JobStep<never> {
  const next = encodeState(state);
  return delayMs !== undefined && delayMs > 0 ? { done: false, next, delayMs: Math.ceil(delayMs) } : { done: false, next };
}

/**
 * Runs the work of one step. When the subrequest budget cuts it off, the next step continues from `state` (the work that
 * was done so far is in it); a step that made no progress at all can never succeed (one unit of work needs more subrequests
 * than the budget allows), which is a configuration error. Every other error is the caller's.
 */
export async function runStep<R>(ctx: StepContext, state: unknown, work: () => Promise<JobStep<R>>): Promise<JobStep<R>> {
  const before = encodeState(state);
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof SubrequestBudgetError)) throw error;
    const next = encodeState(state);
    if (next === before) throw new Error(`A step budget of ${ctx.budget.limit} subrequests is too small for one unit of work`);
    return { done: false, next };
  }
}
