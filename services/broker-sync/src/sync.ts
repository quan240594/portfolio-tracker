import { logger, runToCompletion, type JobHandler, type JobStep } from '@portfolio/platform';
import {
  MAX_STATE_LIST,
  PortfolioError,
  T212_IMPORT_ID,
  buildPositions,
  type BrokerSyncCounts,
  type BrokerSyncState,
  type CashMovementCounts,
  type Transaction,
  type Trading212Credentials,
  type UnmappedInstrument,
} from '@portfolio/shared';
import type { CredentialSource } from './credentials.js';
import { BrokerError, describeError } from './errors.js';
import { reconcilePositions, type Reconciliation } from './reconcile.js';
import type { EventPublisher } from './events.js';
import { RateBook, SkipLog, mapDividend, mapOrder, mapSplits } from './mapper.js';
import type { BrokerStore } from './store.js';
import { loadExchangeNames, resolveSymbols } from './symbols.js';
import type { Page, Trading212Api } from './t212/client.js';
import type { CashTransaction, HistoricalOrder, HistoryDividend } from './t212/schemas.js';

/** Re-read window before the stored watermark, so late-booked items are never missed (re-writes are idempotent). */
export const OVERLAP_MS = 7 * 24 * 3600 * 1000;
/** A RUNNING state older than this is considered crashed and may be taken over. */
export const STALE_LOCK_MS = 15 * 60 * 1000;

export interface SyncDeps {
  store: BrokerStore;
  events: EventPublisher;
  credentials: CredentialSource;
  createApi: (credentials: Trading212Credentials) => Trading212Api;
  symbolOverrides: Readonly<Record<string, string>>;
  now: () => Date;
  /** How much work one step of the resumable sync may do (see `syncJob`); the defaults suit a 15-minute Lambda. */
  limits?: SyncLimits;
}

export interface SyncLimits {
  /** History pages fetched per step. A runtime with few subrequests per invocation lowers it. */
  pagesPerStep?: number;
  /** Transactions written per step. */
  writeChunk?: number;
}

export const DEFAULT_PAGES_PER_STEP = 10;
export const DEFAULT_WRITE_CHUNK = 250;

export interface SyncRequest {
  userId: string;
  portfolioId: string;
  /** Ignore the incremental watermarks and re-read the whole history. */
  full?: boolean;
  /** Fetch, map and validate, but write nothing (no transactions, no state, no event). */
  dryRun?: boolean;
  /** Also compare the resulting positions with the open positions Trading 212 reports (CLI verification). */
  reconcile?: boolean;
  /** CLI: create the connection state when it does not exist yet (the Lambda requires a connected state). */
  autoConnect?: { environment: BrokerSyncState['environment'] };
}

export interface SyncResult {
  userId: string;
  portfolioId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  dryRun: boolean;
  counts?: BrokerSyncCounts;
  /** Instruments / records that were skipped, with the reason. */
  unmapped: UnmappedInstrument[];
  warnings: string[];
  /** Account currency reported by Trading 212. */
  accountCurrency?: string;
  /** Symbols of the transactions that were (or, in a dry run, would be) written, with their counts. */
  symbols: Record<string, number>;
  reconciliation?: Reconciliation;
  error?: string;
}

/** What has been read of one newest-first history so far; part of the sync cursor, so it is plain JSON. */
interface Progress<T> {
  items: T[];
  invalid: number;
  /** Newest timestamp (ms) among the items. */
  newest?: number;
  /** Whether every page so far was newest-first. */
  descending: boolean;
  /** Where the next step continues (`nextPagePath` of Trading 212); undefined at the start. */
  next?: string;
  done: boolean;
}

const freshProgress = <T>(): Progress<T> => ({ items: [], invalid: 0, descending: true, done: false });

/**
 * Reads up to `budget` more pages of a newest-first history. With a cutoff, stops after the first page whose timed
 * items are all older than it. Pages that do not look newest-first are read completely, so an unexpected order can
 * never hide new data. A history that cannot be resumed (no `next` link on a page) is read to its end in this step.
 */
