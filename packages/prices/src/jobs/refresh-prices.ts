import type { JobHandler, JobPayloads, ScheduledRefreshSummary } from '@portfolio/platform';
import { z } from 'zod';
import { isMarketSymbol, sourceOf, type InstrumentProfile, type Quote } from '@portfolio/shared';
import { errorMessage, ProviderError, RateLimitError, SymbolNotFoundError } from '../errors.js';
import { hasWeekday, yearChunks } from '../providers/frankfurter.js';
import { TWELVEDATA_CREDITS_PER_MINUTE, TWELVEDATA_MAX_BATCH } from '../providers/twelvedata.js';
import { EODHD_MAX_BATCH } from '../providers/eodhd.js';
import { COINGECKO_MAX_IDS } from '../providers/coingecko.js';
import { SOURCE_OF_ROUTE, hasExchangeSuffix, providerOf, routeOf, type Route } from '../symbols.js';
import { addDays, amsterdamHour, utcDay } from '../time.js';
import { byText, chunks } from '../parse.js';
import { initialRepair, runMinorUnitRepair } from './repair-minor-units.js';
import { createStepContext, decodeState, pendingStep, runStep, rethrowBudget, runUnits, whileAffordable, type PriceJobDeps, type StepContext } from './common.js';

/** Exchange-listed quotes older than this are refreshed outside the EU window. */
export const STALE_AFTER_MS = 24 * 3_600_000;
/** Inside the EU window a listed quote this fresh is kept: the Trading 212 refresh stores one every 15 minutes, and EODHD's free plan has 20 calls a day. */
export const FRESH_LISTED_QUOTE_MS = 2 * 3_600_000;
/** Optional company details are refreshed lazily: a few symbols per run, each at most once per TTL. */
export const PROFILE_DETAILS_TTL_DAYS = 30;
export const PROFILE_DETAILS_PER_RUN = 3;
/** A symbol's profile lookup is tried at most this many times a UTC day after a failure that was not a rate limit. */
export const MAX_PROFILE_TRIES_PER_DAY = 2;
const PROFILE_PROVIDERS = Object.values(SOURCE_OF_ROUTE);

/** Worst case of a profile lookup: Alpha Vantage, then Twelve Data's `/profile`, `/stocks` and `/etfs`. */
const PROFILE_CALLS = 4;

const BATCH_SIZE: Readonly<Record<Route, number>> = { us: TWELVEDATA_MAX_BATCH, listed: EODHD_MAX_BATCH, crypto: COINGECKO_MAX_IDS };
const SOURCE_OF = SOURCE_OF_ROUTE;

const latestSchema = z.object({ base: z.string(), asOf: z.string(), date: z.string().optional(), rates: z.record(z.number()) });
const stateSchema = z.object({
  v: z.literal(1),
  now: z.string(),
  phase: z.enum(['fx', 'history', 'plan', 'quotes', 'details', 'repair', 'done']),
  symbols: z.array(z.string()),
  fx: z.object({ ok: z.boolean(), latest: latestSchema.nullable() }),
  history: z.object({ ranges: z.array(z.tuple([z.string(), z.string()])), written: z.number(), ok: z.boolean(), lastDay: z.string().nullable(), final: z.boolean() }),
  euWindow: z.boolean(),
  skipped: z.array(z.string()),
  failed: z.record(z.string()),
  refreshed: z.array(z.string()),
  batches: z.array(z.object({ route: z.enum(['crypto', 'listed', 'us']), symbols: z.array(z.string()) })),
  readyAt: z.record(z.number()),
  detailQueue: z.array(z.string()).nullable(),
  detailsRefreshed: z.number(),
  // Absent in a cursor stored before the repair existed.
  repair: z
    .object({ queue: z.array(z.string()).nullable(), failed: z.number(), rows: z.object({ read: z.number(), written: z.number() }) })
    .default(() => initialRepair()),
});

type State = z.infer<typeof stateSchema>;
type Batch = State['batches'][number];

