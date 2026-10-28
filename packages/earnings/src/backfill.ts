/**
 * `backfillEarnings`: the most recent quarterly releases of every eligible held company, newest first across all companies, within the daily
 * Workers AI allowance. Resumable and idempotent: the state is one marker row (`EARNINGS` / `BACKFILL`) and a plan on every symbol (`EARNSTATE.plan`).
 *
 * A step does one thing: re-arm failed releases after "Fetch all now", map symbols to CIKs, build the plans of a few symbols (one SEC request
 * each), or read one release (the filing index, up to four documents, at most two model calls). The next release is always the one of the
 * company with the fewest stored quarters, so pass one is the latest quarter of every company, pass two the quarter before, and so on: a
 * partial run is already useful. The run ends (the marker says why, and until when) when the daily AI allowance is used up, the SEC asked to
 * slow down, only releases that are not due again today are left, or everything is done. Scheduled every 15 minutes, a finished or waiting
 * backfill costs one row read.
 */
import { logger, type JobHandler, type JobPayloads, type JobStep } from '@portfolio/platform';
import { daysBetween, sequentially, type EarningsBackfillMarker, type EarningsBackfillWait, type EarningsHolding, type EarningsLastRun, type EarningsPlanItem, type EarningsSummary, type EarningsSymbolState } from '@portfolio/shared';
import {
  activeBlock,
  announce,
  clearBlockHistory,
  describeFailure,
  iso,
  loadHeld,
  markerWithCounts,
  nextAllowanceReset,
  originFor,
  recordBlock,
  resolveCiks,
  runOf,
  type EarningsJobDeps,
} from './common.js';
import { processRelease, type ReleaseOutcome } from './pipeline.js';
import { SecBlockedError, SecError, isSubrequestError, resultsFilings, type SecClient, type SecFiling } from './sec.js';
import { notInSec } from './select.js';
import { storeSummary } from './store.js';
import { addDays, utcDayOf } from './util.js';

export type BackfillPayload = JobPayloads['backfillEarnings'];

export interface BackfillResult {
  status: 'not-configured' | 'complete' | 'waiting' | 'progress' | 'stopped';
  waitReason?: EarningsBackfillWait;
}

/** Symbols planned per step: one submissions request each, plus the ticker table (once). */
export const PLAN_PER_STEP = 4;
/** Subrequests a step may use: the ticker table and four submissions lists, or a release (its index, up to four documents, the EPS estimate). */
export const BACKFILL_STEP_SUBREQUESTS = 8;
/** Below this many neurons the day's allowance cannot read a release: the run waits for 00:00 UTC instead of fetching documents it cannot use. */
export const MIN_NEURONS_TO_READ = 150;
export const MAX_TRIES_PER_DAY = 2;
const MAX_TRIES_UNREADABLE = 2;
const MAX_TRIES_ERROR = 4;
const RETRY_UNREADABLE_MS = 6 * 3_600_000;
const RETRY_ERROR_MS = 30 * 60_000;
const MAX_ERRORS_PER_RUN = 3;
const MAX_STEPS_PER_RUN = 400;
const PLAN_MAX_AGE_MS = 24 * 3_600_000;
const SAME_QUARTER_DAYS = 45;
const DAYS_PER_QUARTER = 92;
const PLAN_SLACK_DAYS = 60;
/** A 6-K filer files many documents that are no results release: look at this many candidates per wanted quarter. */
const FOREIGN_CANDIDATES_PER_QUARTER = 4;

interface Cursor {
  steps: number;
  errors: number;
}

const marked = (marker: EarningsBackfillMarker, patch: Partial<EarningsBackfillMarker>): EarningsBackfillMarker => ({ ...marker, ...patch });

/** A new marker: the backfill starts (or starts over) with these quarters. */
export function armedMarker(quarters: number, armedBy: EarningsBackfillMarker['armedBy'], now: Date): EarningsBackfillMarker {
  const at = now.toISOString();
  return { armedAt: at, armedBy, quarters, status: 'running', total: 0, done: 0, stored: 0, failed: 0, planned: 0, companies: 0, updatedAt: at };
}

