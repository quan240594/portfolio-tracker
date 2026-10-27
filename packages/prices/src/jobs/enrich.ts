import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { alignEodScale, isMarketSymbol, sourceOf } from '@portfolio/shared';
import type { EnrichmentSummary, JobHandler, JobPayloads } from '@portfolio/platform';
import { z } from 'zod';
import { errorMessage, ProviderError, ProviderUnavailableError, RateLimitError, SymbolNotFoundError } from '../errors.js';
import { endOfUtcDay, RESET_MARGIN_MS } from '../limits.js';
import { byText } from '../parse.js';
import { isCrypto, minimalProfile, normalizeSymbol, providerOf, routeOf } from '../symbols.js';
import { addDays, utcDay } from '../time.js';
import type { AttemptKind, AttemptOutcome, Attempts } from '../repository.js';
import { overrideHistory } from './history-override.js';
import { proxyHistory } from './proxy-listing.js';
import { createStepContext, pendingStep, rethrowBudget, runStep, runUnits, type PriceJobDeps, type StepContext } from './common.js';

export const HISTORY_DAYS = 365;
export const DIVIDEND_LOOKBACK_DAYS = 730;
export const DIVIDEND_LOOKAHEAD_DAYS = 365;
/** A symbol is tried at most this many times a UTC day, whatever job asks (a rate-limit wait is not a try). */
export const MAX_ATTEMPTS_PER_DAY = 3;
/** A job that still has symbols left after this many days stops and reports them in `retry`. */
export const MAX_ENRICH_DAYS = 3;
const RETRY_PAUSE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The longest a job sleeps in one step: a daily limit resets within a day (plus the margin). */
const MAX_DEFER_MS = DAY_MS + 2 * RESET_MARGIN_MS;
/** A pause after a limit that did not name its reset (a client-side wait names its own). */
const DEFAULT_LIMIT_PAUSE_MS = 60_000;
/** history, up to three profile calls, quote. */
const CORE_CALLS = 5;
/** The history under the owner's history symbol. */
const OVERRIDE_CALLS = 1;

const stateSchema = z.object({
  v: z.literal(2),
  now: z.string(),
  total: z.number(),
  already: z.number(),
  /** Symbols whose history, profile and quote are still to store. */
  pending: z.array(z.string()),
  /** Enriched symbols whose history is still to fetch under the symbol the owner set (held symbol -> history symbol). */
  overrides: z.record(z.string()).default({}),
  /** Symbols whose dividends are still to fetch: they only use what is left of the provider quota after every history. */
  dividends: z.array(z.string()),
  enriched: z.array(z.string()),
  /** Symbols given up on for this job (the job's time ran out). */
  retry: z.array(z.string()),
  /** Epoch milliseconds before which a symbol must not start (its retry pause, or the next day after its tries ran out). */
  until: z.record(z.number()),
  /** Epoch milliseconds before which nothing may be asked of a provider (it said its limit is reached). */
  blocked: z.record(z.number()),
  /** Tries of `attemptsDay` per symbol, mirrored in the store so other jobs count them too. */
  attempts: z.record(z.number()),
  attemptsDay: z.string(),
});

/** The first version of the state (rounds and a pause per US symbol): a job that was waiting when this code was deployed continues as v2. */
const legacySchema = z.object({ v: z.literal(1), now: z.string(), total: z.number(), already: z.number(), pending: z.array(z.string()), enriched: z.array(z.string()), failedNow: z.array(z.string()) });

type State = z.infer<typeof stateSchema>;
interface Unit {
  kind: 'core' | 'override' | 'dividends';
  symbol: string;
}

function decode(cursor: string): State {
  const raw: unknown = JSON.parse(cursor);
  const legacy = legacySchema.safeParse(raw);
  if (!legacy.success) return stateSchema.parse(raw);
  const { v: _v, failedNow, ...rest } = legacy.data;
  return { ...rest, v: 2, pending: [...rest.pending, ...failedNow], overrides: {}, dividends: [], retry: [], until: {}, blocked: {}, attempts: {}, attemptsDay: utcDay(new Date(rest.now)) };
}

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