function initialState(now: Date, symbols: string[]): State {
  return {
    v: 1,
    now: now.toISOString(),
    phase: 'fx',
    symbols,
    fx: { ok: false, latest: null },
    history: { ranges: [], written: 0, ok: true, lastDay: null, final: false },
    euWindow: false,
    skipped: [],
    failed: {},
    refreshed: [],
    batches: [],
    readyAt: {},
    detailQueue: null,
    detailsRefreshed: 0,
    repair: initialRepair(),
  };
}

// --- FX ---

/** Latest ECB rates, stored as `FX#{base}/LATEST`; then the plan of the missing daily fixings. Failures are isolated. */
async function runFx(ctx: StepContext, state: State, now: Date): Promise<void> {
  const base = ctx.deps.config.baseCurrency;
  try {
    const latest = await ctx.md.fx.getLatest(base);
    await ctx.repo.putFx({ base: latest.base, rates: latest.rates, asOf: latest.asOf });
    state.fx = { ok: true, latest };
    ctx.logger.info('fx refreshed', { base: latest.base, currencies: Object.keys(latest.rates).length, asOf: latest.asOf });
  } catch (error) {
    rethrowBudget(error);
    ctx.logger.error('fx refresh failed', { error: errorMessage(error) });
  }
  try {
    const { ranges, newest } = await missingFxRanges(ctx, now);
    state.history = { ranges, written: 0, ok: true, lastDay: newest, final: false };
  } catch (error) {
    ctx.logger.error('fx history plan failed', { error: errorMessage(error) });
    state.history = { ranges: [], written: 0, ok: false, lastDay: null, final: true };
  }
  state.phase = 'history';
}

/** The stored fixings may start later than `FX_HISTORY_START` (it was set later, or the first backfill never reached the early years): fixings older than this many days past the start count as a gap. */
export const FX_FRONT_TOLERANCE_DAYS = 10;

/**
 * The year ranges of fixings to fetch, oldest first: the gap before the oldest stored fixing (looked for once a UTC day, so a provider
 * without those years is not asked every run) and everything after the newest one; all of it from `FX_HISTORY_START` when nothing is stored.
 */
async function missingFxRanges(ctx: StepContext, now: Date): Promise<{ ranges: [string, string][]; newest: string | null }> {
  const base = ctx.deps.config.baseCurrency;
  const configured = ctx.deps.config.fxHistoryStart;
  const today = utcDay(now);
  const [newest, oldest] = await Promise.all([ctx.repo.latestFxDay(base), ctx.repo.earliestFxDay(base)]);
  const ranges: [string, string][] = [];
  if (oldest !== null && oldest > addDays(configured, FX_FRONT_TOLERANCE_DAYS) && !(await ctx.repo.fxFrontCheckedOn(today))) {
    await ctx.repo.markFxFrontChecked(today);
    ranges.push(...yearChunks(configured, addDays(oldest, -1)));
  }
  const start = newest === null ? configured : addDays(newest, 1);
  if (start <= today) ranges.push(...yearChunks(start, today));
  return { ranges: ranges.filter(([lo, hi]) => hasWeekday(lo, hi)), newest };
}

/** Missing fixings, one calendar year per request, stored as they arrive; today's fixing last (never over a gap). */
async function runHistory(ctx: StepContext, state: State): Promise<void> {
  const { history } = state;
  const base = ctx.deps.config.baseCurrency;
  await runUnits(
    whileAffordable(history.ranges, () => history.ok && ctx.affords(1)),
    async ([lo, hi]) => {
      try {
        const days = await ctx.md.fx.getHistoryChunk(base, lo, hi);
        history.written += await ctx.repo.putFxDays(days);
        const newest = days.at(-1)?.date;
        if (newest !== undefined && newest > (history.lastDay ?? '')) history.lastDay = newest;
        history.ranges.shift();
      } catch (error) {
        rethrowBudget(error);
        ctx.logger.error('fx history refresh failed', { error: errorMessage(error) });
        history.ok = false;
        history.ranges = [];
      }
    },
  );
  if (history.ranges.length > 0 && history.ok) return;
  if (history.ok && !history.final) await storeTodaysFixing(ctx, state);
  history.final = true;
  state.phase = 'plan';
}

