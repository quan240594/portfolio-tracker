import { MAX_RUN_SYMBOLS, sanitizeAttemptError, type EarningsCompanyCheck, type EarningsSourceRun, type StoredEarningsEvent } from '@portfolio/shared';
import type { EarningsFetchReport } from '@portfolio/platform';
import { z } from 'zod';
import { errorMessage, errorName, RateLimitError } from '../errors.js';
import { byText, definedOnly, isRecord } from '../parse.js';
import { FINNHUB_PACE_MS, FinnhubPacingError, FinnhubRefusedError, finnhubTargets, type FinnhubAnswer, type FinnhubEarnings } from '../providers/finnhub.js';
import { addDays } from '../time.js';
import { rethrowBudget, runUnits, type StepContext } from './common.js';

/** The report of a source: its dates and, where it says, the counts of its answer. */
export type Calendar = Partial<EarningsFetchReport> & Pick<EarningsFetchReport, 'events'>;

/** What one source did: its entry in the run record and what it listed. */
export interface SourceOutcome {
  run: EarningsSourceRun;
  report?: Calendar;
  /** Class of the error that ended the attempt. */
  failure?: string;
}

/** A company reporting within this many days is asked about in every run, before the others. */
export const IMMINENT_DAYS = 7;

const checkSchema = z.object({
  symbol: z.string(),
  result: z.enum(['date', 'none', 'failed', 'rate-limited', 'refused', 'pending']),
  date: z.string().optional(),
  reason: z.string().optional(),
});

const isEvent = (value: unknown): value is StoredEarningsEvent => isRecord(value) && typeof value.symbol === 'string' && typeof value.date === 'string';

/** The progress of the per-company Finnhub reads between job steps (it lives in the job's cursor). */
export const finnhubRunSchema = z.object({
  /** Finnhub tickers still to ask, with the app symbols each stands for; the first is next. */
  queue: z.array(z.object({ ticker: z.string(), symbols: z.array(z.string()) })),
  /** Companies done (or left for the next run), in the order they were asked. */
  checks: z.array(checkSchema),
  events: z.array(z.custom<StoredEarningsEvent>(isEvent)),
  rows: z.number(),
  /** Why the queue ended early: the key was refused, a limit was reached, or the day's calls are used. */
  stopped: z.enum(['refused', 'rate-limited', 'budget-exhausted']).optional(),
  /** The last error, sanitized, and its class. */
  reason: z.string().optional(),
  failure: z.string().optional(),
});

export type FinnhubRun = z.infer<typeof finnhubRunSchema>;

interface Candidate {
  ticker: string;
  symbols: string[];
  imminent: boolean;
  checked: string;
}

/**
 * The companies to ask Finnhub about, in order: those reporting within a week first (every run), then the ones asked least recently (never asked
 * first), so that every held company is refreshed in turn whatever the day's allowance. Only `limit` of them are queued; the others are left as
 * `pending` for the next run.
 */
export async function planFinnhub(ctx: StepContext, symbols: readonly string[], today: string, limit: number): Promise<FinnhubRun> {
  const targets = finnhubTargets(symbols);
  const covered = [...targets.values()].flatMap((group) => group.map((target) => target.symbol));
  const [ahead, states] = await Promise.all([ctx.repo.upcomingEarnings(covered, today), ctx.repo.getStates(covered)]);
  const soon = addDays(today, IMMINENT_DAYS);
  const candidates = [...targets].map(([ticker, group]): Candidate => {
    const names = group.map((target) => target.symbol);
    return {
      ticker,
      symbols: names,
      imminent: names.some((name) => (ahead.get(name) ?? []).some((event) => event.date <= soon)),
      checked: names.map((name) => states.get(name)?.finnhubCheckedAt ?? '').toSorted(byText)[0]!,
    };
  });
  const ordered = candidates.toSorted((a, b) => Number(b.imminent) - Number(a.imminent) || byText(a.checked, b.checked) || byText(a.ticker, b.ticker));
  const asked = ordered.slice(0, limit);
  const later = ordered.slice(limit);
  return {
    queue: asked.map(({ ticker, symbols: names }) => ({ ticker, symbols: names })),
    checks: later.flatMap((entry) => entry.symbols.map((symbol): EarningsCompanyCheck => ({ symbol, result: 'pending' }))),
    events: [],
    rows: 0,
  };
}

/** Ends the queue: the companies that were not reached stay `pending`. */
function stopQueue(run: FinnhubRun, stopped: NonNullable<FinnhubRun['stopped']>): void {
  run.stopped = stopped;
  for (const entry of run.queue.splice(0)) for (const symbol of entry.symbols) run.checks.push({ symbol, result: 'pending' });
}

