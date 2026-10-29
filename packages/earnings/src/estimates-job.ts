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
 * A `rate-limited` answer stops the job for as long as the kind of limit says (the rest of the UTC day for the daily
 * quota, 2 minutes for a burst, 15 minutes for any other notice, doubling with each repeat the same day up to the next UTC midnight): there is
 * no point asking again before. Steps are a minute apart and the client spaces its requests (`ProviderPacer`), since the provider also refuses
 * bursts. The provider's own words (sanitised, at most 300 characters) are kept with the outcome.
 *
 * A free key often cannot read `EARNINGS_ESTIMATES`: Alpha Vantage then answers with a "premium endpoint" notice or the generic limit text although the
 * key is nowhere near its limits. When that happens the step makes a control call of the free `EARNINGS` function (same ticker, 1.5 s later): if it works,
 * the endpoint is noted as `unavailable-on-key` (`ConsensusEndpoint`, retried after 7 days) and the control's figures are stored as EPS-only rows; if it is
 * refused too, it is a real throttle and the back-off above applies. While the endpoint is noted, every step is one `EARNINGS` call for the next symbol
 * (same order, budget, pacing and caps), storing the EPS estimate of each past quarter and nothing else (no range, no analyst count, no revenue).
 */
import { logger, type JobHandler, type JobPayloads } from '@portfolio/platform';
import { estimateTicker, resumeAtMs, sanitizeNotice, type AlphaVantageEstimatesClient, type EstimateBudget, type EstimatesAnswer } from '@portfolio/prices';
import { daysBetween, matchQuarter, ENDPOINT_RETRY_DAYS, EPS_ONLY_SOURCE, type ConsensusBlock, type ConsensusEndpoint, type ConsensusOutcome, type ConsensusQuarter, type ConsensusState, type EarningsHolding, type EarningsSummary } from '@portfolio/shared';
import { iso, loadHeld, type EarningsInputs } from './common.js';
import type { EarningsRepository } from './repository.js';
import { isSubrequestError } from './sec.js';
import { utcDayOf } from './util.js';

export type EstimatesPayload = JobPayloads['earningsEstimates'];

/** Calls one run makes at most (the day's own cap is the budget's). */
export const ESTIMATES_CALLS_PER_RUN = 3;
/** One call per step, the steps this far apart: Alpha Vantage refuses requests that come too fast. */
export const ESTIMATES_STEP_DELAY_MS = 60_000;
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
  client?: Pick<AlphaVantageEstimatesClient, 'fetchEstimates' | 'fetchEarnings'>;
  budget: Pick<EstimateBudget, 'room' | 'spend'>;
  now: () => Date;
}

