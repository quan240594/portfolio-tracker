/**
 * The two live jobs of the feature.
 *
 * `watchEarnings` (cheap, scheduled): looks at the held symbols that may have just reported (see `selectCandidates`), makes at most one SEC
 * request per candidate and queues a `fetchEarningsSummary` for a new results release. `fetchEarningsSummary` reads one release with the
 * model, verifies it and stores the summary. Both are resumable and idempotent (deterministic keys), report every outcome as the
 * `lastRun` of the symbol (stage and reason, for the Earnings page), back off after failures, and never loop: SEC refusals (403, 429) stop
 * everything for a long while. The first quarters of every holding are the backfill job's work (`backfill.ts`).
 */
import { logger, type JobHandler, type JobPayloads } from '@portfolio/platform';
import { localDayAndHour, sequentially, type EarningsHolding, type EarningsSymbolState } from '@portfolio/shared';
import {
  activeBlock,
  announce,
  clearBlockHistory,
  describeFailure,
  failSymbol,
  iso,
  loadHeld,
  nextAllowanceReset,
  originFor,
  recordBlock,
  resolveCiks,
  runOf,
  type EarningsJobDeps,
} from './common.js';
import { processRelease, type ReleaseOutcome } from './pipeline.js';
import { SecBlockedError, SecError, isSubrequestError, resultsFilings, type SecFiling } from './sec.js';
import { MAX_ATTEMPTS_PER_DAY, MAX_FILING_AGE_DAYS, selectCandidates, type Candidate } from './select.js';
import { storeSummary } from './store.js';
import { addDays, utcDayOf } from './util.js';

export type WatchPayload = JobPayloads['watchEarnings'];
export type FetchPayload = JobPayloads['fetchEarningsSummary'];

/** Candidates looked at per step: one SEC request each (the step makes about a dozen subrequests). */
export const CHECKS_PER_STEP = 10;
const UNREADABLE_RETRY_MS = 6 * 3_600_000;
const MAX_UNREADABLE = 2;
const MAX_SEEN = 12;

export interface WatchResult {
  checked: number;
  queued: number;
  skipped?: 'not-configured' | 'sec-blocked' | 'nothing-to-do';
}

export interface FetchResult {
  stored: boolean;
  outcome: 'stored' | 'exists' | 'not-results' | 'unreadable' | 'ai-allowance' | 'ai-error' | 'failed' | 'blocked' | 'attempts' | 'not-held' | 'not-configured' | 'sec-blocked';
}

// --- watchEarnings --------------------------------------------------------------------------------------------------------

interface WatchCursor {
  candidates: Candidate[];
  index: number;
  checked: number;
  queued: number;
}

/** The newest results filing that is new for the symbol: later than what is stored, not seen before, young enough. */
export function newFiling(filings: readonly SecFiling[], state: EarningsSymbolState | undefined, latestReport: string | undefined, today: string): SecFiling | undefined {
  const youngest = addDays(today, -MAX_FILING_AGE_DAYS);
  const seen = new Set(state?.seenAccessions ?? []);
  return resultsFilings(filings).find(
    (filing) => filing.filingDate >= youngest && !seen.has(filing.accession) && filing.accession !== state?.lastAccession && (latestReport === undefined || filing.reportDate > latestReport),
  );
}

interface CheckContext {
  deps: EarningsJobDeps;
  today: string;
  holdings: ReadonlyMap<string, EarningsHolding>;
}

