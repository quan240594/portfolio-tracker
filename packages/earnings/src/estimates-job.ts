/**
 * The `earningsEstimates` job: the analyst consensus (EPS and revenue per fiscal quarter) of the held companies, from Alpha Vantage.
 *
 * It costs calls of the provider's 25 a day, shared with the profile enrichment and the earnings calendar, so it is frugal by construction:
 * at most 8 calls a day of its own and none when fewer than 5 of the provider's calls are left (`EstimateBudget`), at most three calls per
 * run, one symbol per step (one outbound request per step). Who is asked first, in this order:
 *   0. a company whose newest stored summary has no consensus stored (the card would say "no estimate available"),
 *   1. a company about to report (a calendar date within 3 days) or that reported a live release since its last fetch,
 *   2. the stalest: a company is refreshed at most every 14 days otherwise.
 * Every attempt leaves its outcome on the symbol (`ok`, `no-coverage`, `premium`, `rate-limited`, `error`) so the page says why a figure is missing.
 * A `premium` or `rate-limited` answer also stops the job (for a week, or until the next UTC day): there is no point asking again.
 */
import { logger, type JobHandler, type JobPayloads } from '@portfolio/platform';
import { estimateTicker, type AlphaVantageEstimatesClient, type EstimateBudget, type EstimatesAnswer } from '@portfolio/prices';
import { daysBetween, matchQuarter, type ConsensusOutcome, type ConsensusQuarter, type ConsensusState, type EarningsHolding, type EarningsSummary } from '@portfolio/shared';
import { iso, loadHeld, nextAllowanceReset, sanitizeDetail, type EarningsInputs } from './common.js';
import type { EarningsRepository } from './repository.js';
import { isSubrequestError } from './sec.js';
import { utcDayOf } from './util.js';

export type EstimatesPayload = JobPayloads['earningsEstimates'];

/** Calls one run makes at most (the day's own cap is the budget's). */
export const ESTIMATES_CALLS_PER_RUN = 3;
/** A company is refreshed at most this often, apart from the cases below. */
export const ESTIMATES_REFRESH_DAYS = 14;
/** A company is "about to report" or "just reported" within this many days of a calendar date. */
export const ESTIMATES_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;
const PREMIUM_BLOCK_MS = 7 * DAY_MS;
const NO_MATCH_RETRY_MS = 3 * DAY_MS;

/** How long after an attempt that did not give figures the symbol is left alone. */
const COOLDOWN_MS: Readonly<Record<Exclude<ConsensusOutcome, 'ok'>, number>> = {
  error: 6 * 3_600_000,
  'rate-limited': 12 * 3_600_000,
  premium: 7 * DAY_MS,
  'no-coverage': 30 * DAY_MS,
};

export interface EstimatesJobDeps {
  repo: EarningsRepository;
  inputs: EarningsInputs;
  /** Absent without the optional Alpha Vantage key: the job then finishes at once. */
  client?: Pick<AlphaVantageEstimatesClient, 'fetchEstimates'>;
  budget: Pick<EstimateBudget, 'room' | 'spend'>;
  now: () => Date;
}

export interface EstimatesResult {
  fetched: number;
  stored: number;
  skipped?: 'no-key' | 'blocked' | 'budget' | 'nothing-to-do';
  /** The answer that stopped the run, when one did. */
  stoppedBy?: 'premium' | 'rate-limited';
}

// --- Who is asked, in which order ----------------------------------------------------------------------------------------

export interface EstimateSubject {
  symbol: string;
  state: ConsensusState | null;
  quarters: readonly ConsensusQuarter[];
  /** The newest stored summary of the symbol. */
  latest?: EarningsSummary;
  /** The calendar's expected report dates of the symbol. */
  dates: readonly string[];
}

const coolingDown = (state: ConsensusState | null, now: Date): boolean => state !== null && state.outcome !== 'ok' && now.getTime() - Date.parse(state.at) < COOLDOWN_MS[state.outcome];

/** The fetched figures are older than the newest live release: the next quarter's estimates have moved on. */
const afterRelease = (latest: EarningsSummary | undefined, fetchedAt: string): boolean => latest?.origin === 'live' && latest.generatedAt.localeCompare(fetchedAt) > 0;

const nearDate = (dates: readonly string[], today: string): boolean => dates.some((date) => Math.abs(daysBetween(today, date)) <= ESTIMATES_WINDOW_DAYS);

