import { JOBS, logger, type JobHandler, type JobQueue } from '@portfolio/platform';
import { normalizeCurrency, type Quote, type SymbolMapping, type T212QuoteState, type T212QuoteStatus, type Trading212Credentials } from '@portfolio/shared';
import { z } from 'zod';
import type { HandlerResult } from './app.js';
import type { CredentialSource } from './credentials.js';
import { BrokerError, describeError } from './errors.js';
import { mergeQuote, resolvePrice, type EuroRates, type QuoteCandidate } from './quote-price.js';
import type { QuoteStore } from './quote-store.js';
import type { BrokerStore } from './store.js';
import { heldInstruments, refreshBaselines } from './baseline.js';
import type { ProfileStore } from './profile-store.js';
import { loadExchangeNames, resolveSymbols } from './symbols.js';
import type { Trading212Api } from './t212/client.js';
import type { OpenPosition, TradableInstrument } from './t212/schemas.js';

/**
 * The `refreshT212Quotes` job: Trading 212's own open positions as a keyless, near-live quote source. Per user with a connected
 * account it makes ONE positions request (plus, once per hour at most and only while some instrument cannot be mapped from its
 * ticker or ISIN, the rate-limited exchange metadata), maps every instrument to the app symbol with the importer's mapper, and
 * stores one quote per held symbol in ONE batched write. See docs/architecture.md "Trading 212 position quotes".
 */
const payloadSchema = z.object({ trigger: z.enum(['scheduled', 'sync']), userId: z.string().min(1).optional() });
export type RefreshQuotesPayload = z.infer<typeof payloadSchema>;

export interface QuoteDeps {
  store: Pick<BrokerStore, 'listUserIds' | 'listStates' | 'getFxRates'>;
  quotes: QuoteStore;
  /** Where the baseline profiles (name, type, ISIN, currency) of the held symbols are written; absent = no baseline. */
  profiles?: ProfileStore;
  credentials: CredentialSource;
  /** Needs `positions`, plus the exchange metadata when an instrument cannot be mapped without it. */
  createApi: (credentials: Trading212Credentials) => Pick<Trading212Api, 'positions' | 'instruments' | 'exchanges'>;
  symbolOverrides: Readonly<Record<string, string>>;
  now: () => Date;
}

export interface UserQuoteResult {
  userId: string;
  outcome: 'refreshed' | 'skipped' | 'failed';
  /** Why it was skipped (`not-connected`, `too-soon`, `backing-off`) or the failure state. */
  reason?: string;
  quoted: number;
  /** Positions that got no quote: not mapped, no price, or a newer quote is stored. */
  skipped: number;
  /** Baseline profiles written in this run (absent without a profile store). */
  profiles?: number;
}

export interface QuoteRunResult {
  results: UserQuoteResult[];
}

/** Trading 212 allows one positions request per second per account: runs closer together than this are not repeated. */
export const MIN_INTERVAL_MS = 30_000;
const METADATA_RETRY_MS = 60 * 60_000;
const MAX_TICKER_CACHE = 200;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Backoff {
  state: T212QuoteState;
  baseMs: number;
  capMs: number;
}

/** Credentials that do not work will not start working by themselves, so they are retried rarely; a rate limit clears quickly. */
const AUTH_BACKOFF: Backoff = { state: 'AUTH_REJECTED', baseMs: 6 * HOUR, capMs: 24 * HOUR };
const NO_CREDENTIALS_BACKOFF: Backoff = { state: 'NO_CREDENTIALS', baseMs: 6 * HOUR, capMs: 24 * HOUR };
const RATE_BACKOFF: Backoff = { state: 'RATE_LIMITED', baseMs: 5 * MINUTE, capMs: HOUR };
const ERROR_BACKOFF: Backoff = { state: 'ERROR', baseMs: 30 * MINUTE, capMs: 2 * HOUR };

function backoffFor(error: unknown): Backoff {
  if (!(error instanceof BrokerError)) return ERROR_BACKOFF;
  if (error.code === 'T212_AUTH_REJECTED') return AUTH_BACKOFF;
  if (error.code === 'NO_CREDENTIALS') return NO_CREDENTIALS_BACKOFF;
  return error.code === 'T212_RATE_LIMITED' ? RATE_BACKOFF : ERROR_BACKOFF;
}

const notRefreshed = (userId: string, outcome: 'skipped' | 'failed', reason: string): UserQuoteResult => ({ userId, outcome, reason, quoted: 0, skipped: 0 });

/** Why this run must not call Trading 212: too soon after the last attempt, or backing off after a failure (a fresh sync overrides that: it proved the credentials). */
function waitReason(status: T212QuoteStatus | null, trigger: RefreshQuotesPayload['trigger'], nowMs: number): string | undefined {
  if (!status) return undefined;
  if (nowMs - Date.parse(status.lastAttemptAt) < MIN_INTERVAL_MS) return 'too-soon';
  const retryAt = status.nextAttemptAt === undefined ? Number.NaN : Date.parse(status.nextAttemptAt);
  return trigger === 'scheduled' && nowMs < retryAt ? 'backing-off' : undefined;
}