async function storeTodaysFixing(ctx: StepContext, state: State): Promise<void> {
  const { history } = state;
  const base = ctx.deps.config.baseCurrency;
  const latest = state.fx.latest;
  const fixing = latest?.base === base ? latest.date : undefined;
  if (latest === null || fixing === undefined || fixing <= (history.lastDay ?? '')) return;
  try {
    history.written += await ctx.repo.putFxDays([{ base, date: fixing, rates: latest.rates }]);
  } catch (error) {
    rethrowBudget(error);
    ctx.logger.error('fx history refresh failed', { error: errorMessage(error) });
    history.ok = false;
  }
}

// --- quotes ---

/** Splits the tracked symbols into (due, skipped): exchange-listed ones only refresh inside the EU window or when stale. */
async function planQuotes(ctx: StepContext, state: State, now: Date): Promise<void> {
  const { symbols } = state;
  state.euWindow = ctx.deps.config.euRefreshHours.includes(amsterdamHour(now));
  const due = symbols.filter((symbol) => !hasExchangeSuffix(symbol));
  const listed = symbols.filter((symbol) => hasExchangeSuffix(symbol));
  const latest = listed.length > 0 ? await ctx.repo.latestQuotes(listed) : new Map<string, Quote>();
  const keepFor = state.euWindow ? FRESH_LISTED_QUOTE_MS : STALE_AFTER_MS;
  for (const symbol of listed) {
    const quote = latest.get(symbol);
    const age = quote === undefined ? Number.NaN : now.getTime() - Date.parse(quote.asOf);
    if (Number.isNaN(age) || age > keepFor) due.push(symbol);
    else state.skipped.push(symbol);
  }
  const byRoute = new Map<Route, string[]>();
  for (const symbol of due) {
    const route = routeOf(symbol);
    byRoute.set(route, [...(byRoute.get(route) ?? []), symbol]);
  }
  state.batches = [...byRoute].flatMap(([route, group]) => chunks(group, BATCH_SIZE[route]).map((batch) => ({ route, symbols: batch })));
  state.phase = 'quotes';
}

/** Stores the quotes with their EOD rows; a failing write fails exactly these symbols. */
async function storeQuotes(ctx: StepContext, state: State, quotes: readonly Quote[]): Promise<void> {
  try {
    await ctx.repo.putQuotes(quotes);
    state.refreshed.push(...quotes.map((quote) => quote.symbol));
  } catch (error) {
    for (const quote of quotes) state.failed[quote.symbol] = errorMessage(error);
  }
}

async function runBatch(ctx: StepContext, state: State, batch: Batch, nowMs: number): Promise<void> {
  try {
    const result = await ctx.md.provider.getQuotes(batch.symbols);
    state.skipped.push(...result.unavailable);
    for (const failure of result.failed) state.failed[failure.symbol] = failure.error;
    const quotes = Object.values(result.quotes);
    if (quotes.length > 0) await storeQuotes(ctx, state, quotes);
  } catch (error) {
    rethrowBudget(error);
    ctx.logger.error('quote fetch crashed', { error: errorMessage(error) });
    for (const symbol of batch.symbols) state.failed[symbol] = errorMessage(error);
  }
  state.batches.splice(state.batches.indexOf(batch), 1);
  if (batch.route === 'us') state.readyAt[SOURCE_OF.us] = nowMs + Math.ceil((batch.symbols.length * 60_000) / TWELVEDATA_CREDITS_PER_MINUTE);
}

/** The pending batches whose provider is ready (Twelve Data allows 8 credits a minute, so its batches are spaced). */
function* readyBatches(ctx: StepContext, state: State): Generator<Batch, void, undefined> {
  while (ctx.affords(1)) {
    const next = state.batches.find((batch) => (state.readyAt[SOURCE_OF[batch.route]] ?? 0) <= ctx.deps.clock().getTime());
    if (next === undefined) return;
    yield next;
  }
}