/** 0 (newest summary has no consensus), 1 (about to report or just reported), 2 (stale or never fetched); `undefined` when the symbol is not due. */
export function estimateTier(subject: EstimateSubject, now: Date): 0 | 1 | 2 | undefined {
  const { state, latest } = subject;
  if (coolingDown(state, now)) return undefined;
  if (latest !== undefined && matchQuarter(latest, subject.quarters) === undefined) {
    return state?.outcome === 'ok' && now.getTime() - Date.parse(state.at) < NO_MATCH_RETRY_MS ? undefined : 0;
  }
  const fetchedAt = state?.fetchedAt;
  if (fetchedAt === undefined) return 2;
  const age = daysBetween(fetchedAt.slice(0, 10), utcDayOf(now));
  if (afterRelease(latest, fetchedAt) || (nearDate(subject.dates, utcDayOf(now)) && age >= ESTIMATES_WINDOW_DAYS)) return 1;
  return age >= ESTIMATES_REFRESH_DAYS ? 2 : undefined;
}

export interface EstimateTarget {
  symbol: string;
  /** The provider's ticker of the symbol. */
  ticker: string;
}

export interface EstimatePlan {
  /** Who to ask the provider about, in order. */
  calls: EstimateTarget[];
  /** Symbols with no provider ticker (a listing without a US alias): recorded as "no coverage" without a call. */
  unmapped: string[];
}

/** The due symbols: by tier, then the one attempted longest ago (never first), then by name. */
export function planEstimates(subjects: readonly EstimateSubject[], now: Date): EstimatePlan {
  const due = subjects.flatMap((subject) => {
    const tier = estimateTier(subject, now);
    return tier === undefined ? [] : [{ subject, tier }];
  });
  const ordered = due.toSorted((a, b) => a.tier - b.tier || (a.subject.state?.at ?? '').localeCompare(b.subject.state?.at ?? '') || a.subject.symbol.localeCompare(b.subject.symbol));
  const plan: EstimatePlan = { calls: [], unmapped: [] };
  for (const { subject } of ordered) {
    const resolved = estimateTicker(subject.symbol);
    if (resolved === null) plan.unmapped.push(subject.symbol);
    else plan.calls.push({ symbol: subject.symbol, ticker: resolved.ticker });
  }
  return plan;
}

// --- The job -------------------------------------------------------------------------------------------------------------

interface Cursor {
  queue: EstimateTarget[];
  index: number;
  fetched: number;
  stored: number;
}

type Step = { done: true; result: EstimatesResult } | { done: false; next: string; delayMs: number };

const finished = (result: EstimatesResult): Step => ({ done: true, result });

async function subjectsOf(deps: EstimatesJobDeps, holdings: readonly EarningsHolding[], calendar: Readonly<Record<string, string[]>>): Promise<EstimateSubject[]> {
  return Promise.all(
    holdings.map(async ({ symbol }) => {
      const [consensus, latest] = await Promise.all([deps.repo.getConsensus(symbol), deps.repo.latest(symbol, 1)]);
      return { symbol, state: consensus.state, quarters: consensus.quarters, ...(latest[0] === undefined ? {} : { latest: latest[0] }), dates: calendar[symbol] ?? [] };
    }),
  );
}

async function recordUnmapped(deps: EstimatesJobDeps, symbols: readonly string[]): Promise<void> {
  const at = deps.now().toISOString();
  await Promise.all(symbols.map((symbol) => deps.repo.putConsensusState({ symbol, outcome: 'no-coverage', at, detail: 'no US ticker is known for this listing', updatedAt: at })));
}

async function startRun(deps: EstimatesJobDeps): Promise<Cursor> {
  const held = await loadHeld(deps);
  const plan = planEstimates(await subjectsOf(deps, held.holdings, held.calendar), deps.now());
  await recordUnmapped(deps, plan.unmapped);
  return { queue: plan.calls, index: 0, fetched: 0, stored: 0 };
}

type Failure = Exclude<EstimatesAnswer, { status: 'ok' }>;

