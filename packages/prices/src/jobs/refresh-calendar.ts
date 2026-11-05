import { MANUAL_CHECK_SYMBOLS, MAX_RUN_CONFLICTS, MAX_RUN_SYMBOLS, sanitizeAttemptError, type DividendAttempt, type EarningsRunRecord, type EarningsRunStatus, type EarningsSourceName, type EarningsSourceRun, type StoredEarningsEvent } from '@portfolio/shared';
import type { CalendarRefreshSummary, EarningsSource, JobHandler, JobPayloads } from '@portfolio/platform';
import { z } from 'zod';
import { errorMessage, errorName, RateLimitError } from '../errors.js';
import { byText, definedOnly, isRecord } from '../parse.js';
import { earningsTargets } from '../providers/calendar.js';
import { FINNHUB_WINDOW_DAYS } from '../providers/finnhub.js';
import type { CalendarState } from '../repository.js';
import { hasExchangeSuffix, isCrypto } from '../symbols.js';
import { addDays, utcDay } from '../time.js';
import { readDividends } from './dividend-read.js';
import { planRotation, type RotationEntry } from './dividend-rotation.js';
import { failureAttempt, recordAttempt, attemptMarker } from './dividend-state.js';
import { mergeEarningsSources, trackSeen, type StoredAhead } from './earnings-merge.js';
import { datedSymbols, finnhubOutcome, finnhubRunSchema, planFinnhub, readNextFinnhub, type Calendar, type SourceOutcome } from './finnhub-run.js';
import { createStepContext, decodeState, pendingStep, runStep, rethrowBudget, runUnits, whileAffordable, type PriceJobDeps, type StepContext } from './common.js';

/** Symbols a run records as skipped (not reached before the allowance or the limit ended it): the rest is in the next run's plan anyway. */
const MAX_SKIPPED_RECORDS = 60;