async function checkSymbol(context: CheckContext, candidate: Candidate): Promise<'queued' | 'looked' | 'skipped'> {
  const { deps, today } = context;
  const { repo, sec } = deps;
  const now = deps.now();
  const state = await repo.getState(candidate.symbol);
  if (state?.cik === undefined || sec === undefined) return 'skipped';
  const utcDay = utcDayOf(now);
  const checks = (state.checksDay === utcDay ? (state.checks ?? 0) : 0) + 1;
  const filings = await sec.submissions(state.cik);
  const latest = (await repo.latest(candidate.symbol, 1))[0]?.reportDate;
  const filing = newFiling(filings, state, latest, today);
  const base: Partial<EarningsSymbolState> = { lastCheckedAt: now.toISOString(), checksDay: utcDay, checks, failures: 0, retryAfter: undefined, lastReason: undefined };
  if (filing === undefined) {
    const run = latest === undefined ? runOf(now, 'no-release-found', `no results release in the last ${MAX_FILING_AGE_DAYS} days`) : runOf(now, 'ok', 'nothing newer than the stored release');
    await repo.patchState(candidate.symbol, { ...base, lastResult: 'no-filing', lastRun: run }, now);
    return 'looked';
  }
  const origin = originFor(filing.reportDate, now, candidate.mode !== 'discovery' || latest !== undefined ? 'live' : 'by-age');
  await deps.queue.enqueue({
    job: 'fetchEarningsSummary',
    payload: { symbol: candidate.symbol, cik: state.cik, accession: filing.accession, form: filing.form as '8-K' | '6-K', filingDate: filing.reportDate, primaryDocument: filing.primaryDocument, origin },
  });
  const run = runOf(now, 'select-filing', 'found a results release, reading it', { filing });
  await repo.patchState(candidate.symbol, { ...base, lastResult: 'ok', lastRun: run, pendingAccession: filing.accession, pendingAt: now.toISOString() }, now);
  return 'queued';
}

async function startWatch(deps: EarningsJobDeps, payload: WatchPayload): Promise<{ cursor: WatchCursor; holdings: Map<string, EarningsHolding> }> {
  const now = deps.now();
  const held = await loadHeld(deps, payload.trigger === 'manual');
  const holdings = new Map(held.holdings.map((holding) => [holding.symbol, holding]));
  const symbols = held.holdings.map((holding) => holding.symbol);
  const [states, latest] = await Promise.all([deps.repo.getStates(symbols), Promise.all(symbols.map((symbol) => deps.repo.latest(symbol, 1)))]);
  const latestReport = new Map(symbols.flatMap((symbol, index) => (latest[index]![0] === undefined ? [] : [[symbol, latest[index]![0].reportDate] as [string, string]])));
  const candidates = selectCandidates({ now, today: localDayAndHour(now).day, holdings: held.holdings, states, latestReport, calendar: held.calendar, manualSymbol: payload.trigger === 'manual' ? payload.symbol : undefined });
  await resolveCiks(deps, candidates.map((candidate) => candidate.symbol), states, holdings);
  return { cursor: { candidates, index: 0, checked: 0, queued: 0 }, holdings };
}

async function resumeWatch(deps: EarningsJobDeps, cursor: string): Promise<{ cursor: WatchCursor; holdings: Map<string, EarningsHolding> }> {
  const held = await loadHeld(deps);
  return { cursor: JSON.parse(cursor) as WatchCursor, holdings: new Map(held.holdings.map((holding) => [holding.symbol, holding])) };
}

/** `watchEarnings`: see the module comment. A step looks at up to ten candidates and the job continues until all were looked at. */
export function createWatchEarningsJob(getDeps: () => EarningsJobDeps): JobHandler<WatchPayload, WatchResult> {
  return async ({ payload, cursor }) => {
    const deps = getDeps();
    const now = deps.now();
    if (deps.sec === undefined || deps.extractor === undefined) return { done: true, result: { checked: 0, queued: 0, skipped: 'not-configured' } };
    if ((await activeBlock(deps.repo, now)) !== undefined) return { done: true, result: { checked: 0, queued: 0, skipped: 'sec-blocked' } };
    try {
      const { cursor: state, holdings } = cursor === undefined ? await startWatch(deps, payload) : await resumeWatch(deps, cursor);
      const step = state.candidates.slice(state.index, state.index + CHECKS_PER_STEP);
      const context: CheckContext = { deps, today: localDayAndHour(now).day, holdings };
      let { checked, queued } = state;
      // One symbol after the other on purpose: every check calls the SEC, whose fair-access limit the shared token bucket enforces.
      const check = (candidate: Candidate) => checkSymbol(context, candidate).catch((error: unknown) => failedCheck(deps, candidate, error));
      for await (const outcome of sequentially(step, check)) {
        if (outcome === 'queued') queued += 1;
        if (outcome !== 'skipped') checked += 1;
      }
      if (checked > state.checked) await clearBlockHistory(deps.repo, deps.now());
      const index = state.index + step.length;
      if (index < state.candidates.length) return { done: false, next: JSON.stringify({ ...state, index, checked, queued } satisfies WatchCursor), delayMs: 1000 };
      return { done: true, result: { checked, queued, ...(state.candidates.length === 0 ? { skipped: 'nothing-to-do' as const } : {}) } };
    } catch (error) {
      if (error instanceof SecBlockedError) {
        await recordBlock(deps.repo, error, deps.now());
        return { done: true, result: { checked: 0, queued: 0, skipped: 'sec-blocked' } };
      }
      throw error;
    }
  };
}