/** The provider's profile, or null: it is the one optional part of an enrichment, so a limit or an outage leaves it to the details refresh. */
async function providerProfile(ctx: StepContext, symbol: string, stored: InstrumentProfile | undefined): Promise<InstrumentProfile | null> {
  // A Trading 212 baseline already has what the exchange-listed lookup returns (name, type, ISIN): its call would only cost quota.
  if (stored !== undefined && sourceOf(stored) !== 'minimal' && routeOf(symbol) === 'listed') return null;
  try {
    return await orNull(ctx.md.provider.getProfile(symbol));
  } catch (error) {
    rethrowBudget(error);
    if (!(error instanceof ProviderError)) throw error;
    // A minute's credits are back in a minute: wait for them (the history is stored again then) instead of leaving the profile minimal.
    if (error instanceof RateLimitError && error.scope === 'minute') throw error;
    ctx.logger.info('profile left to the details refresh', { symbol, error: error.message });
    return null;
  }
}

/** A quote from the provider for a symbol that has none yet (the Trading 212 refresh usually stored one); a provider failure is a missing quote. */
async function providerQuote(ctx: StepContext, symbol: string): Promise<Quote | null> {
  const batch = await ctx.md.provider.getQuotes([symbol]);
  return batch.quotes[symbol] ?? null;
}

/**
 * The history of `symbol` and whether it comes from another listing: the provider's own, else the history of the symbol the owner set
 * (see `overrideHistory`), else (an exchange-listed symbol it does not know, and the owner did not name the held one) the history of
 * another listing of the same fund (see `proxyHistory`), else null.
 */
async function historyOf(ctx: StepContext, symbol: string, stored: InstrumentProfile | undefined, today: string): Promise<{ rows: EodPrice[]; proxy: boolean } | null> {
  const { provider } = ctx.md;
  const start = addDays(today, -HISTORY_DAYS);
  const own = await orNull(provider.getEodHistory(symbol, start, today));
  if (own !== null) return { rows: own, proxy: false };
  const chosen = await overrideHistory(ctx, symbol, stored, today);
  if (chosen.rows !== null) return { rows: chosen.rows, proxy: true };
  if (chosen.heldListing || routeOf(symbol) !== 'listed') return null;
  const proxy = await proxyHistory(ctx, symbol, stored, today, (listing) => orNull(provider.getEodHistory(listing, start, today)));
  return proxy === null ? null : { rows: proxy, proxy: true };
}

/** Fetches and stores the history, quote and profile of a new symbol. Resolves false for a symbol no provider knows. */
async function fetchAndStore(ctx: StepContext, symbol: string, now: Date): Promise<boolean> {
  const { provider } = ctx.md;
  const today = utcDay(now);
  const stored = await ctx.repo.getProfile(symbol);
  const found = await historyOf(ctx, symbol, stored, today);
  if (found === null) {
    ctx.logger.warn('unknown symbol; not enriching', { symbol });
    return false;
  }
  const { rows: history, proxy } = found;
  const profile = await providerProfile(ctx, symbol, stored);
  const existingQuote = (await ctx.repo.latestQuotes([symbol])).get(symbol);
  // The provider has no quote for a symbol it does not know: the history of the other listing stands in.
  const quote = existingQuote ?? (proxy ? null : await providerQuote(ctx, symbol)) ?? quoteFromHistory(symbol, history, provider.name);
  // The live quote of the broker settles the unit of an exchange-listed history (see `alignEodScale`).
  await ctx.repo.putEods(alignEodScale(history, existingQuote));
  if (existingQuote === undefined && quote !== null) await ctx.repo.putQuote(quote);
  await ctx.repo.ensureTracked(symbol, now.toISOString());
  await ctx.repo.putEnrichedProfile(symbol, profile, minimalProfile(symbol), today);
  ctx.logger.info('symbol enriched', { symbol, eod: history.length, quote: quote !== null, profile: profile !== null, proxy });
  return true;
}

/** Epoch milliseconds a rate limit holds a provider until: its own reset, else the wait it named, else a minute. */
function limitResume(error: RateLimitError, nowMs: number): number {
  return Math.max(error.resetAtMs ?? nowMs + (error.retryAfterMs ?? DEFAULT_LIMIT_PAUSE_MS), nowMs + 1000);
}

