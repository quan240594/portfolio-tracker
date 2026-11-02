import { MAX_RUN_CONFLICTS, MAX_RUN_SYMBOLS, sanitizeAttemptError, type EarningsRunRecord, type EarningsRunStatus, type EarningsSourceName, type EarningsSourceRun, type StoredEarningsEvent } from '@portfolio/shared';
import type { CalendarRefreshSummary, EarningsFetchReport, EarningsSource, JobHandler, JobPayloads } from '@portfolio/platform';
import { z } from 'zod';
import { errorMessage, errorName, RateLimitError } from '../errors.js';
import { byText, definedOnly } from '../parse.js';
import { earningsTargets } from '../providers/calendar.js';
import { FINNHUB_WINDOW_DAYS } from '../providers/finnhub.js';
import type { CalendarState } from '../repository.js';
import { isCrypto } from '../symbols.js';
import { addDays, utcDay } from '../time.js';
import { DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS } from './enrich.js';
import { mergeEarningsSources, trackSeen, type StoredAhead } from './earnings-merge.js';
import { createStepContext, decodeState, pendingStep, runStep, rethrowBudget, runUnits, whileAffordable, type PriceJobDeps, type StepContext } from './common.js';

/** A symbol check is the splits call and (when enabled) the dividends call. */
const SYMBOL_CALLS = 2;
const MS_PER_DAY = 86_400_000;

