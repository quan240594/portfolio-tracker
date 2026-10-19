import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { isMarketSymbol } from '@portfolio/shared';
import type { EnrichmentSummary, JobHandler, JobPayloads } from '@portfolio/platform';
import { z } from 'zod';
import { errorMessage, ProviderError, ProviderUnavailableError, SymbolNotFoundError } from '../errors.js';
import { byText } from '../parse.js';
import { makeProfile } from '../models.js';
import { minimalProfile, normalizeSymbol, routeOf } from '../symbols.js';
import { addDays, utcDay } from '../time.js';
import { createStepContext, decodeState, pendingStep, rethrowBudget, runStep, runUnits, type PriceJobDeps, type StepContext } from './common.js';

export const HISTORY_DAYS = 365;
export const DIVIDEND_LOOKBACK_DAYS = 730;
export const DIVIDEND_LOOKAHEAD_DAYS = 365;
/** A symbol that failed transiently is tried again this many times in all (with a growing pause), like the Python queue's 3 receives. */
export const MAX_ENRICH_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 60_000;
/** Twelve Data allows 8 credits a minute: pause after a US symbol (profile, history and quote take 2 to 5 credits). */
const US_PAUSE_MS = 30_000;
/** profile (up to 4 calls), EOD history, dividends, quote. */
const SYMBOL_CALLS = 7;

const stateSchema = z.object({
  v: z.literal(1),
  now: z.string(),
  total: z.number(),
  already: z.number(),
  pending: z.array(z.string()),
  enriched: z.array(z.string()),
  /** Transient failures of the current round, tried again in the next one. */
  failedNow: z.array(z.string()),
  round: z.number(),
  /** Epoch milliseconds before which the next symbol must not start (provider pacing). */
  notBefore: z.number(),
});

type State = z.infer<typeof stateSchema>;
type Outcome = 'enriched' | 'skipped' | 'retry';

/** The symbols of a TransactionsChanged detail: trimmed, upper-cased, market symbols only, unique and sorted. */
export function enrichmentSymbols(symbols: readonly unknown[]): string[] {
  const clean = symbols.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(normalizeSymbol);
  return [...new Set(clean)].filter((symbol) => isMarketSymbol(symbol)).toSorted(byText);
}

/** The newest EOD row as a quote, for instruments whose provider has no quote endpoint answer. */
export function quoteFromHistory(symbol: string, history: readonly EodPrice[], source: string): Quote | null {
  const last = history.at(-1);
  if (last === undefined) return null;
  const previous = history.at(-2)?.close ?? last.close;
  return { symbol, price: last.close, previousClose: previous, currency: last.currency, asOf: `${last.date}T00:00:00.000Z`, source: `${source}-eod` };
}

const orNull = async <T>(call: Promise<T>): Promise<T | null> => {
  try {
    return await call;
  } catch (error) {
    if (error instanceof SymbolNotFoundError) return null;
    throw error;
  }
};

async function dividendsOrEmpty(ctx: StepContext, symbol: string, start: string, end: string): Promise<DividendEvent[]> {
  try {
    return await ctx.md.provider.getDividends(symbol, start, end);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.retryable) throw error;
    ctx.logger.warn('dividends unavailable', { symbol, error: error.message });
    return [];
  }
}

/** Fetches and stores everything for a new symbol. The PROFILE item is written last: it is the "enriched" marker. */
async function fetchAndStore(ctx: StepContext, symbol: string, now: Date): Promise<Outcome> {
  const { provider } = ctx.md;
  const today = utcDay(now);
  const profile: InstrumentProfile | null = await orNull(provider.getProfile(symbol));
  const history = await orNull(provider.getEodHistory(symbol, addDays(today, -HISTORY_DAYS), today));
  if (history === null) {
    ctx.logger.warn('unknown symbol; not enriching', { symbol });
    return 'skipped';
  }
  const dividends = await dividendsOrEmpty(ctx, symbol, addDays(today, -DIVIDEND_LOOKBACK_DAYS), addDays(today, DIVIDEND_LOOKAHEAD_DAYS));
  const batch = await provider.getQuotes([symbol]);
  if (batch.failed.some((failure) => failure.symbol === symbol && failure.retryable)) return 'retry';
  const quote = batch.quotes[symbol] ?? quoteFromHistory(symbol, history, provider.name);
  const stamped = profile === null ? minimalProfile(symbol) : makeProfile({ ...profile, detailsAsOf: today });
  await ctx.repo.putEods(history);
  await ctx.repo.putDividends(dividends);
  if (quote !== null) await ctx.repo.putQuote(quote);
  await ctx.repo.ensureTracked(symbol, now.toISOString());
  await ctx.repo.putProfile(stamped);
  ctx.logger.info('symbol enriched', { symbol, eod: history.length, dividends: dividends.length, quote: quote !== null });
  return 'enriched';
}