const earningsSchema = z.object({ status: z.enum(['ok', 'provider-limited', 'no-provider', 'no-symbols', 'budget-exhausted', 'rate-limited', 'failed']), symbols: z.number().optional(), events: z.number().optional(), staleDeleted: z.number().optional(), error: z.string().optional() });
const stateSchema = z.object({
  v: z.literal(1),
  now: z.string(),
  trigger: z.enum(['scheduled', 'manual']).optional(),
  symbols: z.array(z.string()),
  /** `dividends`: the owner's "Check dividends now": only the dividends of the held symbols, no earnings. */
  part: z.enum(['dividends']).optional(),
  phase: z.enum(['earnings', 'actions', 'done']),
  earnings: earningsSchema.nullable(),
  /** The earnings phase between its steps: what Alpha Vantage gave, and the Finnhub companies read so far and still to read. */
  progress: z
    .object({
      alpha: z.custom<SourceOutcome>((value) => isRecord(value) && isRecord(value.run)),
      finnhub: finnhubRunSchema.optional(),
    })
    .optional(),
  actions: z.object({
    planned: z.boolean(),
    status: z.enum(['ok', 'no-provider', 'budget-exhausted', 'rate-limited']),
    eligible: z.number(),
    due: z.array(z.string()),
    /** Why each due symbol is read and whether its splits are read too (absent in a state written by an earlier version: a plain rotation turn). */
    plan: z.record(z.object({ tier: z.enum(['new', 'missing', 'near', 'stale']), splits: z.boolean() })).default({}),
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

// --- earnings ---

type Earnings = NonNullable<State['earnings']>;
type RunDetail = Omit<EarningsRunRecord, 'at' | 'trigger' | 'tracked'>;

/** What an attempt returns to the job (the summary) and leaves for the status report (the run record). */
interface Attempt {
  summary: Earnings;
  detail: RunDetail;
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
  if (has('failed') || has('refused')) return 'failed';
  if (has('rate-limited')) return 'rate-limited';
  return has('budget-exhausted') ? 'budget-exhausted' : 'no-provider';
}

const firstReason = (runs: readonly EarningsSourceRun[]): string => runs.find((run) => run.reason !== '')?.reason ?? '';

/** Upcoming stored dates of the symbols the sources listed: what the run compares with, and what it may remove. */
async function storedAhead(ctx: StepContext, events: readonly StoredEarningsEvent[], today: string): Promise<StoredAhead> {
  const symbols = [...new Set(events.map((event) => event.symbol))].toSorted(byText);
  return ctx.repo.upcomingEarnings(symbols, today);
}

/**
 * A stored date the run may remove: the symbol was listed again, not under this date, by a source that covers it (Alpha Vantage: any date;
 * Finnhub: the next 21 days of a company it gave a date for).
 */
function staleDates(ahead: StoredAhead, kept: readonly StoredEarningsEvent[], runs: readonly EarningsSourceRun[], finnhubDated: ReadonlySet<string>, today: string): Map<string, string[]> {
  const alphaCovers = runs.some((run) => run.source === 'alphavantage' && run.status === 'ok');
  const windowEnd = addDays(today, FINNHUB_WINDOW_DAYS);
  const keep = new Set(kept.map((event) => `${event.symbol}\u0000${event.date}`));
  const stale = new Map<string, string[]>();
  for (const [symbol, stored] of ahead) {
    const gone = stored.filter((event) => !keep.has(`${symbol}\u0000${event.date}`) && (alphaCovers || (finnhubDated.has(symbol) && event.date <= windowEnd))).map((event) => event.date);
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

/** What the earnings phase has after its first step: the Alpha Vantage outcome and the Finnhub companies to read (the queue). */
type Progress = NonNullable<State['progress']>;

/** The symbols Finnhub is asked about: the held companies (the deployment says which), else every tracked one. */
async function finnhubSymbols(ctx: StepContext, tracked: readonly string[]): Promise<string[]> {
  const { heldCompanies } = ctx.deps;
  return heldCompanies === undefined ? [...tracked] : (await heldCompanies()).filter((symbol) => !isCrypto(symbol));
}

/** First step: nothing to look up (the attempt is final), or Alpha Vantage read and the Finnhub queue planned. */
async function startEarnings(ctx: StepContext, state: State, today: string, stamp: string): Promise<Attempt | Progress> {
  const { earnings: alphaSource, finnhubEarnings } = ctx.md;
  if (alphaSource === undefined && finnhubEarnings === undefined) return { summary: { status: 'no-provider' }, detail: { status: 'no-provider', reason: '', sources: [NO_KEY.alphavantage, NO_KEY.finnhub] } };
  const eligible = state.symbols.filter((symbol) => !isCrypto(symbol));
  if (earningsTargets(eligible).size === 0) return { summary: { status: 'no-symbols' }, detail: { status: 'no-symbols', reason: '' } };
  const { calendar } = ctx.deps.config;
  const alpha = await readSource(ctx, { name: 'alphavantage', source: alphaSource, limit: calendar.alphavantageDailyCalls }, eligible, state.trigger, today, stamp);
  if (finnhubEarnings === undefined) return { alpha };
  return { alpha, finnhub: await planFinnhub(ctx, await finnhubSymbols(ctx, eligible), today, calendar.finnhubDailyCalls) };
}

/** Last step: merges the dates of both sources with what the store has, stores them and describes the run. */
async function finishEarnings(ctx: StepContext, progress: Progress, today: string, stamp: string): Promise<Attempt> {
  const alpha = progress.alpha;
  const finnhub: SourceOutcome = progress.finnhub === undefined ? { run: NO_KEY.finnhub } : finnhubOutcome(progress.finnhub);
  const runs = [alpha.run, finnhub.run];
  const listed = [...(alpha.report?.events ?? []), ...(finnhub.report?.events ?? [])];
  const ahead = await storedAhead(ctx, listed, today);
  const merged = mergeEarningsSources(alpha.report?.events ?? [], finnhub.report?.events ?? [], ahead, today);
  const events = trackSeen(merged.events, ahead, today);
  const written = events.length > 0 ? await ctx.repo.putEarnings(events, stamp) : 0;
  const stale = await dropMovedReports(ctx, staleDates(ahead, events, runs, progress.finnhub === undefined ? new Set() : datedSymbols(progress.finnhub), today));
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

/** The outcome of the attempt is recorded for the Diagnostics page. */
async function recordEarnings(ctx: StepContext, state: State, attempt: Attempt, stamp: string): Promise<Earnings> {
  try {
    await ctx.repo.putEarningsRun({ at: stamp, trigger: state.trigger ?? 'scheduled', tracked: state.symbols.length, ...attempt.detail });
  } catch (error) {
    ctx.logger.warn('could not record the earnings run', { error: errorMessage(error) });
  }
  return attempt.summary;
}

/**
 * The earnings phase, one step at a time: the first step reads Alpha Vantage (one call lists every company) and makes the first Finnhub call;
 * each later step makes one Finnhub call for one held company. Returns the milliseconds to wait before the next step, or null when the phase
 * is finished (its summary is in `state.earnings` and the run is recorded).
 */
async function advanceEarnings(ctx: StepContext, state: State, today: string, stamp: string): Promise<number | null> {
  if (state.progress === undefined) {
    const started = await startEarnings(ctx, state, today, stamp);
    if (!('alpha' in started)) {
      state.earnings = await recordEarnings(ctx, state, started, stamp);
      return null;
    }
    state.progress = started;
  }
  const { progress } = state;
  const source = ctx.md.finnhubEarnings;
  if (source !== undefined && progress.finnhub !== undefined && progress.finnhub.queue.length > 0) {
    const wait = await readNextFinnhub(ctx, progress.finnhub, source, { today, stamp, limit: ctx.deps.config.calendar.finnhubDailyCalls });
    if (progress.finnhub.queue.length > 0) return wait;
  }
  state.earnings = await recordEarnings(ctx, state, await finishEarnings(ctx, progress, today, stamp), stamp);
  state.progress = undefined;
  return null;
}

// --- splits and dividends ---

type Actions = State['actions'];
/** A state written before the plan was kept: a symbol takes its plain turn in the rotation. */
const PLAIN_TURN: RotationEntry = { symbol: '', tier: 'stale', splits: true };

const isManual = (state: State): boolean => state.part === 'dividends';

/** The calls a symbol's check may make: the splits (when due), the dividends and, where the free fallback may be asked, its one call. */
function callsFor(ctx: StepContext, state: State, symbol: string | undefined): number {
  if (symbol === undefined) return 0;
  const entry = state.actions.plan[symbol] ?? PLAIN_TURN;
  const dividends = isManual(state) || ctx.deps.config.calendar.refreshDividends;
  const fallback = dividends && ctx.md.dividendFeed !== undefined && !hasExchangeSuffix(symbol) && (isManual(state) || entry.tier !== 'stale');
  return (entry.splits ? 1 : 0) + (dividends ? 1 : 0) + (fallback ? 1 : 0);
}

async function markFailed(ctx: StepContext, symbol: string, attempt: DividendAttempt, stamp: string): Promise<void> {
  try {
    await ctx.repo.putState(symbol, { splitsFailedAt: stamp, ...attemptMarker(attempt) });
  } catch (error) {
    ctx.logger.error('could not record failed calendar check', { symbol, error: errorMessage(error) });
  }
}

/** Where a check was when it failed: the splits call comes first, then the dividends. */
interface CheckProgress {
  step: 'splits' | 'dividends';
}

/** Fetches and stores the splits (when due) and dividends of one symbol, then marks it checked and records how the dividends check ended. */
async function checkSymbol(ctx: StepContext, state: State, symbol: string, today: string, stamp: string, progress: CheckProgress): Promise<{ splits: number; dividends: number }> {
  const source = ctx.md.actions!;
  const { calendar } = ctx.deps.config;
  const entry = state.actions.plan[symbol] ?? PLAIN_TURN;
  const marker: CalendarState = {};
  let splitsWritten = 0;
  if (entry.splits) {
    progress.step = 'splits';
    const splits = await source.getSplits(symbol, addDays(today, -calendar.splitLookbackDays));
    splitsWritten = await ctx.repo.putSplits(splits, stamp);
    marker.splitsCheckedAt = stamp;
  }
  let dividendsWritten = 0;
  if (isManual(state) || calendar.refreshDividends) {
    progress.step = 'dividends';
    const read = await readDividends(ctx, symbol, today, stamp, isManual(state) || entry.tier !== 'stale');
    dividendsWritten = read.written;
    Object.assign(marker, attemptMarker(read.attempt));
  }
  await ctx.repo.putState(symbol, marker);
  return { splits: splitsWritten, dividends: dividendsWritten };
}

/** The calendar's daily allowance for a symbol's calls; an owner's check is held to the provider's own quota only. */
function affordsSymbol(ctx: StepContext, state: State, symbol: string, today: string, stamp: string): Promise<boolean> {
  const source = ctx.md.actions!;
  const { calendar } = ctx.deps.config;
  if (isManual(state) || !source.budgeted) return Promise.resolve(true);
  const entry = state.actions.plan[symbol] ?? PLAIN_TURN;
  const cost = Math.max(1, (entry.splits ? 1 : 0) + (calendar.refreshDividends ? 1 : 0));
  return ctx.repo.consumeBudget(source.name, today, cost, calendar.eodhdDailyCalls, `${stamp}#${symbol}`);
}

/** Outcome of one symbol: checked, or the status that ends the run (budget spent, provider limit). */
async function processSymbol(ctx: StepContext, state: State, symbol: string, today: string, stamp: string): Promise<'next' | 'stop'> {
  const source = ctx.md.actions!;
  const { actions } = state;
  if (!(await affordsSymbol(ctx, state, symbol, today, stamp))) {
    actions.status = 'budget-exhausted';
    return 'stop';
  }
  const progress: CheckProgress = { step: 'splits' };
  try {
    const written = await checkSymbol(ctx, state, symbol, today, stamp, progress);
    actions.checked.push(symbol);
    actions.splits += written.splits;
    actions.dividends += written.dividends;
  } catch (error) {
    rethrowBudget(error);
    const attempt = failureAttempt(error, stamp, progress.step);
    if (error instanceof RateLimitError) {
      ctx.logger.warn('provider limit reached; stopping', { provider: source.name, error: error.message });
      actions.status = 'rate-limited';
      await recordAttempt(ctx, symbol, attempt);
      return 'stop';
    }
    ctx.logger.warn('calendar check failed', { symbol, error: errorMessage(error) });
    actions.failed[symbol] = errorName(error);
    await markFailed(ctx, symbol, attempt, stamp);
  }
  return 'next';
}

/** The symbols a run ended before it reached: recorded, so the Diagnostics page says why their dividends were not read today. */
async function recordSkipped(ctx: StepContext, actions: Actions, stamp: string): Promise<void> {
  const limited = actions.status === 'rate-limited';
  const skipped = (limited ? actions.due.slice(1) : actions.due).slice(0, MAX_SKIPPED_RECORDS);
  const attempt: DividendAttempt = { at: stamp, outcome: limited ? 'rate-limited' : 'budget', reason: limited ? 'the provider limit was reached before its turn' : '', source: 'eodhd', events: 0 };
  await runUnits(skipped, (symbol) => recordAttempt(ctx, symbol, attempt));
}

/** The symbols the run looks at: the tracked ones that can pay (no crypto); a manual check only the held ones when the deployment says which. */
function eligibleSymbols(state: State, held: ReadonlyMap<string, string> | undefined): string[] {
  const candidates = state.symbols.filter((symbol) => !isCrypto(symbol));
  return isManual(state) && held !== undefined ? candidates.filter((symbol) => held.has(symbol)) : candidates;
}

/** Plans the run: which symbols are read, in which order and why (see `planRotation`). */
async function planActions(ctx: StepContext, state: State, now: Date, today: string): Promise<void> {
  const { calendar } = ctx.deps.config;
  const manual = isManual(state);
  const held = await ctx.deps.heldPositions?.();
  const eligible = eligibleSymbols(state, held);
  const prioritised = manual || calendar.refreshDividends;
  const [states, dates] = await Promise.all([ctx.repo.getStates(eligible), prioritised ? ctx.repo.dividendDates(eligible, today) : new Map<string, { last?: string; next?: string }>()]);
  const planned = planRotation(eligible, { now, mode: manual ? 'manual' : 'scheduled', recheckDays: calendar.recheckDays, states, dates, heldSince: prioritised && held !== undefined ? held : new Map<string, string>() });
  const plan = manual ? planned.slice(0, MANUAL_CHECK_SYMBOLS) : planned;
  Object.assign(state.actions, { planned: true, eligible: eligible.length, due: plan.map((entry) => entry.symbol), dueCount: plan.length, plan: Object.fromEntries(plan.map((entry) => [entry.symbol, { tier: entry.tier, splits: entry.splits }])) });
}

async function refreshActions(ctx: StepContext, state: State, now: Date, today: string, stamp: string): Promise<void> {
  const { actions } = state;
  if (ctx.md.actions === undefined) {
    actions.status = 'no-provider';
    state.phase = 'done';
    return;
  }
  if (!actions.planned) await planActions(ctx, state, now, today);
  let stopped = false;
  await runUnits(
    whileAffordable(actions.due, () => !stopped && ctx.hasCalls(callsFor(ctx, state, actions.due[0]))),
    async (symbol) => {
      stopped = (await processSymbol(ctx, state, symbol, today, stamp)) === 'stop';
      if (!stopped) actions.due.shift();
    },
  );
  if (stopped) await recordSkipped(ctx, actions, stamp);
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
 * `refreshCalendar`: upcoming earnings (one Alpha Vantage call for every tracked ticker; one paced Finnhub call per step for each held
 * US company), then splits (and refreshed dividends) for the rotating, budgeted subset of tracked tickers that is due (EODHD). Daily budgets are spent through
 * the item store (`CALENDAR/BUDGET#{provider}`), so retries and manual runs cannot overspend a free tier. Failures are
 * per symbol/provider: counted in the result, never thrown.
 */
export function createRefreshCalendarJob(deps: PriceJobDeps): RefreshCalendarJob {
  return async ({ payload, cursor }) => {
    const ctx = createStepContext(deps);
    const state = cursor === undefined ? await begin(ctx, deps.clock(), payload.trigger, payload.part) : decodeState(stateSchema, cursor);
    const now = new Date(state.now);
    const today = utcDay(now);
    const stamp = now.toISOString();
    return runStep(ctx, state, async () => {
      if (state.phase === 'earnings') {
        const wait = await advanceEarnings(ctx, state, today, stamp);
        if (wait !== null) return pendingStep(state, wait);
        state.phase = 'actions';
      }
      if (state.phase === 'actions') await refreshActions(ctx, state, now, today, stamp);
      return state.phase === 'done' ? { done: true, result: summarize(state) } : pendingStep(state);
    });
  };
}

async function begin(ctx: StepContext, now: Date, trigger: JobPayloads['refreshCalendar']['trigger'], part: JobPayloads['refreshCalendar']['part']): Promise<State> {
  return {
    v: 1,
    now: now.toISOString(),
    trigger,
    ...(part === undefined ? {} : { part }),
    symbols: await ctx.repo.listTracked(),
    phase: part === undefined ? 'earnings' : 'actions',
    earnings: part === undefined ? null : { status: 'no-symbols' },
    actions: { planned: false, status: 'ok', eligible: 0, due: [], plan: {}, dueCount: 0, checked: [], failed: {}, splits: 0, dividends: 0 },
  };
}