const reasonOf = (error: unknown): string => sanitizeAttemptError(errorMessage(error)) || errorName(error);

/** The failure of the company at the head of the queue: a refused key or a limit ends the run, anything else costs that company only. */
function failHead(run: FinnhubRun, error: unknown): void {
  const entry = run.queue.shift()!;
  const reason = reasonOf(error);
  run.reason = reason;
  run.failure = errorName(error);
  let result: 'failed' | 'rate-limited' | 'refused' = 'failed';
  if (error instanceof FinnhubRefusedError) result = 'refused';
  else if (error instanceof RateLimitError) result = 'rate-limited';
  for (const symbol of entry.symbols) run.checks.push({ symbol, result, reason });
  if (result !== 'failed') stopQueue(run, result);
}

function answerHead(run: FinnhubRun, answer: FinnhubAnswer): string[] {
  const entry = run.queue.shift()!;
  run.rows += answer.rows;
  run.events.push(...answer.events);
  for (const symbol of entry.symbols) run.checks.push({ symbol, result: answer.upcoming === undefined ? 'none' : 'date', ...(answer.upcoming === undefined ? {} : { date: answer.upcoming }) });
  return entry.symbols;
}

export interface FinnhubStepSettings {
  today: string;
  /** The run's stamp: it pays each call of the budget once, however often a step is delivered. */
  stamp: string;
  /** Calls the calendar may make a day. */
  limit: number;
}

/**
 * One call: the company at the head of the queue. Returns the milliseconds the next step should wait (the pace between calls, or until the
 * minute's calls are free again), 0 when the queue has ended.
 */
export async function readNextFinnhub(ctx: StepContext, run: FinnhubRun, source: FinnhubEarnings, settings: FinnhubStepSettings): Promise<number> {
  const { today, stamp, limit } = settings;
  const head = run.queue[0]!;
  if (!(await ctx.repo.consumeBudget(source.name, today, 1, limit, `${stamp}#earnings-finnhub#${head.ticker}`))) {
    ctx.logger.info('earnings refresh skipped: daily budget used', { provider: source.name });
    stopQueue(run, 'budget-exhausted');
    return 0;
  }
  try {
    const answer = await source.fetchCompany(head.ticker, head.symbols.map((symbol) => ({ symbol })), today);
    await runUnits(answerHead(run, answer), (symbol) => ctx.repo.putState(symbol, { finnhubCheckedAt: stamp }));
  } catch (error) {
    if (error instanceof FinnhubPacingError) return error.delayMs;
    rethrowBudget(error);
    ctx.logger.warn('earnings refresh failed', { provider: source.name, ticker: head.ticker, error: errorMessage(error) });
    failHead(run, error);
  }
  return run.stopped === undefined && run.queue.length > 0 ? FINNHUB_PACE_MS : 0;
}

/** How the source's run ended, from the companies it was asked about. */
function statusOf(run: FinnhubRun): EarningsSourceRun['status'] {
  if (run.stopped === 'refused' || run.stopped === 'rate-limited') return run.stopped;
  const answered = run.checks.some((check) => check.result === 'date' || check.result === 'none');
  if (answered) return 'ok';
  if (run.stopped === 'budget-exhausted') return 'budget-exhausted';
  return run.checks.some((check) => check.result === 'failed') ? 'failed' : 'ok';
}

/** The source's entry in the run record, and its dates for the merge. */
export function finnhubOutcome(run: FinnhubRun): SourceOutcome {
  const status = statusOf(run);
  const matched = [...new Set(run.events.map((event) => event.symbol))].toSorted(byText);
  const checks = run.checks.slice(0, MAX_RUN_SYMBOLS);
  const entry = definedOnly<EarningsSourceRun>({
    source: 'finnhub',
    status,
    reason: run.reason ?? '',
    rows: run.rows,
    events: run.events.length,
    matchedSymbols: matched.slice(0, MAX_RUN_SYMBOLS),
    companies: run.checks.length,
    withDate: run.checks.filter((check) => check.result === 'date').length,
    checks,
  });
  const report: Calendar = { events: run.events, rows: run.rows, listed: matched, unvouched: [] };
  const failed = status === 'failed' || status === 'rate-limited' || status === 'refused';
  return definedOnly<SourceOutcome>({ run: entry, report, failure: failed ? run.failure : undefined });
}

/** App symbols Finnhub gave an upcoming date for: the dates it is trusted to know for these symbols may replace stored ones. */
export const datedSymbols = (run: FinnhubRun): Set<string> => new Set(run.checks.filter((check) => check.result === 'date').map((check) => check.symbol));
