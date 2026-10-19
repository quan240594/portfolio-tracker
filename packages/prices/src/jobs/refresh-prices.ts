import type { JobHandler, JobPayloads, ScheduledRefreshSummary } from '@portfolio/platform';
import { z } from 'zod';
import type { InstrumentProfile, Quote } from '@portfolio/shared';
import { errorMessage, ProviderError, SymbolNotFoundError } from '../errors.js';
import { hasWeekday, yearChunks } from '../providers/frankfurter.js';
import { TWELVEDATA_CREDITS_PER_MINUTE, TWELVEDATA_MAX_BATCH } from '../providers/twelvedata.js';
import { EODHD_MAX_BATCH } from '../providers/eodhd.js';
import { COINGECKO_MAX_IDS } from '../providers/coingecko.js';
import { hasExchangeSuffix, routeOf, type Route } from '../symbols.js';
import { addDays, amsterdamHour, utcDay } from '../time.js';
import { byText, chunks } from '../parse.js';
import { createStepContext, decodeState, pendingStep, runStep, rethrowBudget, runUnits, whileAffordable, type PriceJobDeps, type StepContext } from './common.js';

/** Exchange-listed quotes older than this are refreshed outside the EU window. */
export const STALE_AFTER_MS = 24 * 3_600_000;
/** Optional company details are refreshed lazily: a few symbols per run, each at most once per TTL. */
export const PROFILE_DETAILS_TTL_DAYS = 30;
export const PROFILE_DETAILS_PER_RUN = 1;

/** Worst case of a profile lookup: Alpha Vantage, then Twelve Data's `/profile`, `/stocks` and `/etfs`. */
const PROFILE_CALLS = 4;

const BATCH_SIZE: Readonly<Record<Route, number>> = { us: TWELVEDATA_MAX_BATCH, listed: EODHD_MAX_BATCH, crypto: COINGECKO_MAX_IDS };
const SOURCE_OF: Readonly<Record<Route, string>> = { us: 'twelvedata', listed: 'eodhd', crypto: 'coingecko' };

const latestSchema = z.object({ base: z.string(), asOf: z.string(), date: z.string().optional(), rates: z.record(z.number()) });
const stateSchema = z.object({
  v: z.literal(1),
  now: z.string(),
  phase: z.enum(['fx', 'history', 'plan', 'quotes', 'details', 'done']),
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
    const stored = await ctx.repo.latestFxDay(base);
    const start = stored === null ? ctx.deps.config.fxHistoryStart : addDays(stored, 1);
    const today = utcDay(now);
    state.history = { ranges: start <= today ? yearChunks(start, today).filter(([lo, hi]) => hasWeekday(lo, hi)) : [], written: 0, ok: true, lastDay: stored, final: false };
  } catch (error) {
    ctx.logger.error('fx history plan failed', { error: errorMessage(error) });
    state.history = { ranges: [], written: 0, ok: false, lastDay: null, final: true };
  }
  state.phase = 'history';
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
  if (state.euWindow) due.push(...listed);
  else if (listed.length > 0) {
    const latest = await ctx.repo.latestQuotes(listed);
    for (const symbol of listed) {
      const quote = latest.get(symbol);
      const age = quote === undefined ? Number.NaN : now.getTime() - Date.parse(quote.asOf);
      if (quote === undefined || Number.isNaN(age) || age > STALE_AFTER_MS) due.push(symbol);
      else state.skipped.push(symbol);
    }
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

/** The profile to store for `symbol`: null when nothing is found (marked fetched), undefined to retry in a later run. */
async function lookupDetails(ctx: StepContext, symbol: string): Promise<InstrumentProfile | null | undefined> {
  try {
    return await ctx.md.provider.getProfile(symbol);
  } catch (error) {
    rethrowBudget(error);
    if (error instanceof SymbolNotFoundError) return null;
    if (error instanceof ProviderError && !error.retryable) return null;
    ctx.logger.warn('profile details unavailable; retrying later', { symbol, error: errorMessage(error) });
    return undefined;
  }
}

/** Fetches the optional company details of the stalest tracked symbols (at most PROFILE_DETAILS_PER_RUN per run). */
async function runDetails(ctx: StepContext, state: State, now: Date): Promise<void> {
  const today = utcDay(now);
  if (state.detailQueue === null) {
    try {
      const stale = await ctx.repo.staleProfileDetails(state.symbols, addDays(today, -PROFILE_DETAILS_TTL_DAYS));
      state.detailQueue = stale.slice(0, PROFILE_DETAILS_PER_RUN);
    } catch (error) {
      ctx.logger.error('profile details lookup failed', { error: errorMessage(error) });
      state.detailQueue = [];
    }
  }
  const queue = state.detailQueue;
  await runUnits(
    whileAffordable(queue, () => ctx.affords(PROFILE_CALLS)),
    async (symbol) => {
      const profile = await lookupDetails(ctx, symbol);
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
  if (queue.length === 0) state.phase = 'done';
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