/**
 * The releases to read for a company, newest first: its 8-Ks with item 2.02 (one per quarter: a second one within 45 days is no new quarter),
 * and for a foreign issuer its 6-Ks (any of them may be the results release: reading tells). Releases that are already stored start as stored.
 */
export function planItems(filings: readonly SecFiling[], quarters: number, today: string, stored: readonly EarningsSummary[]): EarningsPlanItem[] {
  const oldest = addDays(today, -(quarters * DAYS_PER_QUARTER + PLAN_SLACK_DAYS));
  const items: EarningsPlanItem[] = [];
  const kept: string[] = [];
  for (const filing of resultsFilings(filings).filter((entry) => entry.filingDate >= oldest)) {
    const form = filing.form as '8-K' | '6-K';
    const sameQuarter = form === '8-K' && kept.some((date) => Math.abs(daysBetween(date, filing.reportDate)) < SAME_QUARTER_DAYS);
    const forms = items.filter((item) => item.form === form).length;
    if (sameQuarter || forms >= (form === '8-K' ? quarters : quarters * FOREIGN_CANDIDATES_PER_QUARTER)) continue;
    if (form === '8-K') kept.push(filing.reportDate);
    const have = stored.some((summary) => summary.accession === filing.accession || summary.reportDate === filing.reportDate);
    items.push({ accession: filing.accession, form, filingDate: filing.filingDate, reportDate: filing.reportDate, primaryDocument: filing.primaryDocument, status: have ? 'stored' : 'todo', tries: 0 });
  }
  return items;
}

interface Run {
  deps: EarningsJobDeps;
  sec: SecClient;
  extractor: NonNullable<EarningsJobDeps['extractor']>;
  marker: EarningsBackfillMarker;
  holdings: ReadonlyMap<string, EarningsHolding>;
  states: Map<string, EarningsSymbolState>;
  now: Date;
  today: string;
}

type StepEnd = { kind: 'continue'; failed?: true } | { kind: 'wait'; reason: EarningsBackfillWait; until: string } | { kind: 'retry' } | { kind: 'complete' };

const stored = (state: EarningsSymbolState | undefined): number => state?.plan?.filter((item) => item.status === 'stored').length ?? 0;

async function patch(run: Run, symbol: string, change: Partial<EarningsSymbolState>): Promise<EarningsSymbolState> {
  const next = await run.deps.repo.patchState(symbol, change, run.now);
  run.states.set(symbol, next);
  return next;
}

/** "Fetch all now" gives failed releases another chance: they become `todo` again (their tries of today still count). */
async function reopenFailed(run: Run): Promise<boolean> {
  const reopened = [...run.states.values()].filter((state) => state.plan?.some((item) => item.status === 'failed' && (item.failedAt ?? '') < run.marker.armedAt));
  await Promise.all(
    reopened.map((state) =>
      patch(run, state.symbol, { plan: state.plan!.map((item) => (item.status === 'failed' && (item.failedAt ?? '') < run.marker.armedAt ? { ...item, status: 'todo' as const, tries: 0, failedAt: undefined, nextTryAt: undefined } : item)) }),
    ),
  );
  return reopened.length > 0;
}

const needsPlan = (state: EarningsSymbolState | undefined, run: Run): boolean => {
  if (state?.cik === undefined) return false;
  if (state.plan === undefined || state.planQuarters !== run.marker.quarters) return true;
  const stale = run.now.getTime() - Date.parse(state.plannedAt ?? '') > PLAN_MAX_AGE_MS;
  const asked = run.marker.armedBy === 'manual' && (state.plannedAt ?? '') < run.marker.armedAt;
  // "Fetch all now" makes every plan again; a plan without releases (a failed SEC request, or a company that had none) is also made again after a day.
  return state.plan.length === 0 ? stale || asked : asked;
};