async function collectChunk<T>(
  open: (from: string | undefined) => AsyncGenerator<Page<T>, void, undefined>,
  progress: Progress<T>,
  timeOf: (item: T) => number | undefined,
  cutoff: number | undefined,
  budget: number,
): Promise<Progress<T>> {
  const out: Progress<T> = { ...progress, items: [...progress.items] };
  let fetched = 0;
  for await (const page of open(progress.next)) {
    out.items.push(...page.items);
    out.invalid += page.invalid;
    const times = page.items.map(timeOf).filter((t): t is number => t !== undefined && !Number.isNaN(t));
    if (times.length > 0) {
      out.newest = Math.max(out.newest ?? -Infinity, ...times);
      if (times[0]! < times.at(-1)!) out.descending = false;
    }
    if (times.length > 0 && out.descending && cutoff !== undefined && Math.max(...times) < cutoff) break;
    if (++fetched >= budget && page.next !== undefined) {
      out.next = page.next;
      return out;
    }
  }
  return { ...out, next: undefined, done: true };
}

const emptyCash = (): CashMovementCounts => ({ deposits: 0, withdrawals: 0, fees: 0, interest: 0, other: 0 });

export function countCash(items: readonly CashTransaction[]): CashMovementCounts {
  const counts = emptyCash();
  for (const { type } of items) {
    if (type === 'DEPOSIT') counts.deposits++;
    else if (type === 'WITHDRAW') counts.withdrawals++;
    else if (type === 'FEE') counts.fees++;
    else if (type === 'INTEREST_ON_FREE_CASH' || type === 'LENDING_INTEREST') counts.interest++;
    else counts.other++;
  }
  return counts;
}

async function collectCash(api: Trading212Api, progress: Progress<CashTransaction>, cutoff: number | undefined, budget: number, warnings: string[]) {
  try {
    return await collectChunk((from) => api.historyTransactions(from), progress, (t) => Date.parse(t.dateTime), cutoff, budget);
  } catch (err) {
    // Cash movements are only counted; a key without the transactions scope must not block the sync.
    if (!(err instanceof BrokerError) || err.code !== 'T212_AUTH_REJECTED') throw err;
    warnings.push('Cash history unavailable: the key lacks the history:transactions scope');
    return { ...freshProgress<CashTransaction>(), done: true };
  }
}

const cutoffOf = (cursor: string | undefined, full: boolean | undefined): number | undefined => {
  const ms = cursor && !full ? Date.parse(cursor) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms - OVERLAP_MS;
};

const maxIso = (previous: string | undefined, newest: number | undefined): string | undefined => {
  if (newest === undefined) return previous;
  const candidate = new Date(newest).toISOString();
  return previous && previous > candidate ? previous : candidate;
};

type Cursors = NonNullable<BrokerSyncState['cursors']>;

/** Watermarks only ever move forward. */
function nextCursors(previous: Cursors, newest: Record<keyof Cursors, number | undefined>): Cursors {
  const next: Cursors = {};
  for (const source of ['orders', 'dividends', 'cash'] as const) {
    const value = maxIso(previous[source], newest[source]);
    if (value !== undefined) next[source] = value;
  }
  return next;
}

const sameTransaction = (a: Transaction | undefined, b: Transaction): boolean => {
  if (!a) return false;
  const keysOf = (t: Transaction) => Object.keys(t).sort((x, y) => x.localeCompare(y));
  const ka = keysOf(a);
  const kb = keysOf(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && Object.is(a[k as keyof Transaction], b[k as keyof Transaction]));
};

/** The stored transactions that the synced ones do not replace. */
const withoutSynced = (existing: readonly Transaction[], synced: readonly Transaction[], portfolioId: string): Transaction[] => {
  const syncedIds = new Set(synced.map((t) => t.id));
  return existing.filter((t) => !(t.portfolioId === portfolioId && syncedIds.has(t.id)));
};

