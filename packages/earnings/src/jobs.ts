/**
 * The two jobs of the feature.
 *
 * `watchEarnings` (cheap, scheduled): looks at the held symbols that may have just reported (see `selectCandidates`), makes at most one SEC
 * request per candidate and queues a `fetchEarningsSummary` for a new results release. `fetchEarningsSummary` reads one release with the
 * model, verifies it and stores the summary. Both are resumable and idempotent (deterministic keys), report every failure as a state of
 * the symbol with a back-off, and never loop: SEC refusals (403, 429) stop everything for a long while.
 */
import { logger, type JobHandler, type JobPayloads, type JobQueue } from '@portfolio/platform';
import { localDayAndHour, sequentially, type EarningsHeldCache, type EarningsHolding, type EarningsSecBlock, type EarningsSummary, type EarningsSymbolState } from '@portfolio/shared';
import type { TextExtractor } from './ai.js';
import type { EarningsConfig } from './config.js';
import type { EstimateSource } from './estimates.js';
import { processRelease } from './pipeline.js';
import type { EarningsRepository } from './repository.js';
import { SecBlockedError, SecError, isSubrequestError, resultsFilings, type SecClient, type SecFiling } from './sec.js';
import {
  MAX_ATTEMPTS_PER_DAY,
  MAX_FILING_AGE_DAYS,
  selectCandidates,
  type Candidate,
} from './select.js';
import { addDays, utcDayOf } from './util.js';

export type WatchPayload = JobPayloads['watchEarnings'];
export type FetchPayload = JobPayloads['fetchEarningsSummary'];

/** What the host builds from the user data: the held companies and their expected report dates. */
export interface EarningsInputs {
  build(today: string, now: Date): Promise<{ holdings: EarningsHolding[]; calendar: Record<string, string[]> }>;
}

export interface EarningsJobDeps {
  repo: EarningsRepository;
  inputs: EarningsInputs;
  config: EarningsConfig;
  /** Absent until `SEC_CONTACT` is set. */
  sec?: SecClient;
  /** Absent until the Workers AI binding exists. */
  extractor?: TextExtractor;
  estimates?: EstimateSource;
  queue: JobQueue;
  now: () => Date;
}

export const HELD_CACHE_HOURS = 6;
/** Candidates looked at per step: one SEC request each (the step makes about a dozen subrequests). */
export const CHECKS_PER_STEP = 10;
const BACKOFF_BASE_MS = 30 * 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;
const SEC_BLOCK_BASE_MS = 3_600_000;
const UNREADABLE_RETRY_MS = 6 * 3_600_000;
const MAX_UNREADABLE = 2;
const MAX_SEEN = 12;
const NEXT_DAY_MARGIN_MS = 5 * 60_000;

export interface WatchResult {
  checked: number;
  queued: number;
  skipped?: 'not-configured' | 'sec-blocked' | 'nothing-to-do';
}

export interface FetchResult {
  stored: boolean;
  outcome: 'stored' | 'exists' | 'not-results' | 'unreadable' | 'ai-allowance' | 'ai-error' | 'failed' | 'blocked' | 'attempts' | 'not-held' | 'not-configured' | 'sec-blocked';
}