/** A release planned again keeps what was tried of it today: a rescan does not hand out new attempts. */
function carryTries(items: readonly EarningsPlanItem[], previous: readonly EarningsPlanItem[]): EarningsPlanItem[] {
  return items.map((item) => {
    const before = previous.find((entry) => entry.accession === item.accession);
    return before?.triesDay === undefined ? item : { ...item, triesDay: before.triesDay, triesToday: before.triesToday };
  });
}

async function planSymbol(run: Run, symbol: string): Promise<void> {
  const { deps, sec, now } = run;
  const state = run.states.get(symbol);
  let filings: SecFiling[];
  try {
    filings = await sec.submissions(state!.cik!);
  } catch (error) {
    if (error instanceof SecError) {
      await patch(run, symbol, { plan: [], planQuarters: run.marker.quarters, plannedAt: now.toISOString(), lastResult: 'failed', lastReason: error.message, lastRun: runOf(now, 'submissions', error.message) });
      return;
    }
    throw error;
  }
  const items = carryTries(planItems(filings, run.marker.quarters, run.today, await deps.repo.latest(symbol, 12)), state!.plan ?? []);
  const open = items.filter((item) => item.status === 'todo').length;
  let note = runOf(now, 'select-filing', `${open} release(s) to read, the latest first`);
  if (items.length === 0) note = runOf(now, 'no-release-found', 'no results release (8-K item 2.02 or 6-K) in the SEC list for this period');
  else if (open === 0) note = runOf(now, 'ok', `${items.length} quarter(s) already stored`);
  await patch(run, symbol, { plan: items, planQuarters: run.marker.quarters, plannedAt: now.toISOString(), lastCheckedAt: now.toISOString(), lastRun: note, ...(items.length === 0 ? { lastResult: 'no-filing' as const } : {}) });
}

/** Maps the symbols that have no CIK yet and builds the plans of a few symbols. `true` when it did something this step. */
async function planPhase(run: Run): Promise<boolean> {
  const unmapped = [...run.holdings.keys()].filter((symbol) => run.states.get(symbol)?.cik === undefined && !notInSec(run.states.get(symbol), run.today));
  if (unmapped.length > 0) {
    await resolveCiks(run.deps, unmapped, run.states, run.holdings);
    const fresh = await run.deps.repo.getStates(unmapped);
    for (const [symbol, state] of fresh) run.states.set(symbol, state);
  }
  const due = [...run.holdings.keys()].filter((symbol) => needsPlan(run.states.get(symbol), run)).slice(0, PLAN_PER_STEP);
  // One request after the other: every plan calls the SEC, whose fair-access limit the shared token bucket enforces.
  for await (const _ of sequentially(due, (symbol) => planSymbol(run, symbol))) {
    // the plan is stored on the symbol
  }
  return unmapped.length > 0 || due.length > 0;
}

const dueItem = (item: EarningsPlanItem, run: Run): boolean => {
  if (item.status !== 'todo') return false;
  if (item.nextTryAt !== undefined && Date.parse(item.nextTryAt) > run.now.getTime()) return false;
  return item.triesDay !== utcDayOf(run.now) || (item.triesToday ?? 0) < MAX_TRIES_PER_DAY;
};

type Next = { symbol: string; item: EarningsPlanItem } | { waitUntil: string; reason: EarningsBackfillWait } | undefined;

