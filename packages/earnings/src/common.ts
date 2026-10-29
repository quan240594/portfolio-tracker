/**
 * What the watch job and the backfill job share: the dependencies, the held-company cache, the SEC block, the ticker to CIK step, and the
 * structured `lastRun` every outcome leaves on the symbol (what the Earnings page shows when there is nothing else to show).
 */
import { logger, type JobQueue } from '@portfolio/platform';
import {
  EARNINGS_LIVE_HOURS,
  EARNINGS_SCHEMA_VERSION,
  localDayAndHour,
  type EarningsBackfillMarker,
  type EarningsHeldCache,
  type EarningsHolding,
  type EarningsLastRun,
  type EarningsOrigin,
  type EarningsPlanItem,
  type EarningsRunStage,
  type EarningsSecBlock,
  type EarningsSymbolState,
} from '@portfolio/shared';
import type { NeuronMeter, TextExtractor } from './ai.js';
import type { EarningsConfig } from './config.js';
import type { EstimateSource } from './estimates.js';
import type { EarningsRepository } from './repository.js';
import { SecError, type SecBlockedError, type SecClient } from './sec.js';
import { resolveTicker } from './tickers.js';
import { utcDayOf } from './util.js';

/** What the host builds from the user data: the companies held today, their expected report dates, and the symbols traded but held by nobody now. */
export interface EarningsInputs {
  build(today: string, now: Date): Promise<{ holdings: EarningsHolding[]; calendar: Record<string, string[]>; former?: string[] }>;
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
  /** The daily Workers AI allowance, to stop before a release is fetched that could not be read anyway. */
  neurons?: Pick<NeuronMeter, 'remaining'>;
  queue: JobQueue;
  now: () => Date;
}

export const HELD_CACHE_HOURS = 6;
export const BACKOFF_BASE_MS = 30 * 60_000;
export const BACKOFF_MAX_MS = 24 * 3_600_000;
const SEC_BLOCK_BASE_MS = 3_600_000;
const NEXT_DAY_MARGIN_MS = 5 * 60_000;
const DETAIL_MAX = 120;