/** A failure that is not about the credentials of this user (a store error, say) is not recorded as a quote failure: it is thrown to the queue. */
async function credentialsOf(deps: QuoteDeps, userId: string): Promise<Trading212Credentials | undefined> {
  try {
    return (await deps.credentials.get(userId)) ?? undefined;
  } catch (error) {
    if (error instanceof BrokerError) return undefined;
    throw error;
  }
}

/** Records a failed attempt and the time before which scheduled runs stay away. Never throws for an API failure. */
async function recordFailure(deps: QuoteDeps, userId: string, previous: T212QuoteStatus | null, error: unknown): Promise<UserQuoteResult> {
  const now = deps.now();
  const { state, baseMs, capMs } = backoffFor(error);
  const failures = (previous?.failures ?? 0) + 1;
  const waitMs = Math.min(capMs, baseMs * 2 ** (failures - 1));
  const lastError = error instanceof BrokerError ? describeError(error) : 'INTERNAL: The quote refresh failed unexpectedly';
  await deps.quotes.save([], {
    ...previous,
    userId,
    state,
    lastAttemptAt: now.toISOString(),
    failures,
    nextAttemptAt: new Date(now.getTime() + waitMs).toISOString(),
    lastError,
  });
  logger.warn('Trading 212 quote refresh failed', { state, failures, waitMs });
  return notRefreshed(userId, 'failed', state);
}

/** The instruments metadata of one run: one (large, rate-limited) request at most hourly, shared by the exchange mapping and the baseline profiles. */
interface InstrumentsLoader {
  /** The instruments, or none when they were requested within the hour already. */
  load(): Promise<TradableInstrument[]>;
  /** Whether a new request is allowed now. */
  allowed(): boolean;
  triedAt(): string | undefined;
}

function instrumentsLoader(api: Pick<Trading212Api, 'instruments'>, previous: T212QuoteStatus | null, nowMs: number): InstrumentsLoader {
  let triedAt = previous?.metadataTriedAt;
  let requested: Promise<TradableInstrument[]> | undefined;
  const allowed = (): boolean => triedAt === undefined || nowMs - Date.parse(triedAt) >= METADATA_RETRY_MS;
  return {
    allowed,
    triedAt: () => triedAt,
    load: () => {
      if (requested !== undefined) return requested;
      if (!allowed()) return Promise.resolve([]);
      triedAt = new Date(nowMs).toISOString();
      requested = api.instruments();
      return requested;
    },
  };
}

interface Mapped {
  symbols: Map<string, SymbolMapping>;
  /** Tickers resolved through the exchange metadata (or the cache of them), to reuse without loading it again. */
  cache: Record<string, string>;
}

/** Maps every held instrument with the importer's mapper; the exchange metadata is the (rate-limited) last resort, tried at most hourly. */
async function mapInstruments(deps: QuoteDeps, api: Pick<Trading212Api, 'instruments' | 'exchanges'>, items: readonly OpenPosition[], previous: T212QuoteStatus | null, instruments: InstrumentsLoader): Promise<Mapped> {
  const cached = previous?.tickerSymbols ?? {};
  const loadExchanges = async () => (instruments.allowed() ? loadExchangeNames(api, () => instruments.load()) : new Map<string, string>());
  const refs = items.map(({ instrument }) => ({ ticker: instrument.ticker, isin: instrument.isin, currency: instrument.currency }));
  const symbols = await resolveSymbols(refs, { ...cached, ...deps.symbolOverrides }, loadExchanges);
  const cache: Record<string, string> = {};
  for (const [ticker, mapping] of symbols) {
    if (mapping.ok && (mapping.via === 'exchange' || cached[ticker] === mapping.symbol)) cache[ticker] = mapping.symbol;
  }
  return { symbols, cache: Object.fromEntries(Object.entries(cache).slice(0, MAX_TICKER_CACHE)) };
}

/** Rates are only needed to check the scale of London prices, so they are only read when a position can need it. */
async function ratesFor(deps: QuoteDeps, items: readonly OpenPosition[]): Promise<EuroRates> {
  const london = items.some(({ instrument, walletImpact }) => walletImpact?.currentValue !== undefined && normalizeCurrency(instrument.currency).currency === 'GBP');
  return london ? deps.store.getFxRates() : {};
}

/** One candidate per held symbol: the first position of a symbol wins. */
function candidates(items: readonly OpenPosition[], mapped: Mapped, rates: EuroRates, asOf: string): QuoteCandidate[] {
  const bySymbol = new Map<string, QuoteCandidate>();
  for (const position of items) {
    const mapping = mapped.symbols.get(position.instrument.ticker);
    const price = mapping?.ok ? resolvePrice(position, rates) : undefined;
    if (mapping?.ok && price && !bySymbol.has(mapping.symbol)) bySymbol.set(mapping.symbol, { symbol: mapping.symbol, asOf, ...price });
  }
  return [...bySymbol.values()];
}

