import type { StoredEarningsEvent } from '@portfolio/shared';
import type { CalendarRefreshSummary, JobHandler, JobPayloads } from '@portfolio/platform';
import { z } from 'zod';
import { errorMessage, errorName, RateLimitError } from '../errors.js';
import { byText } from '../parse.js';
import { alphaVantageSymbol } from '../providers/calendar.js';
import type { CalendarState } from '../repository.js';
import { isCrypto } from '../symbols.js';
import { addDays, utcDay } from '../time.js';
import { DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS } from './enrich.js';
import { createStepContext, decodeState, pendingStep, runStep, rethrowBudget, runUnits, whileAffordable, type PriceJobDeps, type StepContext } from './common.js';

/** A symbol check is the splits call and (when enabled) the dividends call. */
const SYMBOL_CALLS = 2;
const MS_PER_DAY = 86_400_000;

const earningsSchema = z.object({ status: z.enum(['ok', 'no-provider', 'no-symbols', 'budget-exhausted', 'failed']), symbols: z.number().optional(), events: z.number().optional(), staleDeleted: z.number().optional(), error: z.string().optional() });
const stateSchema = z.object({
  v: z.literal(1),
  now: z.string(),
  symbols: z.array(z.string()),
  phase: z.enum(['earnings', 'actions', 'done']),
  earnings: earningsSchema.nullable(),
  actions: z.object({
    planned: z.boolean(),
    status: z.enum(['ok', 'no-provider', 'budget-exhausted', 'rate-limited']),
    eligible: z.number(),
    due: z.array(z.string()),
    dueCount: z.number(),
    checked: z.array(z.string()),
    failed: z.record(z.string()),
    splits: z.number(),
    dividends: z.number(),
  }),
});

type State = z.infer<typeof stateSchema>;

export type CalendarJobResult = CalendarRefreshSummary & {
  corporateActions: CalendarRefreshSummary['corporateActions'] & { eligible?: number; due?: number; failedSymbols?: string[]; checkedSymbols?: string[] };
};

/**
 * Symbols whose splits were not checked within `recheckDays`, least recently attempted first. Never-checked symbols come
 * first; a symbol whose last attempt failed goes to the back of the queue so one broken ticker cannot use up the daily budget.
 */
export function dueSymbols(symbols: readonly string[], states: ReadonlyMap<string, CalendarState>, now: Date, recheckDays: number): string[] {
  const cutoff = new Date(now.getTime() - recheckDays * MS_PER_DAY).toISOString();
  const checked = (symbol: string): string => states.get(symbol)?.splitsCheckedAt ?? '';
  const attempted = (symbol: string): string => [checked(symbol), states.get(symbol)?.splitsFailedAt ?? ''].toSorted(byText).at(-1)!;
  return symbols
    .filter((symbol) => checked(symbol) < cutoff)
    .toSorted((a, b) => byText(attempted(a), attempted(b)) || byText(a, b));
}

// --- earnings ---

/** One provider call lists the upcoming earnings of every company; only tracked tickers are stored. */
async function refreshEarnings(ctx: StepContext, state: State, today: string, stamp: string): Promise<NonNullable<State['earnings']>> {
  const source = ctx.md.earnings;
  if (source === undefined) return { status: 'no-provider' };
  const eligible = state.symbols.filter((symbol) => alphaVantageSymbol(symbol) !== null);
  if (eligible.length === 0) return { status: 'no-symbols' };
  const { calendar } = ctx.deps.config;
  // The token is the run's stamp: a step delivered again does not pay twice, and is not refused for having paid before.
  if (source.budgeted && !(await ctx.repo.consumeBudget(source.name, today, 1, calendar.alphavantageDailyCalls, `${stamp}#earnings`))) {
    ctx.logger.info('earnings refresh skipped: daily budget used', { provider: source.name });
    return { status: 'budget-exhausted' };
  }
  try {
    const events = await source.fetch(eligible, today);
    const written = await ctx.repo.putEarnings(events, stamp);
    const stale = await dropMovedReports(ctx, events, today);
    return { status: 'ok', symbols: new Set(events.map((event) => event.symbol)).size, events: written, staleDeleted: stale };
  } catch (error) {
    rethrowBudget(error);
    ctx.logger.warn('earnings refresh failed', { provider: source.name, error: errorMessage(error) });
    return { status: 'failed', error: errorName(error) };
  }
}

/** Removes stored upcoming report dates that the provider no longer lists (the company rescheduled). */
async function dropMovedReports(ctx: StepContext, events: readonly StoredEarningsEvent[], today: string): Promise<number> {
  const dates = new Map<string, Set<string>>();
  for (const event of events) dates.set(event.symbol, (dates.get(event.symbol) ?? new Set<string>()).add(event.date));
  let deleted = 0;
  await runUnits([...dates].toSorted(([a], [b]) => byText(a, b)), async ([symbol, keep]) => {
    const stale = await ctx.repo.staleEarningsDates(symbol, today, keep);
    if (stale.length > 0) deleted += await ctx.repo.deleteEarnings(symbol, stale);
  });
  return deleted;
}

// --- splits and dividends ---

async function markFailed(ctx: StepContext, symbol: string, stamp: string): Promise<void> {
  try {
    await ctx.repo.putState(symbol, { splitsFailedAt: stamp });
  } catch (error) {
    ctx.logger.error('could not record failed calendar check', { symbol, error: errorMessage(error) });
  }
}