/** Resolves the milliseconds to wait before the remaining batches can run (0: continue at once), or null when done. */
async function runQuotes(ctx: StepContext, state: State): Promise<number | null> {
  await runUnits(readyBatches(ctx, state), (batch) => runBatch(ctx, state, batch, ctx.deps.clock().getTime()));
  if (state.batches.length === 0) {
    state.phase = 'details';
    return null;
  }
  if (!ctx.affords(1)) return 0;
  const nowMs = ctx.deps.clock().getTime();
  return Math.max(0, Math.min(...state.batches.map((batch) => state.readyAt[SOURCE_OF[batch.route]] ?? 0)) - nowMs);
}

// --- profile details ---

/** Whether the provider can add anything to the stored profile: an exchange-listed symbol with a Trading 212 baseline has all its lookup returns. */
const worthAsking = (symbol: string, stored: InstrumentProfile): boolean => routeOf(symbol) !== 'listed' || sourceOf(stored) === 'minimal';

/** The profile to store for `symbol`: null when nothing is found (marked fetched), undefined to retry in a later run. */
async function lookupDetails(ctx: StepContext, symbol: string, today: string): Promise<InstrumentProfile | null | undefined> {
  try {
    return await ctx.md.provider.getProfile(symbol);
  } catch (error) {
    rethrowBudget(error);
    if (error instanceof SymbolNotFoundError) return null;
    if (error instanceof ProviderError && !error.retryable) return null;
    ctx.logger.warn('profile details unavailable; retrying later', { symbol, error: errorMessage(error) });
    // A provider limit is remembered by the provider's block; any other failure counts as a try of today.
    if (!(error instanceof RateLimitError)) await countProfileTry(ctx, symbol, today, errorMessage(error));
    return undefined;
  }
}

async function countProfileTry(ctx: StepContext, symbol: string, today: string, error: string): Promise<void> {
  const tries = (await ctx.repo.attemptsOn('profile', [symbol], today)).get(symbol)?.count ?? 0;
  await ctx.repo.putAttempts('profile', symbol, today, tries + 1, 'retry', error);
}

/** The stalest profiles whose provider is not limited and that were not tried too often today: one stuck symbol never blocks the others. */
async function pickDetails(ctx: StepContext, state: State, now: Date, today: string): Promise<string[]> {
  const stale = await ctx.repo.staleProfileDetails(state.symbols, addDays(today, -PROFILE_DETAILS_TTL_DAYS));
  if (stale.length === 0) return [];
  const [blocks, tries] = await Promise.all([ctx.repo.blockedProviders(PROFILE_PROVIDERS, now), ctx.repo.attemptsOn('profile', stale, today)]);
  return stale.filter((symbol) => !blocks.has(providerOf(symbol)) && (tries.get(symbol)?.count ?? 0) < MAX_PROFILE_TRIES_PER_DAY).slice(0, PROFILE_DETAILS_PER_RUN);
}

/** At most this many symbols are handed to one enrichment job. */
export const HEAL_MAX_SYMBOLS = 50;

/** Hands the tracked symbols that were never enriched (or whose history symbol is still to fetch) to an enrichment job, once a UTC day (it keeps the provider quota in check itself). */
async function healEnrichment(ctx: StepContext, state: State, today: string): Promise<void> {
  const enqueue = ctx.deps.enqueueEnrichment;
  if (enqueue === undefined || state.symbols.length === 0) return;
  try {
    if (await ctx.repo.healedOn(today)) return;
    const [enriched, overrides] = await Promise.all([ctx.repo.enrichedSymbols(state.symbols), ctx.repo.getHistorySymbols(state.symbols)]);
    // A history symbol the owner set that was never fetched (the save could not start it, or its tries ran out) is handed over too.
    const missing = state.symbols.filter((symbol) => (!enriched.has(symbol) || overrides.get(symbol)?.status === 'pending') && isMarketSymbol(symbol));
    if (missing.length === 0) return;
    await enqueue(missing.slice(0, HEAL_MAX_SYMBOLS));
    await ctx.repo.markHealed(today);
    ctx.logger.info('enrichment started for tracked symbols that have none', { symbols: missing.length });
  } catch (error) {
    ctx.logger.error('could not start the enrichment of tracked symbols', { error: errorMessage(error) });
  }
}