/** Never throws except for the step budget: transient failures are `retry`, the rest `skipped`. */
async function enrichSymbol(ctx: StepContext, symbol: string, now: Date): Promise<Outcome> {
  try {
    return await fetchAndStore(ctx, symbol, now);
  } catch (error) {
    rethrowBudget(error);
    if (error instanceof ProviderUnavailableError) {
      ctx.logger.warn('no provider for symbol; skipping', { symbol, error: error.message });
      return 'skipped';
    }
    if (error instanceof ProviderError && !error.retryable) {
      ctx.logger.warn('non-retryable provider error; skipping', { symbol, error: error.message });
      return 'skipped';
    }
    ctx.logger.warn('retryable enrichment failure', { symbol, error: errorMessage(error) });
    return 'retry';
  }
}

function summarize(state: State): EnrichmentSummary {
  return { symbols: state.total, alreadyEnriched: state.already, enriched: state.enriched.toSorted(byText), retry: state.failedNow.toSorted(byText) };
}

async function begin(ctx: StepContext, symbols: readonly string[], now: Date): Promise<State> {
  const unique = enrichmentSymbols(symbols);
  const existing = await ctx.repo.symbolsWithProfile(unique);
  return { v: 1, now: now.toISOString(), total: unique.length, already: existing.size, pending: unique.filter((s) => !existing.has(s)), enriched: [], failedNow: [], round: 1, notBefore: 0 };
}

/** Starts the next round with the transient failures after a pause, or reports that nothing is left (or no attempts are). */
function nextRound(state: State): number | null {
  if (state.failedNow.length === 0 || state.round >= MAX_ENRICH_ATTEMPTS) return null;
  const pause = RETRY_PAUSE_MS * 2 ** (state.round - 1);
  state.pending = state.failedNow;
  state.failedNow = [];
  state.round += 1;
  return pause;
}

export type EnrichTransactionsJob = JobHandler<JobPayloads['enrichTransactions'], EnrichmentSummary>;

/**
 * `enrichTransactions`: profile, one year of EOD history, dividends and the latest quote of every symbol that has no PROFILE
 * item yet. Idempotent (the PROFILE item is written last) and resumable: a few symbols per step, pausing for Twelve Data's
 * per-minute credits. Transient failures are tried again in up to `MAX_ENRICH_ATTEMPTS - 1` later rounds; what still fails
 * is listed in `retry` of the result.
 */
/** The pending symbols that may start now: Twelve Data's per-minute credits pace the US ones, the others never wait. */
function* readySymbols(ctx: StepContext, state: State, nowMs: () => number): Generator<string, void, undefined> {
  while (ctx.hasCalls(SYMBOL_CALLS)) {
    const next = state.pending.find((symbol) => routeOf(symbol) !== 'us' || nowMs() >= state.notBefore);
    if (next === undefined) return;
    yield next;
  }
}

export function createEnrichTransactionsJob(deps: PriceJobDeps): EnrichTransactionsJob {
  return async ({ payload, cursor }) => {
    const ctx = createStepContext(deps);
    const state = cursor === undefined ? await begin(ctx, payload.symbols, deps.clock()) : decodeState(stateSchema, cursor);
    const now = new Date(state.now);
    const nowMs = (): number => deps.clock().getTime();
    return runStep(ctx, state, async () => {
      await runUnits(readySymbols(ctx, state, nowMs), async (symbol) => {
        const outcome = await enrichSymbol(ctx, symbol, now);
        if (outcome === 'enriched') state.enriched.push(symbol);
        if (outcome === 'retry') state.failedNow.push(symbol);
        if (routeOf(symbol) === 'us') state.notBefore = nowMs() + US_PAUSE_MS;
        state.pending.splice(state.pending.indexOf(symbol), 1);
      });
      if (state.pending.length === 0) {
        const pause = nextRound(state);
        if (pause === null) return { done: true, result: summarize(state) };
        state.notBefore = nowMs() + pause;
      }
      return pendingStep(state, ctx.hasCalls(SYMBOL_CALLS) ? Math.max(0, state.notBefore - nowMs()) : 0);
    });
  };
}