const backoffMs = (failures: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
const iso = (ms: number): string => new Date(ms).toISOString();

/** The next 00:00 UTC (plus a margin), when the Workers AI allowance starts again. */
export function nextAllowanceReset(now: Date): string {
  return iso(Date.parse(`${utcDayOf(now)}T00:00:00Z`) + 86_400_000 + NEXT_DAY_MARGIN_MS);
}

/** The held companies and the calendar, from the cache (rebuilt every six hours: reading it costs one row). */
export async function loadHeld(deps: Pick<EarningsJobDeps, 'repo' | 'inputs' | 'now'>, force = false): Promise<EarningsHeldCache> {
  const now = deps.now();
  const cached = await deps.repo.getHeld();
  if (!force && cached !== null && now.getTime() - Date.parse(cached.builtAt) < HELD_CACHE_HOURS * 3_600_000) return cached;
  const built = await deps.inputs.build(localDayAndHour(now).day, now);
  const cache: EarningsHeldCache = { builtAt: now.toISOString(), ...built };
  await deps.repo.putHeld(cache);
  return cache;
}

/** Records a 403 or 429: nothing goes to the SEC until `blockedUntil` (an hour, doubling to a day, or what `Retry-After` asks). */
async function recordBlock(repo: EarningsRepository, error: SecBlockedError, now: Date): Promise<void> {
  const previous = await repo.getSecBlock();
  const failures = (previous?.failures ?? 0) + 1;
  const wait = Math.max(error.retryAfterMs ?? 0, Math.min(SEC_BLOCK_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS));
  await repo.putSecBlock({ blockedUntil: iso(now.getTime() + wait), failures, lastStatus: error.status, updatedAt: now.toISOString() });
}

async function activeBlock(repo: EarningsRepository, now: Date): Promise<EarningsSecBlock | undefined> {
  const block = await repo.getSecBlock();
  return block?.blockedUntil !== undefined && Date.parse(block.blockedUntil) > now.getTime() ? block : undefined;
}

/** A successful SEC call ends the long back-off history. */
async function clearBlockHistory(repo: EarningsRepository, now: Date): Promise<void> {
  const block = await repo.getSecBlock();
  if (block !== null && block.failures > 0) await repo.putSecBlock({ failures: 0, updatedAt: now.toISOString() });
}

async function failSymbol(deps: EarningsJobDeps, symbol: string, reason: string, extra: Partial<EarningsSymbolState> = {}): Promise<void> {
  const now = deps.now();
  const state = await deps.repo.getState(symbol);
  const failures = (state?.failures ?? 0) + 1;
  await deps.repo.patchState(symbol, { ...extra, lastCheckedAt: now.toISOString(), lastResult: 'failed', lastReason: reason, failures, retryAfter: iso(now.getTime() + backoffMs(failures)) }, now);
}

// --- watchEarnings --------------------------------------------------------------------------------------------------------

interface WatchCursor {
  candidates: Candidate[];
  index: number;
  checked: number;
  queued: number;
}

/** CIKs of the candidates that have none: one request for the whole ticker table, then remembered per symbol (checked again after a month). */
async function resolveCiks(deps: EarningsJobDeps, candidates: readonly Candidate[], states: ReadonlyMap<string, EarningsSymbolState>, holdings: ReadonlyMap<string, EarningsHolding>): Promise<void> {
  const missing = candidates.filter((candidate) => states.get(candidate.symbol)?.cik === undefined);
  if (missing.length === 0 || deps.sec === undefined) return;
  const table = await deps.sec.tickers();
  const now = deps.now();
  await Promise.all(
    missing.map(async ({ symbol }) => {
      const hit = lookupTicker(table, symbol, holdings.get(symbol)?.name);
      await deps.repo.patchState(symbol, hit === undefined ? { cikMissingAt: now.toISOString(), lastResult: 'not-in-sec', lastCheckedAt: now.toISOString() } : { cik: hit, cikMissingAt: undefined }, now);
    }),
  );
}

const SUFFIX_NOISE = new Set(['inc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'nv', 'sa', 'ag', 'se', 'holding', 'holdings', 'group', 'the', 'adr', 'class', 'a', 'b', 'ordinary', 'shares']);

function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !SUFFIX_NOISE.has(word));
}

/**
 * The CIK of a symbol in the SEC table. A US ticker matches itself; a symbol with an exchange suffix (`ASML.AS`) matches its US listing
 * (the ADR files the company's reports) only when the SEC's company title shares a significant word with the holding's name.
 */
export function lookupTicker(table: ReadonlyMap<string, { cik: string; title: string }>, symbol: string, name: string | undefined): string | undefined {
  const upper = symbol.toUpperCase();
  const exact = table.get(upper) ?? table.get(upper.replaceAll('.', '-'));
  if (exact !== undefined && !upper.includes('.')) return exact.cik;
  if (!upper.includes('.') && !upper.includes('-')) return undefined;
  const base = table.get(upper.split('.')[0]!);
  if (base === undefined || name === undefined) return exact?.cik;
  const wanted = new Set(significantWords(name));
  return significantWords(base.title).some((word) => wanted.has(word)) ? base.cik : undefined;
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
    await repo.patchState(candidate.symbol, { ...base, lastResult: 'no-filing', ...(candidate.mode === 'backfill' ? { backfillDone: true as const } : {}) }, now);
    return 'looked';
  }
  const origin = candidate.mode === 'backfill' ? 'backfill' : 'live';
  await deps.queue.enqueue({
    job: 'fetchEarningsSummary',
    payload: { symbol: candidate.symbol, cik: state.cik, accession: filing.accession, form: filing.form as '8-K' | '6-K', filingDate: filing.reportDate, primaryDocument: filing.primaryDocument, origin },
  });
  await repo.patchState(candidate.symbol, { ...base, lastResult: 'ok', pendingAccession: filing.accession, pendingAt: now.toISOString() }, now);
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
  await resolveCiks(deps, candidates, states, holdings);
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
  const reason = error instanceof SecError ? error.message : 'The check failed';
  await failSymbol(deps, candidate.symbol, reason);
  return 'skipped';
}