/** Fetches the provider profile (sector, country of the company, details) of the stalest tracked symbols, at most PROFILE_DETAILS_PER_RUN per run. */
async function runDetails(ctx: StepContext, state: State, now: Date): Promise<void> {
  const today = utcDay(now);
  if (state.detailQueue === null) {
    await healEnrichment(ctx, state, today);
    try {
      state.detailQueue = await pickDetails(ctx, state, now, today);
    } catch (error) {
      ctx.logger.error('profile details lookup failed', { error: errorMessage(error) });
      state.detailQueue = [];
    }
  }
  const queue = state.detailQueue;
  await runUnits(
    whileAffordable(queue, () => ctx.affords(PROFILE_CALLS)),
    async (symbol) => {
      const stored = await ctx.repo.getProfile(symbol);
      const profile = stored === undefined || worthAsking(symbol, stored) ? await lookupDetails(ctx, symbol, today) : null;
      if (profile !== undefined) {
        try {
          await ctx.repo.putProfileDetails(symbol, profile, today);
          state.detailsRefreshed += 1;
        } catch (error) {
          ctx.logger.error('profile details write failed', { symbol, error: errorMessage(error) });
        }
      }
      queue.shift();
    },
  );
  if (queue.length === 0) state.phase = 'repair';
}

/** The one-time repair of prices stored in pence: a few symbols per step until done (a no-op once its marker is set). */
async function runRepair(ctx: StepContext, state: State, now: Date): Promise<void> {
  if (await runMinorUnitRepair(ctx, state.repair, state.symbols, now)) state.phase = 'done';
}

// --- the job ---

function summarize(state: State): ScheduledRefreshSummary {
  return {
    refreshed: state.refreshed.length,
    skipped: state.skipped.length,
    failed: Object.keys(state.failed).length,
    fxUpdated: state.fx.ok,
    fxDaysWritten: state.history.written,
    fxHistoryOk: state.history.ok,
    profileDetailsRefreshed: state.detailsRefreshed,
    // Nothing consumes `PricesUpdated` on the portable platforms; the Python service still publishes it on AWS.
    eventPublished: false,
    euWindow: state.euWindow,
    failedSymbols: Object.keys(state.failed).toSorted(byText),
    skippedSymbols: state.skipped.toSorted(byText),
  };
}

/** Runs the phases of `state` until one is unfinished (budget or pacing) or all are done. Resolves the pause to apply. */
async function advance(ctx: StepContext, state: State, now: Date): Promise<number | null> {
  let pause: number | null = null;
  if (state.phase === 'fx') await runFx(ctx, state, now);
  if (state.phase === 'history') await runHistory(ctx, state);
  if (state.phase === 'plan') await planQuotes(ctx, state, now);
  if (state.phase === 'quotes') pause = await runQuotes(ctx, state);
  if (state.phase === 'details') await runDetails(ctx, state, now);
  if (state.phase === 'repair') await runRepair(ctx, state, now);
  return pause;
}

export type RefreshPricesJob = JobHandler<JobPayloads['refreshPrices'], ScheduledRefreshSummary>;

export function createRefreshPricesJob(deps: PriceJobDeps): RefreshPricesJob {
  return async ({ cursor }) => {
    const ctx = createStepContext(deps);
    const state = cursor === undefined ? initialState(deps.clock(), await ctx.repo.listTracked()) : decodeState(stateSchema, cursor);
    return runStep(ctx, state, async () => {
      const delay = await advance(ctx, state, new Date(state.now));
      if (state.phase === 'done') return { done: true, result: summarize(state) };
      return pendingStep(state, delay ?? undefined);
    });
  };
}