const earningsSchema = z.object({ status: z.enum(['ok', 'provider-limited', 'no-provider', 'no-symbols', 'budget-exhausted', 'rate-limited', 'failed']), symbols: z.number().optional(), events: z.number().optional(), staleDeleted: z.number().optional(), error: z.string().optional() });
const stateSchema = z.object({
  v: z.literal(1),
  now: z.string(),
  trigger: z.enum(['scheduled', 'manual']).optional(),
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

type Earnings = NonNullable<State['earnings']>;
type RunDetail = Omit<EarningsRunRecord, 'at' | 'trigger' | 'tracked'>;

/** What an attempt returns to the job (the summary) and leaves for the status report (the run record). */
interface Attempt {
  summary: Earnings;
  detail: RunDetail;
}

type Calendar = Partial<EarningsFetchReport> & Pick<EarningsFetchReport, 'events'>;

/** What one source did: its entry in the run record and what it listed. */
interface SourceOutcome {
  run: EarningsSourceRun;
  report?: Calendar;
  /** Class of the error that ended the attempt. */
  failure?: string;
}

/** The Alpha Vantage token keeps the spelling the Python service uses. */
const TOKEN_SUFFIX: Readonly<Record<EarningsSourceName, string>> = { alphavantage: '', finnhub: '-finnhub' };

const NO_KEY: Readonly<Record<EarningsSourceName, EarningsSourceRun>> = {
  alphavantage: { source: 'alphavantage', status: 'no-key', reason: '' },
  finnhub: { source: 'finnhub', status: 'no-key', reason: '' },
};

/** The provider's calendar with its counts where the source reports them. */
async function readCalendar(source: EarningsSource, symbols: readonly string[], today: string, names: ReadonlyMap<string, string>): Promise<Calendar> {
  if (source.fetchReport) return source.fetchReport(symbols, today, names);
  return { events: await source.fetch(symbols, today, names) };
}

interface SourceSetup {
  name: EarningsSourceName;
  source: EarningsSource | undefined;
  /** The calendar's daily budget in calls. */
  limit: number;
}

/**
 * Reads one source: a missing key, a spent budget, a limit or a failure is that source's outcome, never an error of the run. The token is the
 * run's stamp: a step delivered again does not pay twice. A manual run asked for the call itself (the provider's own limits still apply).
 */
async function readSource(ctx: StepContext, setup: SourceSetup, eligible: readonly string[], trigger: State['trigger'], today: string, stamp: string): Promise<SourceOutcome> {
  const { name, source, limit } = setup;
  if (source === undefined) return { run: NO_KEY[name] };
  const calls = source.callsPerRun ?? 1;
  if (trigger !== 'manual' && source.budgeted && !(await ctx.repo.consumeBudget(source.name, today, calls, limit, `${stamp}#earnings${TOKEN_SUFFIX[name]}`))) {
    ctx.logger.info('earnings refresh skipped: daily budget used', { provider: source.name });
    return { run: { source: name, status: 'budget-exhausted', reason: '' } };
  }
  try {
    const report = await readCalendar(source, eligible, today, await ctx.repo.profileNames(eligible));
    const rows = report.rows;
    const limited = source.minRows !== undefined && rows !== undefined && rows < source.minRows;
    const matchedSymbols = [...new Set(report.events.map((event) => event.symbol))];
    const run: EarningsSourceRun = definedOnly<EarningsSourceRun>({ source: name, status: limited ? 'provider-limited' : 'ok', reason: '', rows, events: report.events.length, matchedSymbols: matchedSymbols.slice(0, MAX_RUN_SYMBOLS) });
    return { run, report };
  } catch (error) {
    rethrowBudget(error);
    ctx.logger.warn('earnings refresh failed', { provider: source.name, error: errorMessage(error) });
    const status = error instanceof RateLimitError ? 'rate-limited' : 'failed';
    return { run: { source: name, status, reason: sanitizeAttemptError(errorMessage(error)) || errorName(error) }, failure: errorName(error) };
  }
}

/** The run's status from the sources: dates came in, a source was cut short, or why none delivered. */
export function overallStatus(runs: readonly EarningsSourceRun[]): Exclude<EarningsRunStatus, 'skipped'> {
  const has = (status: EarningsSourceRun['status']): boolean => runs.some((run) => run.status === status);
  if (has('ok')) return 'ok';
  if (has('provider-limited')) return 'provider-limited';
  if (has('failed')) return 'failed';
  if (has('rate-limited')) return 'rate-limited';
  return has('budget-exhausted') ? 'budget-exhausted' : 'no-provider';
}

const firstReason = (runs: readonly EarningsSourceRun[]): string => runs.find((run) => run.reason !== '')?.reason ?? '';

/** Upcoming stored dates of the symbols the sources listed: what the run compares with, and what it may remove. */
async function storedAhead(ctx: StepContext, events: readonly StoredEarningsEvent[], today: string): Promise<StoredAhead> {
  const symbols = [...new Set(events.map((event) => event.symbol))].toSorted(byText);
  return ctx.repo.upcomingEarnings(symbols, today);
}

/** A stored date the run may remove: the symbol was listed again, not under this date, by a source that covers it (Finnhub sees the next 21 days only). */
function staleDates(ahead: StoredAhead, kept: readonly StoredEarningsEvent[], runs: readonly EarningsSourceRun[], today: string): Map<string, string[]> {
  const alphaCovers = runs.some((run) => run.source === 'alphavantage' && run.status === 'ok');
  const finnhubCovers = runs.some((run) => run.source === 'finnhub' && run.status === 'ok');
  const windowEnd = addDays(today, FINNHUB_WINDOW_DAYS);
  const keep = new Set(kept.map((event) => `${event.symbol}\u0000${event.date}`));
  const stale = new Map<string, string[]>();
  for (const [symbol, stored] of ahead) {
    const gone = stored.filter((event) => !keep.has(`${symbol}\u0000${event.date}`) && (alphaCovers || (finnhubCovers && event.date <= windowEnd))).map((event) => event.date);
    if (gone.length > 0) stale.set(symbol, gone);
  }
  return stale;
}

/** Removes stored upcoming report dates that the sources no longer list (the company rescheduled). */
async function dropMovedReports(ctx: StepContext, stale: ReadonlyMap<string, readonly string[]>): Promise<number> {
  let deleted = 0;
  await runUnits([...stale].toSorted(([a], [b]) => byText(a, b)), async ([symbol, dates]) => {
    deleted += await ctx.repo.deleteEarnings(symbol, dates);
  });
  return deleted;
}

/** The job's own summary: the counts when dates came in (or a source was cut short), otherwise the class of the error. */
function summaryOf(status: Exclude<EarningsRunStatus, 'skipped'>, counts: { symbols: number; events: number; staleDeleted: number }, outcomes: readonly SourceOutcome[]): Earnings {
  if (status === 'ok' || status === 'provider-limited') return { status, ...counts };
  return definedOnly<Earnings>({ status, error: outcomes.find((outcome) => outcome.failure !== undefined)?.failure });
}

/** The tickers the sources listed, absent when no source says (the counts are absent, not zero). */
function listedOf(reports: readonly (Calendar | undefined)[]): string[] | undefined {
  const lists = reports.flatMap((report) => (report?.listed === undefined ? [] : [report.listed]));
  return lists.length === 0 ? undefined : [...new Set(lists.flat())].toSorted(byText).slice(0, MAX_RUN_SYMBOLS);
}

const sum = (values: readonly (number | undefined)[]): number | undefined => (values.every((value) => value === undefined) ? undefined : values.reduce<number>((total, value) => total + (value ?? 0), 0));

async function attemptEarnings(ctx: StepContext, state: State, today: string, stamp: string): Promise<Attempt> {
  const { earnings: alphaSource, finnhubEarnings: finnhubSource } = ctx.md;
  if (alphaSource === undefined && finnhubSource === undefined) return { summary: { status: 'no-provider' }, detail: { status: 'no-provider', reason: '', sources: [NO_KEY.alphavantage, NO_KEY.finnhub] } };
  const eligible = state.symbols.filter((symbol) => !isCrypto(symbol));
  if (earningsTargets(eligible).size === 0) return { summary: { status: 'no-symbols' }, detail: { status: 'no-symbols', reason: '' } };
  const { calendar } = ctx.deps.config;
  const alpha = await readSource(ctx, { name: 'alphavantage', source: alphaSource, limit: calendar.alphavantageDailyCalls }, eligible, state.trigger, today, stamp);
  const finnhub = await readSource(ctx, { name: 'finnhub', source: finnhubSource, limit: calendar.finnhubDailyCalls }, eligible, state.trigger, today, stamp);
  const runs = [alpha.run, finnhub.run];
  const listed = [...(alpha.report?.events ?? []), ...(finnhub.report?.events ?? [])];
  const ahead = await storedAhead(ctx, listed, today);
  const merged = mergeEarningsSources(alpha.report?.events ?? [], finnhub.report?.events ?? [], ahead, today);
  const events = trackSeen(merged.events, ahead, today);
  const written = events.length > 0 ? await ctx.repo.putEarnings(events, stamp) : 0;
  const stale = await dropMovedReports(ctx, staleDates(ahead, events, runs, today));
  const matched = [...new Set(events.map((event) => event.symbol))];
  const status = overallStatus(runs);
  const detail = definedOnly<RunDetail>({
    status,
    reason: status === 'ok' ? '' : firstReason(runs),
    rows: sum([alpha.report?.rows, finnhub.report?.rows]),
    events: written,
    matchedSymbols: matched.slice(0, MAX_RUN_SYMBOLS),
    listed: listedOf([alpha.report, finnhub.report]),
    unvouched: alpha.report?.unvouched?.slice(0, MAX_RUN_SYMBOLS),
    sources: runs,
    conflicts: merged.conflicts.length > 0 ? merged.conflicts.slice(0, MAX_RUN_CONFLICTS) : undefined,
  });
  return { summary: summaryOf(status, { symbols: matched.length, events: written, staleDeleted: stale }, [alpha, finnhub]), detail };
}

/** One call lists the upcoming earnings of every company; only tracked tickers are stored. The outcome is recorded for the Diagnostics page. */
async function refreshEarnings(ctx: StepContext, state: State, today: string, stamp: string): Promise<Earnings> {
  const { summary, detail } = await attemptEarnings(ctx, state, today, stamp);
  try {
    await ctx.repo.putEarningsRun({ at: stamp, trigger: state.trigger ?? 'scheduled', tracked: state.symbols.length, ...detail });
  } catch (error) {
    ctx.logger.warn('could not record the earnings run', { error: errorMessage(error) });
  }
  return summary;
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
  return async ({ payload, cursor }) => {
    const ctx = createStepContext(deps);
    const state = cursor === undefined ? await begin(ctx, deps.clock(), payload.trigger) : decodeState(stateSchema, cursor);
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

async function begin(ctx: StepContext, now: Date, trigger: JobPayloads['refreshCalendar']['trigger']): Promise<State> {
  return {
    v: 1,
    now: now.toISOString(),
    trigger,
    symbols: await ctx.repo.listTracked(),
    phase: 'earnings',
    earnings: null,
    actions: { planned: false, status: 'ok', eligible: 0, due: [], dueCount: 0, checked: [], failed: {}, splits: 0, dividends: 0 },
  };
}