export const backoffMs = (failures: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
export const iso = (ms: number): string => new Date(ms).toISOString();

/** The next 00:00 UTC (plus a margin), when the Workers AI allowance starts again. */
export function nextAllowanceReset(now: Date): string {
  return iso(Date.parse(`${utcDayOf(now)}T00:00:00Z`) + 86_400_000 + NEXT_DAY_MARGIN_MS);
}

/** A reason for the status page: one line, no URLs, no control characters, at most 120 characters. */
export function sanitizeDetail(text: string): string {
  return text
    .replaceAll(/https?:\/\/\S+/gi, '')
    .replaceAll(/[^\x20-\x7e]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);
}

/** A failure as a short reason for the status page: the message of an SEC error (ours, without URLs), else the name of whatever it was. */
export function describeFailure(error: unknown): string {
  if (error instanceof SecError) return error.message;
  return `unexpected ${error instanceof Error ? error.name : 'error'}`;
}

export interface RunExtras {
  filing?: { form: string; reportDate: string; accession: string };
  dropped?: number;
  neurons?: number;
}

/** The structured outcome stored on the symbol. */
export function runOf(now: Date, stage: EarningsRunStage, detail: string | undefined, extras: RunExtras = {}): EarningsLastRun {
  return {
    at: now.toISOString(),
    stage,
    ...(detail === undefined || detail === '' ? {} : { detail: sanitizeDetail(detail) }),
    ...(extras.filing === undefined ? {} : { filing: { form: extras.filing.form, date: extras.filing.reportDate, accession: extras.filing.accession } }),
    ...(extras.dropped === undefined ? {} : { droppedNumbers: extras.dropped }),
    ...(extras.neurons === undefined ? {} : { neurons: extras.neurons }),
  };
}

export type OriginRule = 'live' | 'by-age';

/** A release is `live` (announced) when the rule says so, or when it was published within the last 48 hours; the backfill's older ones are silent. */
export function originFor(reportDate: string, now: Date, rule: OriginRule): EarningsOrigin {
  if (rule === 'live') return 'live';
  return now.getTime() - Date.parse(`${reportDate}T00:00:00Z`) <= (EARNINGS_LIVE_HOURS + 24) * 3_600_000 ? 'live' : 'backfill';
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
export async function recordBlock(repo: EarningsRepository, error: SecBlockedError, now: Date): Promise<EarningsSecBlock> {
  const previous = await repo.getSecBlock();
  const failures = (previous?.failures ?? 0) + 1;
  const wait = Math.max(error.retryAfterMs ?? 0, Math.min(SEC_BLOCK_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS));
  const block: EarningsSecBlock = { blockedUntil: iso(now.getTime() + wait), failures, lastStatus: error.status, updatedAt: now.toISOString() };
  await repo.putSecBlock(block);
  return block;
}

export async function activeBlock(repo: EarningsRepository, now: Date): Promise<EarningsSecBlock | undefined> {
  const block = await repo.getSecBlock();
  return block?.blockedUntil !== undefined && Date.parse(block.blockedUntil) > now.getTime() ? block : undefined;
}

/** A successful SEC call ends the long back-off history. */
export async function clearBlockHistory(repo: EarningsRepository, now: Date): Promise<void> {
  const block = await repo.getSecBlock();
  if (block !== null && block.failures > 0) await repo.putSecBlock({ failures: 0, updatedAt: now.toISOString() });
}

export async function failSymbol(deps: Pick<EarningsJobDeps, 'repo' | 'now'>, symbol: string, run: EarningsLastRun, extra: Partial<EarningsSymbolState> = {}): Promise<void> {
  const now = deps.now();
  const state = await deps.repo.getState(symbol);
  const failures = (state?.failures ?? 0) + 1;
  await deps.repo.patchState(symbol, { ...extra, lastCheckedAt: now.toISOString(), lastResult: 'failed', lastReason: run.detail, lastRun: run, failures, retryAfter: iso(now.getTime() + backoffMs(failures)) }, now);
}

/**
 * CIKs of the symbols that have none: one request for the whole ticker table, then remembered per symbol (a symbol the SEC does not know is
 * looked up again after a month). A miss is a `ticker-map` run on the symbol, so the page says why nothing is read for it.
 */
export async function resolveCiks(
  deps: Pick<EarningsJobDeps, 'repo' | 'sec' | 'now'>,
  symbols: readonly string[],
  states: ReadonlyMap<string, EarningsSymbolState>,
  holdings: ReadonlyMap<string, EarningsHolding>,
): Promise<void> {
  const missing = symbols.filter((symbol) => states.get(symbol)?.cik === undefined);
  if (missing.length === 0 || deps.sec === undefined) return;
  const table = await deps.sec.tickers();
  const now = deps.now();
  await Promise.all(
    missing.map(async (symbol) => {
      const holding = holdings.get(symbol);
      const hit = resolveTicker(table, { symbol, name: holding?.name, isin: holding?.isin });
      if (hit === undefined) {
        const run = runOf(now, 'ticker-map', 'not found in the SEC company list (no US registration, or the name matches none)');
        await deps.repo.patchState(symbol, { cikMissingAt: now.toISOString(), lastResult: 'not-in-sec', lastCheckedAt: now.toISOString(), lastReason: run.detail, lastRun: run }, now);
      } else await deps.repo.patchState(symbol, { cik: hit.cik, cikMissingAt: undefined, ...(hit.via === 'ticker' ? {} : { lastRun: runOf(now, 'ticker-map', `matched by ${hit.via}`) }) }, now);
    }),
  );
}

/** A stored live summary is announced by the notification job (quiet hours and the ledger decide; a failure to queue never loses the summary). */
export async function announce(deps: Pick<EarningsJobDeps, 'queue'>): Promise<void> {
  try {
    await deps.queue.enqueue({ job: 'notifyDividends', payload: { trigger: 'sync' } });
  } catch {
    logger.warn('Could not queue the notification job after an earnings summary');
  }
}

/** A release with a stored summary: read, or read before and now read again for the blocks a schema change added. */
export const hasSummary = (item: EarningsPlanItem): boolean => item.status === 'stored' || (item.upgrade !== undefined && item.status !== 'skipped');

/** A release that is being read again for the blocks of the current schema version. */
export const isUpgrade = (item: EarningsPlanItem): boolean => item.upgrade === EARNINGS_SCHEMA_VERSION;

/**
 * The marker of the backfill with its counters rebuilt from the plans of the symbols. A symbol's target is `quarters` releases (fewer when
 * its list of candidates is shorter): its stored and failed releases are done, a 6-K that turned out not to be a results release is neither.
 * The pass that reads stored summaries again has its own counters (`upgrade`): it never lowers the counts of releases read.
 */
export function markerWithCounts(marker: EarningsBackfillMarker, states: readonly EarningsSymbolState[], companies: number, now: Date): EarningsBackfillMarker {
  let total = 0;
  let done = 0;
  let stored = 0;
  let failed = 0;
  let planned = 0;
  let upgradeTotal = 0;
  let upgradeDone = 0;
  for (const state of states) {
    if (state.plan === undefined || state.planQuarters !== marker.quarters) continue;
    planned += 1;
    const saved = state.plan.filter((item) => hasSummary(item)).length;
    const lost = state.plan.filter((item) => item.status === 'failed' && item.upgrade === undefined).length;
    const open = state.plan.filter((item) => item.status === 'todo' && item.upgrade === undefined).length;
    const target = Math.min(marker.quarters, saved + lost + open);
    total += target;
    done += Math.min(saved + lost, target);
    stored += saved;
    failed += lost;
    const reread = state.plan.filter((item) => isUpgrade(item));
    upgradeTotal += reread.length;
    upgradeDone += reread.filter((item) => item.status !== 'todo').length;
  }
  const { upgrade: _previous, ...rest } = marker;
  return { ...rest, total, done, stored, failed, planned, companies, ...(upgradeTotal === 0 ? {} : { upgrade: { total: upgradeTotal, done: upgradeDone } }), updatedAt: now.toISOString() };
}