// --- fetchEarningsSummary --------------------------------------------------------------------------------------------------

const done = (outcome: FetchResult['outcome'], stored = false): { done: true; result: FetchResult } => ({ done: true, result: { stored, outcome } });

async function giveUp(deps: EarningsJobDeps, payload: FetchPayload, state: EarningsSymbolState | null, patch: Partial<EarningsSymbolState>): Promise<void> {
  const seen = [...(state?.seenAccessions ?? []), payload.accession].slice(-MAX_SEEN);
  await deps.repo.patchState(payload.symbol, { ...patch, seenAccessions: seen, pendingAccession: undefined, pendingAt: undefined, backfillDone: true }, deps.now());
}

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
      await deps.repo.patchState(payload.symbol, { pendingAccession: undefined, pendingAt: undefined, backfillDone: true }, now);
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
        return done('blocked');
      }
      if (isSubrequestError(error)) return { done: false, next: 'retry', delayMs: 1000 };
      logger.warn('Reading an earnings release failed', { error: error instanceof Error ? error.name : 'unknown' });
      await failSymbol(deps, payload.symbol, error instanceof SecError ? error.message : 'Reading the release failed');
      return done('failed');
    }
  };
}

type ReleaseOutcomeOf = Awaited<ReturnType<typeof processRelease>>;

async function settle(deps: EarningsJobDeps, payload: FetchPayload, state: EarningsSymbolState | null, counted: Partial<EarningsSymbolState>, outcome: ReleaseOutcomeOf): Promise<{ done: true; result: FetchResult }> {
  const now = deps.now();
  const { repo } = deps;
  const clear = { pendingAccession: undefined, pendingAt: undefined, failures: 0, retryAfter: undefined, lastReason: undefined };
  switch (outcome.status) {
    case 'stored': {
      await storeSummary(deps, outcome.summary);
      await repo.patchState(payload.symbol, { ...counted, ...clear, lastResult: 'ok', lastSuccessAt: now.toISOString(), lastAccession: payload.accession, backfillDone: true, unreadableCount: undefined }, now);
      if (payload.origin === 'live') await announce(deps.queue);
      return done('stored', true);
    }
    case 'not-results':
      await giveUp(deps, payload, state, { ...counted, ...clear, lastResult: 'no-filing' });
      return done('not-results');
    case 'unreadable': {
      const count = (state?.unreadableCount ?? 0) + 1;
      if (count >= MAX_UNREADABLE) await giveUp(deps, payload, state, { ...counted, ...clear, lastResult: 'unreadable', lastReason: outcome.reason, unreadableCount: count });
      else await repo.patchState(payload.symbol, { ...counted, ...clear, pendingAccession: undefined, lastResult: 'unreadable', lastReason: outcome.reason, unreadableCount: count, retryAfter: iso(now.getTime() + UNREADABLE_RETRY_MS) }, now);
      return done('unreadable');
    }
    case 'ai-allowance':
      await repo.patchState(payload.symbol, { pendingAccession: undefined, pendingAt: undefined, lastCheckedAt: now.toISOString(), lastResult: 'ai-allowance', lastReason: 'The Workers AI allowance of today is used up', retryAfter: nextAllowanceReset(now) }, now);
      return done('ai-allowance');
    default:
      await failSymbol(deps, payload.symbol, 'The model call failed', { ...counted, pendingAccession: undefined, pendingAt: undefined });
      return done('ai-error');
  }
}

async function storeSummary(deps: EarningsJobDeps, summary: EarningsSummary): Promise<void> {
  await deps.repo.putSummary(summary);
  await deps.repo.prune(summary.symbol);
}

/** A stored live summary is announced by the notification job (quiet hours and the ledger decide; a failure to queue never loses the summary). */
async function announce(queue: JobQueue): Promise<void> {
  try {
    await queue.enqueue({ job: 'notifyDividends', payload: { trigger: 'sync' } });
  } catch {
    logger.warn('Could not queue the notification job after an earnings summary');
  }
}