/**
 * Validates the stored transactions of the user plus the synced ones: one currency per symbol across all portfolios,
 * and no oversell in the target portfolio. Throws a BrokerError (nothing is written) otherwise.
 */
export function validateMerged(existing: readonly Transaction[], synced: readonly Transaction[], portfolioId: string, hint: string): void {
  const kept = withoutSynced(existing, synced, portfolioId);
  const currencies = new Map<string, string>();
  for (const t of [...kept, ...synced]) {
    const known = currencies.get(t.symbol);
    if (known === undefined) currencies.set(t.symbol, t.currency);
    else if (known !== t.currency) throw new BrokerError('VALIDATION_FAILED', `Mixed currencies for ${t.symbol}: ${known} and ${t.currency}`);
  }
  try {
    buildPositions([...kept.filter((t) => t.portfolioId === portfolioId), ...synced]);
  } catch (err) {
    if (err instanceof PortfolioError) throw new BrokerError('VALIDATION_FAILED', `${err.message}${hint}`);
    throw err;
  }
}

/** FX rates observed on already imported orders, so a dividend gets the same rate whatever window was fetched. */
function seedRates(rates: RateBook, existing: readonly Transaction[], portfolioId: string): void {
  for (const t of existing) {
    if (t.portfolioId === portfolioId && t.importId === T212_IMPORT_ID && t.type !== 'DIVIDEND' && t.fxRate) {
      rates.add(t.currency, Date.parse(t.createdAt), t.fxRate);
    }
  }
}


interface Outcome {
  counts: BrokerSyncCounts;
  unmapped: UnmappedInstrument[];
  warnings: string[];
  symbols: Record<string, number>;
  cursors: Cursors;
  accountCurrency: string;
  reconciliation?: Reconciliation;
}

// ---------------------------------------------------------------------------------------------------------------------
// The sync as resumable steps. One run is a chain of small steps; the cursor each step returns holds everything the
// next one needs (the connection state, what was read so far, what is left to write), so a runtime with a tiny
// per-invocation budget can persist it and call the next step later, and a crashed step is simply run again:
//   lock -> account -> orders -> dividends -> cash -> prepare -> write -> announce -> finish
// Reads are side-effect free, writes are idempotent (deterministic keys), `registerUser`/`trackTickers` are upserts
// and a duplicate TransactionsChanged event is harmless, so repeating any step cannot change the result.
// ---------------------------------------------------------------------------------------------------------------------

type Phase = 'lock' | 'account' | 'orders' | 'dividends' | 'cash' | 'prepare' | 'write' | 'announce' | 'finish';

/** The result of the `prepare` step: what to write and everything the final state needs. */
interface Prepared {
  /** Transactions still to write (emptied once written). */
  changed: Transaction[];
  changedCount: number;
  tickers: { symbol: string; currency: string }[];
  counts: BrokerSyncCounts;
  unmapped: UnmappedInstrument[];
  symbols: Record<string, number>;
  cursors: Cursors;
  reconciliation?: Reconciliation;
}

/** Continuation of one sync (JSON). */
interface SyncCursor {
  phase: Phase;
  /** The connection state as read when the run began. */
  state: BrokerSyncState;
  startedAt: string;
  /** Identifies this run in the lock, so a redelivered `lock` step can take the lock again. */
  runId: string;
  warnings: string[];
  accountCurrency?: string;
  orders: Progress<HistoricalOrder>;
  dividends: Progress<HistoryDividend>;
  cash: Progress<CashTransaction>;
  prepared?: Prepared;
  /** How many of `prepared.changed` have been written. */
  written: number;
}

type Advance = { cursor: SyncCursor } | { result: SyncResult };

const encode = (cursor: unknown): string => JSON.stringify(cursor);

async function openApi(deps: SyncDeps, userId: string): Promise<Trading212Api> {
  const credentials = await deps.credentials.get(userId);
  if (!credentials) throw new BrokerError('NO_CREDENTIALS', 'No Trading 212 credentials are stored for this user; connect the broker first');
  return deps.createApi(credentials);
}