/** Fetches and stores the splits (and dividends) of one symbol, then marks it checked. */
async function checkSymbol(ctx: StepContext, symbol: string, today: string, stamp: string): Promise<{ splits: number; dividends: number }> {
  const source = ctx.md.actions!;
  const { calendar } = ctx.deps.config;
  const splits = await source.getSplits(symbol, addDays(today, -calendar.splitLookbackDays));
  const written = await ctx.repo.putSplits(splits, stamp);
  const marker: CalendarState = { splitsCheckedAt: stamp };
  let dividendsWritten = 0;
  if (calendar.refreshDividends) {
    const dividends = await source.getDividends(symbol, addDays(today, -DIVIDEND_LOOKBACK_DAYS), addDays(today, DIVIDEND_LOOKAHEAD_DAYS));
    dividendsWritten = await ctx.repo.putDividends(dividends);
    marker.dividendsCheckedAt = stamp;
  }
  await ctx.repo.putState(symbol, marker);
  return { splits: written, dividends: dividendsWritten };
}

/** Outcome of one symbol: checked, or the status that ends the run (budget spent, provider limit). */
async function processSymbol(ctx: StepContext, state: State, symbol: string, today: string, stamp: string): Promise<'next' | 'stop'> {
  const source = ctx.md.actions!;
  const { calendar } = ctx.deps.config;
  const { actions } = state;
  const cost = calendar.refreshDividends ? 2 : 1;
  if (source.budgeted && !(await ctx.repo.consumeBudget(source.name, today, cost, calendar.eodhdDailyCalls, `${stamp}#${symbol}`))) {
    actions.status = 'budget-exhausted';
    return 'stop';
  }
  try {
    const written = await checkSymbol(ctx, symbol, today, stamp);
    actions.checked.push(symbol);
    actions.splits += written.splits;
    actions.dividends += written.dividends;
  } catch (error) {
    rethrowBudget(error);
    if (error instanceof RateLimitError) {
      ctx.logger.warn('provider limit reached; stopping', { provider: source.name, error: error.message });
      actions.status = 'rate-limited';
      return 'stop';
    }
    ctx.logger.warn('calendar check failed', { symbol, error: errorMessage(error) });
    actions.failed[symbol] = errorName(error);
    await markFailed(ctx, symbol, stamp);
  }
  return 'next';
}

async function refreshActions(ctx: StepContext, state: State, now: Date, today: string, stamp: string): Promise<void> {
  const { actions } = state;
  if (ctx.md.actions === undefined) {
    actions.status = 'no-provider';
    state.phase = 'done';
    return;
  }
  if (!actions.planned) {
    const eligible = state.symbols.filter((symbol) => !isCrypto(symbol));
    const due = dueSymbols(eligible, await ctx.repo.getStates(eligible), now, ctx.deps.config.calendar.recheckDays);
    Object.assign(actions, { planned: true, eligible: eligible.length, due, dueCount: due.length });
  }
  let stopped = false;
  await runUnits(
    whileAffordable(actions.due, () => !stopped && ctx.hasCalls(SYMBOL_CALLS)),
    async (symbol) => {
      stopped = (await processSymbol(ctx, state, symbol, today, stamp)) === 'stop';
      if (!stopped) actions.due.shift();
    },
  );
  if (actions.due.length === 0 || stopped) state.phase = 'done';
}

function summarize(state: State): CalendarJobResult {
  const { actions } = state;
  return {
    tracked: state.symbols.length,
    earnings: state.earnings ?? { status: 'no-provider' },
    corporateActions: {
      status: actions.status,
      checked: actions.checked.length,
      splits: actions.splits,
      dividends: actions.dividends,
      failed: Object.keys(actions.failed).length,
      eligible: actions.eligible,
      due: actions.dueCount,
      failedSymbols: Object.keys(actions.failed).toSorted(byText),
      checkedSymbols: actions.checked,
    },
  };
}

export type RefreshCalendarJob = JobHandler<JobPayloads['refreshCalendar'], CalendarJobResult>;

/**
 * `refreshCalendar`: upcoming earnings of every tracked ticker (one Alpha Vantage call), then splits (and refreshed
 * dividends) for the rotating, budgeted subset of tracked tickers that is due (EODHD). Daily budgets are spent through
 * the item store (`CALENDAR/BUDGET#{provider}`), so retries and manual runs cannot overspend a free tier. Failures are
 * per symbol/provider: counted in the result, never thrown.
 */
export function createRefreshCalendarJob(deps: PriceJobDeps): RefreshCalendarJob {
  return async ({ cursor }) => {
    const ctx = createStepContext(deps);
    const state = cursor === undefined ? await begin(ctx, deps.clock()) : decodeState(stateSchema, cursor);
    const now = new Date(state.now);
    const today = utcDay(now);
    const stamp = now.toISOString();
    return runStep(ctx, state, async () => {
      if (state.phase === 'earnings') {
        state.earnings = await refreshEarnings(ctx, state, today, stamp);
        state.phase = 'actions';
      }
      if (state.phase === 'actions') await refreshActions(ctx, state, now, today, stamp);
      return state.phase === 'done' ? { done: true, result: summarize(state) } : pendingStep(state);
    });
  };
}

async function begin(ctx: StepContext, now: Date): Promise<State> {
  return {
    v: 1,
    now: now.toISOString(),
    symbols: await ctx.repo.listTracked(),
    phase: 'earnings',
    earnings: null,
    actions: { planned: false, status: 'ok', eligible: 0, due: [], dueCount: 0, checked: [], failed: {}, splits: 0, dividends: 0 },
  };
}