/** One symbol's unit of work in a job: what a failure needs to record and where the symbol is settled. */
interface UnitRun {
  ctx: StepContext;
  state: State;
  symbol: string;
  nowMs: number;
  kind: Extract<AttemptKind, 'core' | 'override'>;
  /** The market-data provider the unit asks (its limit holds the unit). */
  provider: string;
  /** Takes the symbol off the job's list for this unit. */
  settle: () => void;
}

/** Counts a try of today (kept in the store too) and sets the symbol's next start: a growing pause, or tomorrow once the tries are used up. */
async function countAttempt(run: Readonly<UnitRun>, outcome: AttemptOutcome, error: string): Promise<void> {
  const { ctx, state, symbol, nowMs } = run;
  const attempts = (state.attempts[symbol] ?? 0) + 1;
  state.attempts[symbol] = attempts;
  await ctx.repo.putAttempts(run.kind, symbol, state.attemptsDay, attempts, outcome, error);
  state.until[symbol] = attempts >= MAX_ATTEMPTS_PER_DAY ? endOfUtcDay(state.attemptsDay) + RESET_MARGIN_MS : nowMs + RETRY_PAUSE_MS * 2 ** (attempts - 1);
}

const finish = (list: string[], symbol: string): void => {
  list.splice(list.indexOf(symbol), 1);
};

/** A rate limit holds the provider (and with it every symbol that needs it) without costing a try; a symbol no provider serves is skipped; any other failure is a try. */
async function failUnit(run: Readonly<UnitRun>, error: unknown): Promise<void> {
  rethrowBudget(error);
  const { ctx, state, symbol, nowMs } = run;
  if (error instanceof RateLimitError) {
    const provider = error.provider === '' ? run.provider : error.provider;
    state.blocked[provider] = Math.max(state.blocked[provider] ?? 0, limitResume(error, nowMs));
    ctx.logger.info('provider limit; waiting for its reset', { provider, resumeAt: new Date(state.blocked[provider]!).toISOString() });
  } else if (error instanceof ProviderUnavailableError || (error instanceof ProviderError && !error.retryable)) {
    ctx.logger.warn('no data for symbol; skipping', { symbol, error: error.message });
    await countAttempt(run, 'skipped', error.message);
    run.settle();
  } else {
    ctx.logger.warn('retryable enrichment failure', { symbol, error: errorMessage(error) });
    await countAttempt(run, 'retry', errorMessage(error));
  }
}

/** One symbol's core work. */
async function enrichSymbol(ctx: StepContext, state: State, symbol: string, now: Date, nowMs: number): Promise<void> {
  const run: UnitRun = { ctx, state, symbol, nowMs, kind: 'core', provider: providerOf(symbol), settle: () => finish(state.pending, symbol) };
  try {
    if (await fetchAndStore(ctx, symbol, now)) {
      state.enriched.push(symbol);
      if (!isCrypto(symbol)) state.dividends.push(symbol);
    } else {
      await countAttempt(run, 'skipped', 'unknown symbol');
    }
    run.settle();
  } catch (error) {
    await failUnit(run, error);
  }
}

/**
 * The history of an already enriched symbol under the symbol the owner set (the history only: quotes and the live price stay with the
 * broker, dividends with the symbol's own provider). What became of it is recorded on the override item.
 */
async function enrichOverride(ctx: StepContext, state: State, symbol: string, now: Date, nowMs: number): Promise<void> {
  const historySymbol = state.overrides[symbol]!;
  const run: UnitRun = { ctx, state, symbol, nowMs, kind: 'override', provider: providerOf(historySymbol), settle: () => forget(state, symbol) };
  try {
    const { rows } = await overrideHistory(ctx, symbol, await ctx.repo.getProfile(symbol), utcDay(now));
    if (rows !== null && rows.length > 0) {
      const quote = (await ctx.repo.latestQuotes([symbol])).get(symbol);
      await ctx.repo.putEods(alignEodScale(rows, quote));
      state.enriched.push(symbol);
    }
    run.settle();
  } catch (error) {
    await failUnit(run, error);
  }
}

function fetchDividends(ctx: StepContext, symbol: string, now: Date): Promise<DividendEvent[]> {
  const today = utcDay(now);
  return ctx.md.provider.getDividends(symbol, addDays(today, -DIVIDEND_LOOKBACK_DAYS), addDays(today, DIVIDEND_LOOKAHEAD_DAYS));
}