/** Maps the raw histories to transactions (orders, splits, dividends), oldest first. */
async function mapHistories(deps: SyncDeps, run: SyncCursor, api: Trading212Api, existing: readonly Transaction[]) {
  const { state, orders, dividends } = run;
  const refs = [...orders.items.map((o) => o.order.instrument), ...dividends.items.map((d) => d.instrument)].map((i) => ({
    ticker: i.ticker,
    isin: i.isin,
    currency: i.currency,
  }));
  const symbols = await resolveSymbols(refs, deps.symbolOverrides, () => loadExchangeNames(api));
  const ctx = { userId: state.userId, portfolioId: state.portfolioId, symbols, skipped: new SkipLog() };

  const rates = new RateBook();
  seedRates(rates, existing, state.portfolioId);
  const transactions: Transaction[] = [];
  for (const item of orders.items) {
    const mapped = mapOrder(item, ctx);
    if (!mapped) continue;
    transactions.push(mapped.transaction);
    if (mapped.rate) rates.add(mapped.rate.currency, mapped.rate.at, mapped.rate.value);
  }
  transactions.push(...mapSplits(orders.items, ctx));
  const fallbackRates = dividends.items.length > 0 ? await deps.store.getFxRates().catch(() => ({})) : {};
  for (const item of dividends.items) {
    const mapped = mapDividend(item, { ...ctx, rates, fallbackRates });
    if (mapped) transactions.push(mapped);
  }
  transactions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { transactions, skipped: ctx.skipped };
}