export interface EstimatesResult {
  fetched: number;
  stored: number;
  skipped?: 'no-key' | 'blocked' | 'budget' | 'nothing-to-do';
  /** The answer that stopped the run, when one did. */
  stoppedBy?: 'premium' | 'rate-limited' | 'invalid-key';
  /** Set when this step found that the key cannot read `EARNINGS_ESTIMATES` (the free `EARNINGS` function is used for a week). */
  endpoint?: 'unavailable-on-key';
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

const coolingDown = (state: ConsensusState | null, now: Date): boolean => {
  if (state === null || state.outcome === 'ok') return false;
  // A limit names when it passes (`retryAt`); a record written before that was kept has the old half-day.
  if (state.outcome === 'rate-limited' && state.retryAt !== undefined) return Date.parse(state.retryAt) > now.getTime();
  return now.getTime() - Date.parse(state.at) < COOLDOWN_MS[state.outcome];
};

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
  /** Set once a step of the run noted the endpoint as unavailable. */
  endpoint?: 'unavailable-on-key';
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

const detailOf = (answer: Failure): string | undefined => {
  if (answer.status === 'error') return sanitizeNotice(answer.reason);
  return 'detail' in answer && answer.detail !== undefined ? sanitizeNotice(answer.detail) : undefined;
};

/** Refusals earlier the same UTC day, as the block remembers them: the back-off doubles with each. */
const strikesOf = (previous: ConsensusBlock | null, now: Date): number =>
  previous?.reason === 'rate-limited' && previous.at.slice(0, 10) === utcDayOf(now) ? (previous.strikes ?? 0) + 1 : 0;

/** The pause after a `rate-limited` answer: by the kind of limit (the rest of the UTC day, 2 minutes, or 15 minutes), doubling on repeats up to the next UTC midnight. */
async function limitBlock(deps: EstimatesJobDeps, answer: Extract<Failure, { status: 'rate-limited' }>, now: Date): Promise<ConsensusBlock> {
  const scope = answer.scope ?? 'other';
  const strikes = strikesOf(await deps.repo.getConsensusBlock(), now);
  const detail = detailOf(answer);
  return { until: iso(resumeAtMs(scope, now.getTime(), strikes)), reason: 'rate-limited', at: now.toISOString(), scope, strikes, ...(detail === undefined ? {} : { detail }) };
}

/** What a symbol's state becomes after an answer that gave no figures; figures stored earlier stay and keep their date. */
async function recordFailure(deps: EstimatesJobDeps, target: EstimateTarget, answer: Failure): Promise<void> {
  const now = deps.now();
  const previous = (await deps.repo.getConsensus(target.symbol)).state;
  const detail = detailOf(answer);
  const block = answer.status === 'rate-limited' ? await limitBlock(deps, answer, now) : undefined;
  const state: ConsensusState = {
    symbol: target.symbol,
    outcome: answer.status,
    at: now.toISOString(),
    ticker: target.ticker,
    ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
    ...(previous?.quarters === undefined ? {} : { quarters: previous.quarters }),
    ...(detail === undefined ? {} : { detail }),
    ...(block === undefined ? {} : { retryAt: block.until }),
    updatedAt: now.toISOString(),
  };
  await deps.repo.putConsensusState(state);
  if (block !== undefined) await deps.repo.putConsensusBlock(block);
  if (answer.status === 'premium') await deps.repo.putConsensusBlock({ until: iso(now.getTime() + PREMIUM_BLOCK_MS), reason: 'premium', at: state.at, ...(detail === undefined ? {} : { detail }) });
}

type Figures = Extract<EstimatesAnswer, { status: 'ok' }>;

async function recordFigures(deps: EstimatesJobDeps, target: EstimateTarget, answer: Figures): Promise<void> {
  const { symbol, ticker } = target;
  const at = deps.now().toISOString();
  const quarters: ConsensusQuarter[] = answer.quarters.map((quarter) => ({ symbol, ...quarter, ticker, fetchedAt: at }));
  await deps.repo.putConsensus(quarters, { symbol, outcome: 'ok', at, fetchedAt: at, ticker, quarters: quarters.length, updatedAt: at });
}

/**
 * The EPS-only rows of an `EARNINGS` answer, in the same keys as the consensus rows and flagged `source: 'eps-only'`. A quarter that already has a full
 * consensus row (from `EARNINGS_ESTIMATES`, back when the key could read it) is left as it is. An answer without any estimate is "no coverage".
 */
async function recordEpsOnly(deps: EstimatesJobDeps, target: EstimateTarget, answer: Figures): Promise<boolean> {
  if (answer.quarters.length === 0) {
    await recordFailure(deps, target, { status: 'no-coverage' });
    return false;
  }
  const { symbol, ticker } = target;
  const at = deps.now().toISOString();
  const full = new Set((await deps.repo.getConsensus(symbol)).quarters.filter((quarter) => quarter.source === undefined).map((quarter) => quarter.quarterEnd));
  const quarters: ConsensusQuarter[] = answer.quarters.filter((quarter) => !full.has(quarter.quarterEnd)).map((quarter) => ({ symbol, ...quarter, ticker, fetchedAt: at, source: EPS_ONLY_SOURCE }));
  await deps.repo.putConsensus(quarters, { symbol, outcome: 'ok', at, fetchedAt: at, ticker, quarters: quarters.length, source: EPS_ONLY_SOURCE, updatedAt: at });
  return true;
}

/** One provider call. A failure that is not the host's subrequest limit is an `error` answer (the host's limit is rethrown: the step is deferred). */
async function guarded(call: () => Promise<EstimatesAnswer>): Promise<EstimatesAnswer> {
  try {
    return await call();
  } catch (error) {
    if (isSubrequestError(error)) throw error;
    logger.warn('Fetching consensus estimates failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { status: 'error', reason: 'the request failed' };
  }
}

/** What a step did, for what follows: calls made, whether figures were stored, and the answer that makes further calls pointless. */
interface Asked {
  calls: number;
  stored: boolean;
  stopped?: EstimatesResult['stoppedBy'];
  /** The endpoint was noted as unavailable on the key in this step. */
  endpoint?: 'unavailable-on-key';
}

/** The answers that make further calls pointless: a limit, no estimates on this plan, or a key the provider refuses. */
function stoppedBy(answer: EstimatesAnswer): EstimatesResult['stoppedBy'] {
  if (answer.status === 'premium' || answer.status === 'rate-limited') return answer.status;
  return answer.status === 'error' && answer.invalidKey === true ? 'invalid-key' : undefined;
}

/** Records an answer that is not `EARNINGS_ESTIMATES` figures: the EPS-only rows of an `ok`, else the symbol's failure. */
async function recordEarnings(deps: EstimatesJobDeps, target: EstimateTarget, answer: EstimatesAnswer): Promise<Asked> {
  if (answer.status === 'ok') return { calls: 1, stored: await recordEpsOnly(deps, target, answer) };
  await recordFailure(deps, target, answer);
  return { calls: 1, stored: false, stopped: stoppedBy(answer) };
}

/** Whether one more provider call may be made now (and spends it). */
async function callAllowed(deps: EstimatesJobDeps): Promise<boolean> {
  return (await deps.budget.room()).allowed && (await deps.budget.spend());
}

/** The control call after a refusal: the free `EARNINGS` function for the same ticker, a second later (the client paces). `undefined` when the budget is spent or the host defers it. */
async function controlCall(deps: EstimatesJobDeps, target: EstimateTarget): Promise<EstimatesAnswer | undefined> {
  if (!(await callAllowed(deps))) return undefined;
  try {
    return await guarded(() => deps.client!.fetchEarnings(target.ticker));
  } catch {
    return undefined;
  }
}

/** Notes that `EARNINGS_ESTIMATES` is not readable with this key: it is asked again after a week. */
async function markUnavailable(deps: EstimatesJobDeps, answer: Extract<Failure, { status: 'premium' | 'rate-limited' }>): Promise<void> {
  const now = deps.now();
  const detail = detailOf(answer);
  await deps.repo.putConsensusEndpoint({ state: 'unavailable-on-key', at: now.toISOString(), retryAt: iso(now.getTime() + ENDPOINT_RETRY_DAYS * DAY_MS), ...(detail === undefined ? {} : { detail }) });
}

/** The estimates endpoint answered with a premium notice or generic limit text. */
const refused = (answer: EstimatesAnswer): answer is Extract<Failure, { status: 'premium' | 'rate-limited' }> =>
  answer.status === 'premium' || (answer.status === 'rate-limited' && (answer.scope ?? 'other') === 'other');

/**
 * `EARNINGS_ESTIMATES` was refused with a premium notice or generic limit text. A control call of `EARNINGS` (same key, same ticker) tells which it is: when
 * that one works, the key cannot read the estimates (noted for a week, and the control's figures are this symbol's EPS-only rows); when it is refused the same
 * way it is a real throttle and the symbol and the provider back off as for any limit. An explicit "premium endpoint" needs no proof.
 */
async function classify(deps: EstimatesJobDeps, target: EstimateTarget, answer: Extract<Failure, { status: 'premium' | 'rate-limited' }>): Promise<Asked> {
  const control = await controlCall(deps, target);
  const calls = control === undefined ? 1 : 2;
  if (answer.status === 'rate-limited' && control?.status !== 'ok') {
    await recordFailure(deps, target, answer);
    return { calls, stored: false, stopped: 'rate-limited' };
  }
  await markUnavailable(deps, answer);
  const stored = control?.status === 'ok' && (await recordEpsOnly(deps, target, control));
  return { calls, stored, endpoint: 'unavailable-on-key' };
}

/** A symbol's consensus from `EARNINGS_ESTIMATES`; a refusal is classified (see `classify`), and figures clear what was noted about the endpoint. */
async function askEstimates(deps: EstimatesJobDeps, target: EstimateTarget, endpoint: ConsensusEndpoint | null): Promise<Asked> {
  const answer = await guarded(() => deps.client!.fetchEstimates(target.ticker));
  if (answer.status === 'ok') {
    await recordFigures(deps, target, answer);
    if (endpoint !== null) await deps.repo.clearConsensusEndpoint();
    return { calls: 1, stored: true };
  }
  if (refused(answer)) return classify(deps, target, answer);
  await recordFailure(deps, target, answer);
  return { calls: 1, stored: false, stopped: stoppedBy(answer) };
}

/** While the endpoint is noted as unavailable (for a week), the symbol's EPS estimates come from `EARNINGS`; after it, `EARNINGS_ESTIMATES` is asked once more. */
const fallbackActive = (endpoint: ConsensusEndpoint | null, now: Date): endpoint is ConsensusEndpoint => endpoint !== null && Date.parse(endpoint.retryAt) > now.getTime();

/** Asks the provider about one symbol and records the answer. */
async function ask(deps: EstimatesJobDeps, target: EstimateTarget, endpoint: ConsensusEndpoint | null): Promise<Asked> {
  if (!fallbackActive(endpoint, deps.now())) return askEstimates(deps, target, endpoint);
  return recordEarnings(deps, target, await guarded(() => deps.client!.fetchEarnings(target.ticker)));
}

/** What follows a step: stop on a notice that makes further calls pointless, stop at the run's cap or the end of the queue, else the next symbol a minute later. */
function afterAnswer(run: Cursor, asked: Asked): Step {
  const endpoint = asked.endpoint ?? run.endpoint;
  const next: Cursor = { ...run, index: run.index + 1, fetched: run.fetched + asked.calls, stored: run.stored + (asked.stored ? 1 : 0), ...(endpoint === undefined ? {} : { endpoint }) };
  const result: EstimatesResult = { fetched: next.fetched, stored: next.stored, ...(endpoint === undefined ? {} : { endpoint }) };
  if (asked.stopped !== undefined) return finished({ ...result, stoppedBy: asked.stopped });
  if (next.fetched >= ESTIMATES_CALLS_PER_RUN || next.index >= next.queue.length) return finished(result);
  return { done: false, next: JSON.stringify(next), delayMs: ESTIMATES_STEP_DELAY_MS };
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
      const asked = await ask(deps, target, await deps.repo.getConsensusEndpoint());
      if (asked.stored && block !== null) await deps.repo.clearConsensusBlock();
      return afterAnswer(run, asked);
    } catch (error) {
      if (isSubrequestError(error)) return { done: false, next: JSON.stringify(run), delayMs: 1000 };
      throw error;
    }
  };
}