async function refreshUser(deps: QuoteDeps, userId: string, trigger: RefreshQuotesPayload['trigger']): Promise<UserQuoteResult> {
  if ((await deps.store.listStates(userId)).length === 0) return notRefreshed(userId, 'skipped', 'not-connected');
  const previous = await deps.quotes.getStatus(userId);
  const wait = waitReason(previous, trigger, deps.now().getTime());
  if (wait) return notRefreshed(userId, 'skipped', wait);
  const credentials = await credentialsOf(deps, userId);
  if (!credentials) return recordFailure(deps, userId, previous, new BrokerError('NO_CREDENTIALS', 'No usable Trading 212 credentials are stored; connect the broker again'));

  const api = deps.createApi(credentials);
  let items: OpenPosition[];
  try {
    ({ items } = await api.positions());
  } catch (error) {
    return recordFailure(deps, userId, previous, error);
  }
  const instruments = instrumentsLoader(api, previous, deps.now().getTime());
  const mapped = await mapInstruments(deps, api, items, previous, instruments);
  const asOf = deps.now().toISOString();
  const wanted = candidates(items, mapped, await ratesFor(deps, items), asOf);
  const stored = await deps.quotes.latest(wanted.map((candidate) => candidate.symbol));
  const quotes = wanted.map((candidate) => mergeQuote(candidate, stored.get(candidate.symbol))).filter((quote): quote is Quote => quote !== undefined);
  // Before the status is saved: loading the instruments records the time of the request in it.
  const baselines = deps.profiles === undefined ? undefined : await refreshBaselines(deps.profiles, heldInstruments(items, mapped.symbols), () => instruments.load());
  const { lastError: _lastError, nextAttemptAt: _nextAttemptAt, ...rest }: Partial<T212QuoteStatus> = previous ?? {};
  await deps.quotes.save(quotes, {
    ...rest,
    userId,
    state: 'OK',
    lastAttemptAt: asOf,
    lastSuccessAt: asOf,
    failures: 0,
    quoted: quotes.length,
    skipped: items.length - quotes.length,
    tickerSymbols: mapped.cache,
    ...(instruments.triedAt() === undefined ? {} : { metadataTriedAt: instruments.triedAt() }),
  });
  return { userId, outcome: 'refreshed', quoted: quotes.length, skipped: items.length - quotes.length, ...(baselines === undefined ? {} : { profiles: baselines }) };
}

interface RunCursor {
  users: string[];
  /** Index of the next user. */
  index: number;
  results: UserQuoteResult[];
}

/**
 * The job: `{trigger: 'scheduled'}` refreshes every user, `{trigger: 'sync', userId}` one user (right after a sync). A step handles
 * one user, so one invocation never makes more than the 3 subrequests of a single account. API failures are recorded in the status
 * item and end the user's turn, never the job; an invalid payload is thrown.
 */
export function refreshQuotesJob(getDeps: () => QuoteDeps): JobHandler<unknown, QuoteRunResult> {
  return async ({ payload, cursor }) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error('Ignoring invalid quote refresh payload');
      throw new Error('Invalid quote refresh payload');
    }
    const deps = getDeps();
    const run: RunCursor = cursor === undefined ? { users: parsed.data.userId ? [parsed.data.userId] : await deps.store.listUserIds(), index: 0, results: [] } : JSON.parse(cursor);
    const userId = run.users[run.index];
    if (userId === undefined) return { done: true, result: { results: run.results } };
    const results = [...run.results, await refreshUser(deps, userId, parsed.data.trigger)];
    const next: RunCursor = { ...run, index: run.index + 1, results };
    return next.index >= next.users.length ? { done: true, result: { results } } : { done: false, next: JSON.stringify(next) };
  };
}

/**
 * Runs a quote refresh right after a successful sync, so a manual sync prices the new positions immediately. Wraps the sync job:
 * the refresh is a separate job (its own step budget and guard check); a failure to enqueue it never fails the sync.
 */
export function refreshQuotesAfterSync<P>(handler: JobHandler<P, HandlerResult>, queue: JobQueue): JobHandler<P, HandlerResult> {
  return async (invocation) => {
    const step = await handler(invocation);
    if (step.done) {
      const users = [...new Set(step.result.results.filter((result) => result.status === 'SUCCEEDED' && !result.dryRun).map((result) => result.userId))];
      await Promise.all(
        users.map((userId) =>
          queue.enqueue({ job: JOBS.refreshT212Quotes, payload: { trigger: 'sync', userId } }).catch(() => logger.warn('Could not enqueue the quote refresh after a sync')),
        ),
      );
    }
    return step;
  };
}