/** The next release: of the company with the fewest stored quarters (alphabetical among equals), its newest one that is due. */
function pickNext(run: Run): Next {
  const wanting = [...run.states.values()].filter((state) => run.holdings.has(state.symbol) && state.plan !== undefined && state.planQuarters === run.marker.quarters && stored(state) < run.marker.quarters);
  const ranked = wanting.toSorted((a, b) => stored(a) - stored(b) || a.symbol.localeCompare(b.symbol));
  for (const state of ranked) {
    const item = state.plan!.find((entry) => dueItem(entry, run));
    if (item !== undefined) return { symbol: state.symbol, item };
  }
  const waiting = wanting.flatMap((state) => state.plan!.filter((item) => item.status === 'todo'));
  if (waiting.length === 0) return undefined;
  const times = waiting.map((item) => (item.nextTryAt !== undefined && Date.parse(item.nextTryAt) > run.now.getTime() ? item.nextTryAt : nextAllowanceReset(run.now)));
  return { waitUntil: times.toSorted((a, b) => a.localeCompare(b))[0]!, reason: 'attempts' };
}

const filingOf = (item: EarningsPlanItem) => ({ form: item.form, reportDate: item.reportDate, accession: item.accession });

function withItem(state: EarningsSymbolState, accession: string, change: Partial<EarningsPlanItem>): EarningsPlanItem[] {
  return state.plan!.map((item) => (item.accession === accession ? { ...item, ...change } : item));
}

/** A symbol whose list has nothing left to read and nothing stored: say so, instead of a stale "reading it". */
function noReleaseNote(state: EarningsSymbolState, run: Run): Partial<EarningsSymbolState> {
  const plan = state.plan ?? [];
  const noneLeft = plan.every((item) => item.status === 'skipped');
  return noneLeft && plan.length > 0
    ? { lastResult: 'no-filing', lastRun: runOf(run.now, 'no-release-found', `${plan.length} filing(s) looked at, none was a results release`) }
    : {};
}

async function finishItem(run: Run, symbol: string, item: EarningsPlanItem, outcome: ReleaseOutcome): Promise<StepEnd> {
  const { now, deps } = run;
  const filing = filingOf(item);
  const state = run.states.get(symbol)!;
  switch (outcome.status) {
    case 'stored': {
      await storeSummary(deps.repo, outcome.summary);
      const newest = (await deps.repo.latest(symbol, 1))[0]?.reportDate === item.reportDate;
      await patch(run, symbol, {
        plan: withItem(state, item.accession, { status: 'stored', reason: undefined, nextTryAt: undefined }),
        lastCheckedAt: now.toISOString(),
        lastResult: 'ok',
        lastReason: undefined,
        lastRun: runOf(now, 'ok', 'summary stored', { filing, dropped: outcome.dropped, neurons: outcome.neurons }),
        ...(newest ? { lastSuccessAt: now.toISOString(), lastAccession: item.accession } : {}),
      });
      if (outcome.summary.origin === 'live') await announce(deps);
      return { kind: 'continue' };
    }
    case 'not-results': {
      const next = await patch(run, symbol, { plan: withItem(state, item.accession, { status: 'skipped', reason: outcome.detail }), lastCheckedAt: now.toISOString() });
      await patch(run, symbol, stored(next) === 0 ? { lastRun: runOf(now, outcome.stage, outcome.detail, { filing }), ...noReleaseNote(next, run) } : {});
      return { kind: 'continue' };
    }
    case 'ai-allowance':
      await patch(run, symbol, { plan: withItem(state, item.accession, { tries: Math.max(0, item.tries - 1), triesToday: Math.max(0, (item.triesToday ?? 1) - 1) }), lastRun: runOf(now, 'budget', 'the daily AI allowance is used up, it resumes after 00:00 UTC', { filing, neurons: outcome.neurons }) });
      return { kind: 'wait', reason: 'allowance', until: nextAllowanceReset(now) };
    default:
      return failedItem(run, symbol, item, outcome);
  }
}

/** An unreadable release is read once more later, an error is retried after a pause; both end as `failed` after a few tries ("Fetch all now" reopens them). */
type FailedOutcome = Extract<ReleaseOutcome, { status: 'unreadable' | 'ai-error' | 'sec-error' }>;