/** Dividends are the nice-to-have of an enrichment: the calendar refresh stores them later when the provider's quota ran out. */
async function storeDividends(ctx: StepContext, state: State, symbol: string, now: Date): Promise<void> {
  try {
    await ctx.repo.putDividends(await fetchDividends(ctx, symbol, now));
  } catch (error) {
    rethrowBudget(error);
    if (error instanceof RateLimitError) {
      ctx.logger.info('dividends left to the calendar refresh: provider limit', { symbol, error: error.message });
      state.dividends.length = 0;
      return;
    }
    ctx.logger.warn('dividends unavailable', { symbol, error: errorMessage(error) });
  }
  finish(state.dividends, symbol);
}

const forget = (state: State, symbol: string): void => {
  delete state.overrides[symbol];
};

function summarize(state: State): EnrichmentSummary {
  return { symbols: state.total, alreadyEnriched: state.already, enriched: state.enriched.toSorted(byText), retry: state.retry.toSorted(byText) };
}

/** The symbols whose tries of today are used up: those that were skipped all day are dropped (not worth a wait), the others wait for tomorrow. */
function exhaustedOf(attempts: ReadonlyMap<string, Attempts>, day: string): { dropped: Set<string>; until: Record<string, number> } {
  const exhausted = [...attempts].filter(([, tries]) => tries.count >= MAX_ATTEMPTS_PER_DAY);
  const dropped = new Set(exhausted.filter(([, tries]) => tries.skipped).map(([symbol]) => symbol));
  return { dropped, until: Object.fromEntries(exhausted.filter(([symbol]) => !dropped.has(symbol)).map(([symbol]) => [symbol, endOfUtcDay(day) + RESET_MARGIN_MS])) };
}

const countsOf = (attempts: ReadonlyMap<string, Attempts>): Record<string, number> => Object.fromEntries([...attempts].map(([symbol, tries]) => [symbol, tries.count]));

/** The enriched symbols whose owner-set history symbol is still to fetch (the not yet enriched ones fetch it as part of their enrichment). */
async function wantedOverrides(ctx: StepContext, candidates: readonly string[], day: string): Promise<{ overrides: Record<string, string>; attempts: Map<string, Attempts> }> {
  const records = await ctx.repo.getHistorySymbols(candidates);
  const waiting = candidates.filter((symbol) => records.get(symbol)?.status === 'pending');
  const attempts = await ctx.repo.attemptsOn('override', waiting, day);
  const { dropped } = exhaustedOf(attempts, day);
  return { overrides: Object.fromEntries(waiting.filter((symbol) => !dropped.has(symbol)).map((symbol) => [symbol, records.get(symbol)!.historySymbol])), attempts };
}

async function begin(ctx: StepContext, symbols: readonly string[], now: Date): Promise<State> {
  const unique = enrichmentSymbols(symbols);
  const enriched = await ctx.repo.enrichedSymbols(unique);
  const pending = unique.filter((symbol) => !enriched.has(symbol));
  const day = utcDay(now);
  const attempts = await ctx.repo.attemptsOn('core', pending, day);
  const { dropped, until } = exhaustedOf(attempts, day);
  const override = await wantedOverrides(ctx, [...enriched], day);
  return {
    v: 2,
    now: now.toISOString(),
    total: unique.length,
    already: enriched.size,
    pending: pending.filter((symbol) => !dropped.has(symbol)),
    overrides: override.overrides,
    dividends: [],
    enriched: [],
    retry: [],
    until: { ...until, ...exhaustedOf(override.attempts, day).until },
    blocked: {},
    attempts: { ...countsOf(attempts), ...countsOf(override.attempts) },
    attemptsDay: day,
  };
}

/** A new UTC day starts every symbol's tries from zero; a job that outlived its time gives its symbols up. */
function rollOver(state: State, nowMs: number): void {
  const today = utcDay(new Date(nowMs));
  if (state.attemptsDay !== today) {
    state.attemptsDay = today;
    state.attempts = {};
  }
  if (nowMs - Date.parse(state.now) > MAX_ENRICH_DAYS * DAY_MS) {
    state.retry.push(...state.pending, ...Object.keys(state.overrides));
    state.pending.length = 0;
    state.overrides = {};
    state.dividends.length = 0;
  }
}