/** What a symbol's state becomes after an answer that gave no figures; figures stored earlier stay and keep their date. */
async function recordFailure(deps: EstimatesJobDeps, target: EstimateTarget, answer: Failure): Promise<void> {
  const now = deps.now();
  const previous = (await deps.repo.getConsensus(target.symbol)).state;
  const detail = answer.status === 'error' ? sanitizeDetail(answer.reason) : undefined;
  const state: ConsensusState = {
    symbol: target.symbol,
    outcome: answer.status,
    at: now.toISOString(),
    ticker: target.ticker,
    ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
    ...(previous?.quarters === undefined ? {} : { quarters: previous.quarters }),
    ...(detail === undefined ? {} : { detail }),
    updatedAt: now.toISOString(),
  };
  await deps.repo.putConsensusState(state);
  if (answer.status === 'premium') await deps.repo.putConsensusBlock({ until: iso(now.getTime() + PREMIUM_BLOCK_MS), reason: 'premium', at: state.at });
  if (answer.status === 'rate-limited') await deps.repo.putConsensusBlock({ until: nextAllowanceReset(now), reason: 'rate-limited', at: state.at });
}

async function recordFigures(deps: EstimatesJobDeps, target: EstimateTarget, answer: Extract<EstimatesAnswer, { status: 'ok' }>): Promise<void> {
  const { symbol, ticker } = target;
  const at = deps.now().toISOString();
  const quarters: ConsensusQuarter[] = answer.quarters.map((quarter) => ({ symbol, ...quarter, ticker, fetchedAt: at }));
  await deps.repo.putConsensus(quarters, { symbol, outcome: 'ok', at, fetchedAt: at, ticker, quarters: quarters.length, updatedAt: at });
}

/** Asks the provider about one symbol and records the answer. A failure that is not the host's subrequest limit is that symbol's `error`. */
async function ask(deps: EstimatesJobDeps, target: EstimateTarget): Promise<EstimatesAnswer['status']> {
  let answer: EstimatesAnswer;
  try {
    answer = await deps.client!.fetchEstimates(target.ticker);
  } catch (error) {
    if (isSubrequestError(error)) throw error;
    logger.warn('Fetching consensus estimates failed', { error: error instanceof Error ? error.name : 'unknown' });
    answer = { status: 'error', reason: 'the request failed' };
  }
  if (answer.status === 'ok') await recordFigures(deps, target, answer);
  else await recordFailure(deps, target, answer);
  return answer.status;
}

const stoppedBy = (status: EstimatesAnswer['status']): EstimatesResult['stoppedBy'] => (status === 'premium' || status === 'rate-limited' ? status : undefined);

/** What follows an answer: stop on a notice that makes further calls pointless, stop at the run's cap or the end of the queue, else the next symbol. */
function afterAnswer(run: Cursor, status: EstimatesAnswer['status']): Step {
  const next: Cursor = { ...run, index: run.index + 1, fetched: run.fetched + 1, stored: run.stored + (status === 'ok' ? 1 : 0) };
  const stopped = stoppedBy(status);
  if (stopped !== undefined) return finished({ fetched: next.fetched, stored: next.stored, stoppedBy: stopped });
  if (next.fetched >= ESTIMATES_CALLS_PER_RUN || next.index >= next.queue.length) return finished({ fetched: next.fetched, stored: next.stored });
  return { done: false, next: JSON.stringify(next), delayMs: 1000 };
}

/** `earningsEstimates`: see the module comment. One symbol per step; the host's guard runs it only below 60 % of the budget. */
export function createEarningsEstimatesJob(getDeps: () => EstimatesJobDeps): JobHandler<EstimatesPayload, EstimatesResult> {
  return async ({ cursor }) => {
    const deps = getDeps();
    if (deps.client === undefined) return finished({ fetched: 0, stored: 0, skipped: 'no-key' });
    const block = await deps.repo.getConsensusBlock();
    if (block !== null && Date.parse(block.until) > deps.now().getTime()) return finished({ fetched: 0, stored: 0, skipped: 'blocked' });
    const run = cursor === undefined ? await startRun(deps) : (JSON.parse(cursor) as Cursor);
    const target = run.queue[run.index];
    if (target === undefined) return finished({ fetched: run.fetched, stored: run.stored, ...(run.fetched === 0 ? { skipped: 'nothing-to-do' as const } : {}) });
    if (!(await deps.budget.room()).allowed || !(await deps.budget.spend())) return finished({ fetched: run.fetched, stored: run.stored, skipped: 'budget' });
    try {
      return afterAnswer(run, await ask(deps, target));
    } catch (error) {
      if (isSubrequestError(error)) return { done: false, next: JSON.stringify(run), delayMs: 1000 };
      throw error;
    }
  };
}