/** The stage, the reason and what else to remember of a failed read. */
function failureRun(now: Date, item: EarningsPlanItem, outcome: FailedOutcome): EarningsLastRun {
  const filing = filingOf(item);
  if (outcome.status === 'sec-error') return runOf(now, outcome.stage, outcome.detail, { filing });
  if (outcome.status === 'ai-error') return runOf(now, 'ai', `model error: ${outcome.detail}`, { filing, neurons: outcome.neurons });
  return runOf(now, outcome.stage, outcome.detail, { filing, neurons: outcome.neurons, ...(outcome.dropped === undefined ? {} : { dropped: outcome.dropped }) });
}

async function failedItem(run: Run, symbol: string, item: EarningsPlanItem, outcome: FailedOutcome): Promise<StepEnd> {
  const { now } = run;
  const unreadable = outcome.status === 'unreadable';
  const lost = item.tries >= (unreadable ? MAX_TRIES_UNREADABLE : MAX_TRIES_ERROR);
  const lastRun = failureRun(now, item, outcome);
  const reason = (lastRun.detail ?? '').slice(0, 80);
  const retryAt = iso(now.getTime() + (unreadable ? RETRY_UNREADABLE_MS : RETRY_ERROR_MS));
  const change: Partial<EarningsPlanItem> = lost ? { status: 'failed', failedAt: now.toISOString(), reason } : { nextTryAt: retryAt, reason };
  await patch(run, symbol, { plan: withItem(run.states.get(symbol)!, item.accession, change), lastCheckedAt: now.toISOString(), lastResult: unreadable ? 'unreadable' : 'failed', lastReason: lastRun.detail, lastRun });
  return unreadable ? { kind: 'continue' } : { kind: 'continue', failed: true };
}

/** Reads one release. Everything that can go wrong is an outcome; an SEC block or the subrequest limit ends the step. */
async function readItem(run: Run, symbol: string, item: EarningsPlanItem): Promise<StepEnd> {
  const { deps, now } = run;
  const holding = run.holdings.get(symbol)!;
  const day = utcDayOf(now);
  const counted = { tries: item.tries + 1, triesDay: day, triesToday: (item.triesDay === day ? (item.triesToday ?? 0) : 0) + 1 };
  const existing = await deps.repo.getSummary(symbol, item.reportDate);
  if (existing !== null) {
    await patch(run, symbol, { plan: withItem(run.states.get(symbol)!, item.accession, { status: 'stored' }) });
    return { kind: 'continue' };
  }
  // The try is written first: a release that crashes the run is not tried again and again.
  const started = await patch(run, symbol, { plan: withItem(run.states.get(symbol)!, item.accession, counted) });
  const tried = { ...item, ...counted };
  try {
    const previous = (await deps.repo.latest(symbol, 12)).find((summary) => summary.reportDate < item.reportDate);
    const ref = { symbol, cik: started.cik!, accession: item.accession, form: item.form, reportDate: item.reportDate, primaryDocument: item.primaryDocument, origin: originFor(item.reportDate, now, 'by-age') };
    // Only a release that notifies asks for the EPS estimate: the 25 Alpha Vantage calls a day are shared with the price service, and 80 old quarters would use them all.
    const estimates = ref.origin === 'live' ? deps.estimates : undefined;
    const outcome = await processRelease({ sec: run.sec, extractor: run.extractor, estimates, now: deps.now }, ref, holding, previous);
    return await finishItem(run, symbol, tried, outcome);
  } catch (error) {
    return interrupted(run, symbol, tried, error);
  }
}