const readyAt = (state: State, symbol: string): number => Math.max(state.until[symbol] ?? 0, state.blocked[providerOf(symbol)] ?? 0);
const overrideReadyAt = (state: State, symbol: string): number => Math.max(state.until[symbol] ?? 0, state.blocked[providerOf(state.overrides[symbol]!)] ?? 0);

/** The next unit that may start now: a core unit first (they need the quota the dividends would spend), then the history of an owner-set symbol, then a dividend one. */
function nextUnit(state: State, nowMs: number): Unit | undefined {
  const core = state.pending.find((symbol) => readyAt(state, symbol) <= nowMs);
  if (core !== undefined) return { kind: 'core', symbol: core };
  const override = Object.keys(state.overrides).find((symbol) => overrideReadyAt(state, symbol) <= nowMs);
  if (override !== undefined) return { kind: 'override', symbol: override };
  const symbol = state.dividends[0];
  return symbol !== undefined && (state.blocked.eodhd ?? 0) <= nowMs ? { kind: 'dividends', symbol } : undefined;
}

const CALLS: Readonly<Record<Unit['kind'], number>> = { core: CORE_CALLS, override: OVERRIDE_CALLS, dividends: 1 };

function* readyUnits(ctx: StepContext, state: State, nowMs: () => number): Generator<Unit, void, undefined> {
  for (let unit = nextUnit(state, nowMs()); unit !== undefined && ctx.hasCalls(CALLS[unit.kind]); unit = nextUnit(state, nowMs())) yield unit;
}

/** Dividends are not worth a day's wait: when only they are left and EODHD is limited, the calendar refresh gets them later. */
function dropBlockedDividends(state: State, nowMs: number): void {
  if (state.pending.length === 0 && (state.blocked.eodhd ?? 0) > nowMs) state.dividends.length = 0;
}

/** Milliseconds until the earliest remaining unit may start, or null when nothing is left. */
function waitUntilNext(state: State, nowMs: number): number | null {
  const starts = [...state.pending.map((symbol) => readyAt(state, symbol)), ...Object.keys(state.overrides).map((symbol) => overrideReadyAt(state, symbol)), ...(state.dividends.length > 0 ? [state.blocked.eodhd ?? 0] : [])];
  return starts.length === 0 ? null : Math.min(MAX_DEFER_MS, Math.max(0, Math.min(...starts) - nowMs));
}

function runUnit(ctx: StepContext, state: State, unit: Unit, now: Date, nowMs: number): Promise<void> {
  if (unit.kind === 'core') return enrichSymbol(ctx, state, unit.symbol, now, nowMs);
  if (unit.kind === 'override') return enrichOverride(ctx, state, unit.symbol, now, nowMs);
  return storeDividends(ctx, state, unit.symbol, now);
}

export type EnrichTransactionsJob = JobHandler<JobPayloads['enrichTransactions'], EnrichmentSummary>;

/**
 * `enrichTransactions`: history, quote and profile of every symbol whose enrichment is not finished, then (with the provider quota
 * that is left) its dividends. Idempotent and resumable: a few symbols per step. A provider whose limit is reached is not asked
 * again before the limit resets (persisted, so every later step and job knows): the job sleeps until then and the other symbols
 * carry on meanwhile. A symbol that fails is tried at most `MAX_ATTEMPTS_PER_DAY` times a day (persisted) with a growing pause.
 * What still is not done after `MAX_ENRICH_DAYS` is listed in `retry` of the result.
 */
export function createEnrichTransactionsJob(deps: PriceJobDeps): EnrichTransactionsJob {
  return async ({ payload, cursor }) => {
    const ctx = createStepContext(deps);
    const state = cursor === undefined ? await begin(ctx, payload.symbols, deps.clock()) : decode(cursor);
    const now = new Date(state.now);
    const nowMs = (): number => deps.clock().getTime();
    return runStep(ctx, state, async () => {
      rollOver(state, nowMs());
      await runUnits(readyUnits(ctx, state, nowMs), (unit) => runUnit(ctx, state, unit, now, nowMs()));
      dropBlockedDividends(state, nowMs());
      const wait = waitUntilNext(state, nowMs());
      return wait === null ? { done: true, result: summarize(state) } : pendingStep(state, wait);
    });
  };
}