/** Maps the raw histories to transactions, validates them against the stored ones and works out what changed. */
async function prepare(deps: SyncDeps, req: SyncRequest, run: SyncCursor, api: Trading212Api): Promise<Prepared> {
  const { state, orders, dividends, cash } = run;
  const existing = await deps.store.listTransactions(req.userId);
  const { transactions, skipped } = await mapHistories(deps, run, api, existing);

  const invalid = orders.invalid + dividends.invalid + cash.invalid;
  if (invalid > 0) run.warnings.push(`${invalid} Trading 212 record(s) had an unexpected shape and were skipped`);
  const counts: BrokerSyncCounts = {
    orders: orders.items.filter((o) => o.fill).length,
    dividends: dividends.items.length,
    written: 0,
    skipped: skipped.total + invalid,
    cashMovements: countCash(cash.items),
  };

  const hint = skipped.list().some((s) => s.reason.startsWith('UNSUPPORTED_FILL_'))
    ? ' (corporate-action fills such as stock splits are not imported, which can make later sells exceed the position)'
    : ' (check that no other import already contains the same Trading 212 trades in this portfolio)';
  validateMerged(existing, transactions, req.portfolioId, hint);

  const reconciliation = req.reconcile
    ? await reconcilePositions(
        api,
        [...withoutSynced(existing, transactions, req.portfolioId).filter((t) => t.portfolioId === req.portfolioId), ...transactions],
        deps.symbolOverrides,
        () => loadExchangeNames(api),
      )
    : undefined;

  const stored = new Map(existing.filter((t) => t.portfolioId === req.portfolioId).map((t) => [t.id, t]));
  // A stored dividend is final (its rate may have come from a moving ECB fallback); `full` rebuilds everything.
  const keep = (t: Transaction) => !req.full && t.type === 'DIVIDEND' && stored.has(t.id);
  const changed = transactions.filter((t) => !keep(t) && !sameTransaction(stored.get(t.id), t));
  const bySymbol: Record<string, number> = {};
  for (const t of changed) bySymbol[t.symbol] = (bySymbol[t.symbol] ?? 0) + 1;

  return {
    changed,
    changedCount: changed.length,
    tickers: [...new Map(changed.map((t) => [t.symbol, t.currency])).entries()].map(([symbol, currency]) => ({ symbol, currency })),
    counts,
    unmapped: skipped.list().slice(0, MAX_STATE_LIST),
    symbols: bySymbol,
    cursors: nextCursors(state.cursors ?? {}, { orders: orders.newest, dividends: dividends.newest, cash: cash.newest }),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

const pagesPerStep = (deps: SyncDeps) => deps.limits?.pagesPerStep ?? DEFAULT_PAGES_PER_STEP;

/** Runs the step of `run.phase`. */
async function advance(deps: SyncDeps, req: SyncRequest, run: SyncCursor): Promise<Advance> {
  const { state } = run;
  const cursors = state.cursors ?? {};
  switch (run.phase) {
    case 'lock':
      return lock(deps, req, run);
    case 'account': {
      const summary = await (await openApi(deps, req.userId)).accountSummary();
      return { cursor: { ...run, phase: 'orders', accountCurrency: summary.currency.toUpperCase() } };
    }
    case 'orders': {
      const api = await openApi(deps, req.userId);
      const orders = await collectChunk(
        (from) => api.historyOrders(from),
        run.orders,
        (o) => (o.fill ? Date.parse(o.fill.filledAt) : undefined),
        cutoffOf(cursors.orders, req.full),
        pagesPerStep(deps),
      );
      return { cursor: { ...run, orders, phase: orders.done ? 'dividends' : 'orders' } };
    }
    case 'dividends': {
      const api = await openApi(deps, req.userId);
      const dividends = await collectChunk(
        (from) => api.historyDividends(from),
        run.dividends,
        (d) => Date.parse(d.paidOn),
        cutoffOf(cursors.dividends, req.full),
        pagesPerStep(deps),
      );
      return { cursor: { ...run, dividends, phase: dividends.done ? 'cash' : 'dividends' } };
    }
    case 'cash': {
      const api = await openApi(deps, req.userId);
      const warnings = [...run.warnings];
      const cash = await collectCash(api, run.cash, cutoffOf(cursors.cash, req.full), pagesPerStep(deps), warnings);
      return { cursor: { ...run, cash, warnings, phase: cash.done ? 'prepare' : 'cash' } };
    }
    case 'prepare': {
      const warnings = [...run.warnings];
      const prepared = await prepare(deps, req, { ...run, warnings }, await openApi(deps, req.userId));
      const raw = { orders: freshProgress<HistoricalOrder>(), dividends: freshProgress<HistoryDividend>(), cash: freshProgress<CashTransaction>() };
      const writing = !req.dryRun && prepared.changedCount > 0;
      return { cursor: { ...run, ...raw, warnings, prepared, written: 0, phase: writing ? 'write' : 'finish' } };
    }
    case 'write':
      return writeChunk(deps, run);
    case 'announce':
      return announce(deps, req, run);
    case 'finish':
      return { result: await succeed(deps, req, run) };
  }
}

async function writeChunk(deps: SyncDeps, run: SyncCursor): Promise<Advance> {
  const prepared = run.prepared!;
  const chunk = prepared.changed.slice(run.written, run.written + (deps.limits?.writeChunk ?? DEFAULT_WRITE_CHUNK));
  await deps.store.putTransactions(chunk);
  const written = run.written + chunk.length;
  if (written < prepared.changedCount) return { cursor: { ...run, written } };
  return { cursor: { ...run, written, prepared: { ...prepared, changed: [] }, phase: 'announce' } };
}

async function announce(deps: SyncDeps, req: SyncRequest, run: SyncCursor): Promise<Advance> {
  const prepared = run.prepared!;
  const warnings = [...run.warnings];
  await deps.store.registerUser(req.userId);
  await deps.store.trackTickers(prepared.tickers);
  try {
    await deps.events.transactionsChanged({
      userId: req.userId,
      portfolioId: req.portfolioId,
      symbols: Object.keys(prepared.symbols).sort((a, b) => a.localeCompare(b)),
      reason: 'IMPORTED',
    });
  } catch {
    warnings.push('Price enrichment was not triggered; tickers are picked up by the next scheduled refresh');
  }
  return { cursor: { ...run, warnings, phase: 'finish' } };
}

const settledState = (state: BrokerSyncState): BrokerSyncState => {
  const { runStartedAt: _runStartedAt, lastError: _lastError, runId: _runId, ...settled } = state;
  return settled;
};

/** Records the successful run in the state item and builds the result. */
async function succeed(deps: SyncDeps, req: SyncRequest, run: SyncCursor): Promise<SyncResult> {
  const prepared = run.prepared!;
  const outcome: Outcome = {
    counts: { ...prepared.counts, written: prepared.changedCount },
    unmapped: prepared.unmapped,
    warnings: run.warnings.slice(0, MAX_STATE_LIST),
    symbols: prepared.symbols,
    cursors: prepared.cursors,
    accountCurrency: run.accountCurrency!,
    ...(prepared.reconciliation ? { reconciliation: prepared.reconciliation } : {}),
  };
  const finishedAt = deps.now().toISOString();
  if (!req.dryRun) {
    await deps.store.saveState({
      ...settledState(run.state),
      status: 'SUCCEEDED',
      accountCurrency: outcome.accountCurrency,
      updatedAt: finishedAt,
      lastSyncAt: finishedAt,
      lastSuccessAt: finishedAt,
      cursors: outcome.cursors,
      counts: outcome.counts,
      unmapped: outcome.unmapped,
      warnings: outcome.warnings,
    });
  }
  logger.createChild({ persistentKeys: { userId: req.userId, portfolioId: req.portfolioId } }).info('Sync finished', {
    dryRun: req.dryRun ?? false,
    orders: outcome.counts.orders,
    dividends: outcome.counts.dividends,
    written: outcome.counts.written,
    skipped: outcome.counts.skipped,
  });
  return {
    userId: req.userId,
    portfolioId: req.portfolioId,
    status: 'SUCCEEDED',
    dryRun: req.dryRun ?? false,
    counts: outcome.counts,
    accountCurrency: outcome.accountCurrency,
    unmapped: outcome.unmapped,
    warnings: outcome.warnings,
    symbols: outcome.symbols,
    ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
  };
}

async function loadState(deps: SyncDeps, req: SyncRequest, nowIso: string): Promise<BrokerSyncState | null> {
  const stored = req.dryRun ? null : await deps.store.getState(req.userId, req.portfolioId);
  if (stored) return stored;
  if (!req.autoConnect && !req.dryRun) return null;
  const state: BrokerSyncState = {
    userId: req.userId,
    portfolioId: req.portfolioId,
    broker: 'trading212',
    environment: req.autoConnect?.environment ?? 'live',
    status: 'CONNECTED',
    connectedAt: nowIso,
    updatedAt: nowIso,
  };
  if (!req.dryRun) await deps.store.createState(state);
  return state;
}

const failure = (req: SyncRequest, error: string, status: SyncResult['status'] = 'FAILED'): SyncResult => ({
  userId: req.userId,
  portfolioId: req.portfolioId,
  status,
  dryRun: req.dryRun ?? false,
  unmapped: [],
  warnings: [],
  symbols: {},
  error,
});

/** First step: reads (or, for the CLI, creates) the connection state. It does not lock, so repeating it is harmless. */
async function begin(deps: SyncDeps, req: SyncRequest): Promise<JobStep<SyncResult>> {
  const startedAt = deps.now().toISOString();
  const state = await loadState(deps, req, startedAt);
  if (!state) return { done: true, result: failure(req, 'NOT_CONNECTED: Trading 212 is not connected for this portfolio') };
  const first: SyncCursor = {
    phase: 'lock',
    state,
    startedAt,
    runId: crypto.randomUUID(),
    warnings: [],
    orders: freshProgress(),
    dividends: freshProgress(),
    cash: freshProgress(),
    written: 0,
  };
  return { done: false, next: encode(first) };
}

/** Second step: takes the run lock (the run that is already running keeps it; see `BrokerStore.beginRun`). */
async function lock(deps: SyncDeps, req: SyncRequest, run: SyncCursor): Promise<Advance> {
  if (!req.dryRun) {
    const stale = new Date(deps.now().getTime() - STALE_LOCK_MS).toISOString();
    if (!(await deps.store.beginRun(req.userId, req.portfolioId, run.startedAt, stale, run.runId))) {
      return { result: failure(req, 'A sync is already running for this portfolio', 'SKIPPED') };
    }
  }
  return { cursor: { ...run, phase: 'account' } };
}

/** Records the failed run in the state item. Domain and API failures are recorded, never thrown. */
async function fail(deps: SyncDeps, req: SyncRequest, state: BrokerSyncState, err: unknown): Promise<SyncResult> {
  const error = describeError(err);
  const finishedAt = deps.now().toISOString();
  logger.createChild({ persistentKeys: { userId: req.userId, portfolioId: req.portfolioId } }).error('Sync failed', { error });
  if (!req.dryRun) {
    await deps.store.saveState({ ...settledState(state), status: 'FAILED', updatedAt: finishedAt, lastSyncAt: finishedAt, lastError: error });
  }
  return failure(req, error);
}

/**
 * The Trading 212 sync of one portfolio as a resumable job (see docs/architecture.md "Trading 212 sync" and
 * "Platform ports"): every step does a bounded amount of work and returns the cursor of the next one. Domain and API
 * failures are recorded in the state item and end the job with a FAILED result; they are never thrown.
 */
export function syncJob(deps: SyncDeps): JobHandler<SyncRequest, SyncResult> {
  return async ({ payload: req, cursor }) => {
    if (cursor === undefined) return begin(deps, req);
    const run = JSON.parse(cursor) as SyncCursor;
    try {
      const next = await advance(deps, req, run);
      return 'result' in next ? { done: true, result: next.result } : { done: false, next: encode(next.cursor) };
    } catch (err) {
      // Until the lock is held nothing is recorded: a lock step that failed is simply delivered again.
      if (run.phase === 'lock') throw err;
      return { done: true, result: await fail(deps, req, run.state, err) };
    }
  };
}

/** Runs one sync to its end inside the current invocation (CLI, Lambda, tests). */
export function runSync(deps: SyncDeps, req: SyncRequest): Promise<SyncResult> {
  return runToCompletion(syncJob(deps), req);
}

/** Continuation of the scheduled run over every connected portfolio. */
interface AllCursor {
  users: string[];
  /** Index of the user being synced. */
  user: number;
  /** Portfolios of that user (listed when the user is reached). */
  portfolios?: string[];
  portfolio: number;
  /** Cursor of the sync of that portfolio, between its steps. */
  inner?: string;
  results: SyncResult[];
}

/**
 * Scheduled run as a resumable job: every connected (user, portfolio), one after the other, each one as the steps of
 * `syncJob`. A failing portfolio does not stop the rest.
 */
export function syncAllJob(deps: SyncDeps): JobHandler<unknown, SyncResult[]> {
  const sync = syncJob(deps);
  const next = (cursor: AllCursor): JobStep<SyncResult[]> => ({ done: false, next: encode(cursor) });
  return async ({ cursor }) => {
    if (cursor === undefined) return next({ users: await deps.store.listUserIds(), user: 0, portfolio: 0, results: [] });
    const run = JSON.parse(cursor) as AllCursor;
    const userId = run.users[run.user];
    if (userId === undefined) return { done: true, result: run.results };
    if (!run.portfolios) {
      const states = await deps.store.listStates(userId);
      return next({ ...run, portfolios: states.map((s) => s.portfolioId), portfolio: 0 });
    }
    const portfolioId = run.portfolios[run.portfolio];
    if (portfolioId === undefined) return next({ ...run, user: run.user + 1, portfolios: undefined, portfolio: 0, inner: undefined });
    const step = await sync({ payload: { userId, portfolioId }, cursor: run.inner });
    if (!step.done) return next({ ...run, inner: step.next });
    return next({ ...run, portfolio: run.portfolio + 1, inner: undefined, results: [...run.results, step.result] });
  };
}

/** Scheduled run: every connected (user, portfolio), one after the other, inside the current invocation. */
export function runAll(deps: SyncDeps): Promise<SyncResult[]> {
  return runToCompletion(syncAllJob(deps), undefined);
}