async function interrupted(run: Run, symbol: string, item: EarningsPlanItem, error: unknown): Promise<StepEnd> {
  const { now } = run;
  const giveBack = { tries: Math.max(0, item.tries - 1), triesToday: Math.max(0, (item.triesToday ?? 1) - 1) };
  if (error instanceof SecBlockedError) {
    const block = await recordBlock(run.deps.repo, error, now);
    await patch(run, symbol, { plan: withItem(run.states.get(symbol)!, item.accession, giveBack), lastRun: runOf(now, 'sec-blocked', `blocked by the SEC (HTTP ${error.status})`, { filing: filingOf(item) }) });
    return { kind: 'wait', reason: 'sec-blocked', until: block.blockedUntil ?? nextAllowanceReset(now) };
  }
  if (isSubrequestError(error)) {
    await patch(run, symbol, { plan: withItem(run.states.get(symbol)!, item.accession, giveBack) });
    return { kind: 'retry' };
  }
  logger.warn('Reading an earnings release in the backfill failed', { error: error instanceof Error ? error.name : 'unknown' });
  return failedItem(run, symbol, item, { status: 'sec-error', stage: 'exhibit', detail: describeFailure(error) });
}

/** One step of a running backfill. */
async function runStep(run: Run): Promise<StepEnd> {
  if (await reopenFailed(run)) return { kind: 'continue' };
  if (await planPhase(run)) return { kind: 'continue' };
  const pick = pickNext(run);
  if (pick === undefined) return { kind: 'complete' };
  if ('waitUntil' in pick) return { kind: 'wait', reason: pick.reason, until: pick.waitUntil };
  const remaining = (await run.deps.neurons?.remaining()) ?? Number.POSITIVE_INFINITY;
  if (remaining < MIN_NEURONS_TO_READ) return { kind: 'wait', reason: 'allowance', until: nextAllowanceReset(run.now) };
  return readItem(run, pick.symbol, pick.item);
}

async function ensureMarker(deps: EarningsJobDeps, now: Date): Promise<EarningsBackfillMarker> {
  const marker = await deps.repo.getBackfill();
  const quarters = deps.config.backfillQuarters;
  if (marker !== null && (marker.status === 'running' || marker.quarters === quarters)) return marker;
  const armed = armedMarker(quarters, 'auto', now);
  await deps.repo.putBackfill(armed);
  return armed;
}

const isWaiting = (marker: EarningsBackfillMarker, now: Date): boolean => marker.waitUntil !== undefined && Date.parse(marker.waitUntil) > now.getTime();

/** The run of one step. A manual run rebuilds the held list (the current holdings), drops the check state of symbols nobody holds any more and retries the unmapped ones. */
async function startRun(deps: EarningsJobDeps, marker: EarningsBackfillMarker, now: Date, held: 'cached' | 'rebuilt'): Promise<Run> {
  const cache = await loadHeld(deps, held === 'rebuilt');
  const holdings = new Map(cache.holdings.map((holding) => [holding.symbol, holding]));
  if (held === 'rebuilt' && cache.former !== undefined) await deps.repo.deleteStates(cache.former);
  const states = await deps.repo.getStates([...holdings.keys()]);
  const run: Run = { deps, sec: deps.sec!, extractor: deps.extractor!, marker, holdings, states, now, today: utcDayOf(now) };
  if (held === 'rebuilt') await retryUnmapped(run);
  return run;
}

/** A rescan looks the companies the SEC did not know up again, instead of waiting out the month. */
async function retryUnmapped(run: Run): Promise<void> {
  const missed = [...run.states.values()].filter((state) => state.cik === undefined && state.cikMissingAt !== undefined);
  await Promise.all(missed.map((state) => patch(run, state.symbol, { cikMissingAt: undefined })));
}

/** Writes the marker with fresh counters after a step, and what the step ended in. */
async function saveMarker(run: Run, end: StepEnd): Promise<EarningsBackfillMarker> {
  const counted = markerWithCounts(run.marker, [...run.states.values()].filter((state) => run.holdings.has(state.symbol)), run.holdings.size, run.now);
  const base = marked(counted, { lastStepAt: run.now.toISOString(), waitUntil: undefined, waitReason: undefined });
  let next = base;
  if (end.kind === 'wait') next = marked(base, { waitUntil: end.until, waitReason: end.reason });
  else if (end.kind === 'complete') next = marked(base, { status: 'complete', completedAt: run.now.toISOString() });
  await run.deps.repo.putBackfill(next);
  return next;
}