/** One candidate failed: a SEC refusal ends the job (rethrown), the host's subrequest limit too; anything else is that symbol's failure with a back-off. */
async function failedCheck(deps: EarningsJobDeps, candidate: Candidate, error: unknown): Promise<'skipped'> {
  if (error instanceof SecBlockedError || isSubrequestError(error)) throw error;
  logger.warn('Earnings check failed', { error: error instanceof Error ? error.name : 'unknown' });
  const detail = error instanceof SecError ? error.message : 'the check failed';
  await failSymbol(deps, candidate.symbol, runOf(deps.now(), 'submissions', detail));
  return 'skipped';
}

// --- fetchEarningsSummary --------------------------------------------------------------------------------------------------

const done = (outcome: FetchResult['outcome'], stored = false): { done: true; result: FetchResult } => ({ done: true, result: { stored, outcome } });

async function giveUp(deps: EarningsJobDeps, payload: FetchPayload, state: EarningsSymbolState | null, patch: Partial<EarningsSymbolState>): Promise<void> {
  const seen = [...(state?.seenAccessions ?? []), payload.accession].slice(-MAX_SEEN);
  await deps.repo.patchState(payload.symbol, { ...patch, seenAccessions: seen, pendingAccession: undefined, pendingAt: undefined, backfillDone: true }, deps.now());
}

const filingOf = (payload: FetchPayload) => ({ form: payload.form, reportDate: payload.filingDate, accession: payload.accession });

/** `fetchEarningsSummary`: read, extract, verify and store one release. One step; the host's guard runs it only below 60 % of the budget. */
export function createFetchEarningsSummaryJob(getDeps: () => EarningsJobDeps): JobHandler<FetchPayload, FetchResult> {
  return async ({ payload }) => {
    const deps = getDeps();
    const now = deps.now();
    if (deps.sec === undefined || deps.extractor === undefined) return done('not-configured');
    if ((await activeBlock(deps.repo, now)) !== undefined) return done('sec-blocked');
    const state = await deps.repo.getState(payload.symbol);
    const utcDay = utcDayOf(now);
    const attempts = state?.attemptsDay === utcDay ? (state.attempts ?? 0) : 0;
    if (attempts >= MAX_ATTEMPTS_PER_DAY) return done('attempts');
    const existing = await deps.repo.getSummary(payload.symbol, payload.filingDate);
    if (existing?.accession === payload.accession) {
      await deps.repo.patchState(payload.symbol, { pendingAccession: undefined, pendingAt: undefined, backfillDone: true, lastRun: runOf(now, 'ok', 'already stored', { filing: filingOf(payload) }) }, now);
      return done('exists');
    }
    const holding = (await loadHeld(deps)).holdings.find((candidate) => candidate.symbol === payload.symbol);
    if (holding === undefined) return done('not-held');
    const counted: Partial<EarningsSymbolState> = { attemptsDay: utcDay, attempts: attempts + 1, lastCheckedAt: now.toISOString() };
    try {
      const previous = (await deps.repo.latest(payload.symbol, 3)).find((summary) => summary.reportDate < payload.filingDate);
      const outcome = await processRelease(
        { sec: deps.sec, extractor: deps.extractor, estimates: deps.estimates, now: deps.now },
        { symbol: payload.symbol, cik: payload.cik, accession: payload.accession, form: payload.form, reportDate: payload.filingDate, primaryDocument: payload.primaryDocument, origin: payload.origin },
        holding,
        previous,
      );
      return await settle(deps, payload, state, counted, outcome);
    } catch (error) {
      if (error instanceof SecBlockedError) {
        await recordBlock(deps.repo, error, deps.now());
        await deps.repo.patchState(payload.symbol, { lastRun: runOf(deps.now(), 'sec-blocked', `blocked by the SEC (HTTP ${error.status})`, { filing: filingOf(payload) }) }, deps.now());
        return done('blocked');
      }
      if (isSubrequestError(error)) return { done: false, next: 'retry', delayMs: 1000 };
      logger.warn('Reading an earnings release failed', { error: error instanceof Error ? error.name : 'unknown' });
      await failSymbol(deps, payload.symbol, runOf(deps.now(), 'text', describeFailure(error), { filing: filingOf(payload) }));
      return done('failed');
    }
  };
}