/** A step; a SEC refusal or an unreadable SEC answer ends it as a wait (recorded on the marker), never as a failure of the job. */
async function guardedStep(run: Run): Promise<StepEnd> {
  try {
    return await runStep(run);
  } catch (error) {
    if (error instanceof SecBlockedError) {
      const block = await recordBlock(run.deps.repo, error, run.now);
      return { kind: 'wait', reason: 'sec-blocked', until: block.blockedUntil ?? nextAllowanceReset(run.now) };
    }
    if (error instanceof SecError) return { kind: 'wait', reason: 'sec-error', until: iso(run.now.getTime() + RETRY_ERROR_MS) };
    if (isSubrequestError(error)) return { kind: 'retry' };
    throw error;
  }
}

/** Why a run does not start: the backfill is complete, it pauses (the marker says until when), or the SEC blocks. */
async function notStarted(deps: EarningsJobDeps, marker: EarningsBackfillMarker, now: Date, step: 'first' | 'next'): Promise<BackfillResult | undefined> {
  if (marker.status === 'complete') return { status: 'complete' };
  // The first step of a run honours the pause the marker records; the steps that follow belong to a run that only ever pauses by ending.
  if (step === 'first' && isWaiting(marker, now)) return { status: 'waiting', waitReason: marker.waitReason };
  const block = await activeBlock(deps.repo, now);
  if (block?.blockedUntil === undefined) return undefined;
  await deps.repo.putBackfill(marked(marker, { waitUntil: block.blockedUntil, waitReason: 'sec-blocked', updatedAt: now.toISOString() }));
  return { status: 'waiting', waitReason: 'sec-blocked' };
}

/** What follows a step: three errors in a row pause the run, the marker is saved, and the job goes on or ends. */
async function afterStep(run: Run, step: Exclude<StepEnd, { kind: 'retry' }>, progress: Cursor): Promise<JobStep<BackfillResult>> {
  const errors = step.kind === 'continue' && step.failed ? progress.errors + 1 : 0;
  const end: StepEnd = errors >= MAX_ERRORS_PER_RUN ? { kind: 'wait', reason: 'ai-error', until: iso(run.now.getTime() + RETRY_ERROR_MS) } : step;
  if (end.kind !== 'wait') await clearBlockHistory(run.deps.repo, run.now);
  await saveMarker(run, end);
  if (end.kind === 'wait') return { done: true, result: { status: 'waiting', waitReason: end.reason } };
  if (end.kind === 'complete') return { done: true, result: { status: 'complete' } };
  const next: Cursor = { steps: progress.steps + 1, errors };
  if (next.steps >= MAX_STEPS_PER_RUN) return { done: true, result: { status: 'stopped' } };
  return { done: false, next: JSON.stringify(next satisfies Cursor) };
}

/** `backfillEarnings`: see the module comment. */
export function createBackfillEarningsJob(getDeps: () => EarningsJobDeps): JobHandler<BackfillPayload, BackfillResult> {
  return async ({ payload, cursor }) => {
    const deps = getDeps();
    const now = deps.now();
    if (deps.sec === undefined || deps.extractor === undefined) return { done: true, result: { status: 'not-configured' } };
    const marker = await ensureMarker(deps, now);
    const idle = await notStarted(deps, marker, now, cursor === undefined ? 'first' : 'next');
    if (idle !== undefined) return { done: true, result: idle };
    const progress: Cursor = cursor === undefined ? { steps: 0, errors: 0 } : (JSON.parse(cursor) as Cursor);
    const run = await startRun(deps, marker, now, payload.trigger === 'manual' && cursor === undefined ? 'rebuilt' : 'cached');
    const step = await guardedStep(run);
    if (step.kind === 'retry') return { done: false, next: JSON.stringify(progress satisfies Cursor) };
    return afterStep(run, step, progress);
  };
}