async function settle(deps: EarningsJobDeps, payload: FetchPayload, state: EarningsSymbolState | null, counted: Partial<EarningsSymbolState>, outcome: ReleaseOutcome): Promise<{ done: true; result: FetchResult }> {
  const now = deps.now();
  const { repo } = deps;
  const filing = filingOf(payload);
  const clear = { pendingAccession: undefined, pendingAt: undefined, failures: 0, retryAfter: undefined, lastReason: undefined };
  switch (outcome.status) {
    case 'stored': {
      await storeSummary(repo, outcome.summary);
      const run = runOf(now, 'ok', 'summary stored', { filing, dropped: outcome.dropped, neurons: outcome.neurons });
      await repo.patchState(payload.symbol, { ...counted, ...clear, lastResult: 'ok', lastRun: run, lastSuccessAt: now.toISOString(), lastAccession: payload.accession, backfillDone: true, unreadableCount: undefined }, now);
      if (payload.origin === 'live') await announce(deps);
      return done('stored', true);
    }
    case 'not-results':
      await giveUp(deps, payload, state, { ...counted, ...clear, lastResult: 'no-filing', lastRun: runOf(now, outcome.stage, outcome.detail, { filing }) });
      return done('not-results');
    case 'unreadable': {
      const count = (state?.unreadableCount ?? 0) + 1;
      const patch = { ...counted, ...clear, lastResult: 'unreadable' as const, lastReason: outcome.reason, lastRun: runOf(now, outcome.stage, outcome.detail, { filing, dropped: outcome.dropped, neurons: outcome.neurons }), unreadableCount: count };
      if (count >= MAX_UNREADABLE) await giveUp(deps, payload, state, patch);
      else await repo.patchState(payload.symbol, { ...patch, pendingAccession: undefined, retryAfter: iso(now.getTime() + UNREADABLE_RETRY_MS) }, now);
      return done('unreadable');
    }
    case 'ai-allowance':
      await repo.patchState(
        payload.symbol,
        {
          pendingAccession: undefined,
          pendingAt: undefined,
          lastCheckedAt: now.toISOString(),
          lastResult: 'ai-allowance',
          lastReason: 'The Workers AI allowance of today is used up',
          lastRun: runOf(now, 'budget', 'the daily AI allowance is used up, it resumes after 00:00 UTC', { filing, neurons: outcome.neurons }),
          retryAfter: nextAllowanceReset(now),
        },
        now,
      );
      return done('ai-allowance');
    case 'sec-error':
      await failSymbol(deps, payload.symbol, runOf(now, outcome.stage, outcome.detail, { filing }), { ...counted, pendingAccession: undefined, pendingAt: undefined });
      return done('failed');
    default:
      await failSymbol(deps, payload.symbol, runOf(now, 'ai', `model error: ${outcome.detail}`, { filing, neurons: outcome.neurons }), { ...counted, pendingAccession: undefined, pendingAt: undefined });
      return done('ai-error');
  }
}

