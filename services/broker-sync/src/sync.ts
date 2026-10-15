import {
  MAX_STATE_LIST,
  PortfolioError,
  T212_IMPORT_ID,
  buildPositions,
  sequentially,
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
import { logger } from './logger.js';
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
}

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

interface Collected<T> {
  items: T[];
  invalid: number;
  /** Newest timestamp (ms) among the items. */
  newest: number | undefined;
}

/**
 * Drains a newest-first history. With a cutoff, stops after the first page whose timed items are all older than it.
 * Pages that do not look newest-first are read completely, so an unexpected order can never hide new data.
 */
async function collect<T>(
  pages: AsyncGenerator<Page<T>, void, undefined>,
  timeOf: (item: T) => number | undefined,
  cutoff: number | undefined,
): Promise<Collected<T>> {
  const out: Collected<T> = { items: [], invalid: 0, newest: undefined };
  let descending = true;
  for await (const page of pages) {
    out.items.push(...page.items);
    out.invalid += page.invalid;
    const times = page.items.map(timeOf).filter((t): t is number => t !== undefined && !Number.isNaN(t));
    if (times.length === 0) continue;
    out.newest = Math.max(out.newest ?? -Infinity, ...times);
    if (times[0]! < times.at(-1)!) descending = false;
    if (descending && cutoff !== undefined && Math.max(...times) < cutoff) break;
  }
  return out;
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

async function collectCash(api: Trading212Api, cutoff: number | undefined, warnings: string[]) {
  try {
    return await collect(api.historyTransactions(), (t) => Date.parse(t.dateTime), cutoff);
  } catch (err) {
    // Cash movements are only counted; a key without the transactions scope must not block the sync.
    if (!(err instanceof BrokerError) || err.code !== 'T212_AUTH_REJECTED') throw err;
    warnings.push('Cash history unavailable: the key lacks the history:transactions scope');
    return { items: [] as CashTransaction[], invalid: 0, newest: undefined };
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

interface Outcome {
  counts: BrokerSyncCounts;
  unmapped: UnmappedInstrument[];
  warnings: string[];
  symbols: Record<string, number>;
  cursors: Cursors;
  accountCurrency: string;
  reconciliation?: Reconciliation;
}

/** FX rates observed on already imported orders, so a dividend gets the same rate whatever window was fetched. */
function seedRates(rates: RateBook, existing: readonly Transaction[], portfolioId: string): void {
  for (const t of existing) {
    if (t.portfolioId === portfolioId && t.importId === T212_IMPORT_ID && t.type !== 'DIVIDEND' && t.fxRate) {
      rates.add(t.currency, Date.parse(t.createdAt), t.fxRate);
    }
  }
}

async function fetchAndMap(deps: SyncDeps, req: SyncRequest, state: BrokerSyncState, api: Trading212Api, existing: readonly Transaction[]) {
  const warnings: string[] = [];
  const summary = await api.accountSummary();
  const cursors = state.cursors ?? {};
  const orders = await collect<HistoricalOrder>(
    api.historyOrders(),
    (o) => (o.fill ? Date.parse(o.fill.filledAt) : undefined),
    cutoffOf(cursors.orders, req.full),
  );
  const dividends = await collect<HistoryDividend>(api.historyDividends(), (d) => Date.parse(d.paidOn), cutoffOf(cursors.dividends, req.full));
  const cash = await collectCash(api, cutoffOf(cursors.cash, req.full), warnings);

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

  const invalid = orders.invalid + dividends.invalid + cash.invalid;
  if (invalid > 0) warnings.push(`${invalid} Trading 212 record(s) had an unexpected shape and were skipped`);
  const counts: BrokerSyncCounts = {
    orders: orders.items.filter((o) => o.fill).length,
    dividends: dividends.items.length,
    written: 0,
    skipped: ctx.skipped.total + invalid,
    cashMovements: countCash(cash.items),
  };
  return {
    transactions,
    counts,
    warnings,
    skipped: ctx.skipped,
    accountCurrency: summary.currency.toUpperCase(),
    cursors: nextCursors(cursors, { orders: orders.newest, dividends: dividends.newest, cash: cash.newest }),
  };
}

async function execute(deps: SyncDeps, req: SyncRequest, state: BrokerSyncState): Promise<Outcome> {
  const credentials = await deps.credentials.get(req.userId);
  if (!credentials) throw new BrokerError('NO_CREDENTIALS', 'No Trading 212 credentials are stored for this user; connect the broker first');
  const api = deps.createApi(credentials);
  const existing = await deps.store.listTransactions(req.userId);
  const fetched = await fetchAndMap(deps, req, state, api, existing);
  const { transactions, warnings } = fetched;

  const hint = fetched.skipped.list().some((s) => s.reason.startsWith('UNSUPPORTED_FILL_'))
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
  const symbols: Record<string, number> = {};
  for (const t of changed) symbols[t.symbol] = (symbols[t.symbol] ?? 0) + 1;

  if (!req.dryRun && changed.length > 0) {
    await deps.store.putTransactions(changed);
    await deps.store.registerUser(req.userId);
    await deps.store.trackTickers([...new Map(changed.map((t) => [t.symbol, t.currency])).entries()].map(([symbol, currency]) => ({ symbol, currency })));
    try {
      await deps.events.transactionsChanged({
        userId: req.userId,
        portfolioId: req.portfolioId,
        symbols: Object.keys(symbols).sort((a, b) => a.localeCompare(b)),
        reason: 'IMPORTED',
      });
    } catch {
      warnings.push('Price enrichment was not triggered; tickers are picked up by the next scheduled refresh');
    }
  }
  return {
    counts: { ...fetched.counts, written: changed.length },
    unmapped: fetched.skipped.list().slice(0, MAX_STATE_LIST),
    warnings: warnings.slice(0, MAX_STATE_LIST),
    symbols,
    cursors: fetched.cursors,
    accountCurrency: fetched.accountCurrency,
    ...(reconciliation ? { reconciliation } : {}),
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

/** Runs one sync (see docs/architecture.md "Trading 212 sync"). Domain and API failures are recorded, never thrown. */
export async function runSync(deps: SyncDeps, req: SyncRequest): Promise<SyncResult> {
  const startedAt = deps.now().toISOString();
  const log = logger.createChild({ persistentKeys: { userId: req.userId, portfolioId: req.portfolioId } });
  const state = await loadState(deps, req, startedAt);
  if (!state) return failure(req, 'NOT_CONNECTED: Trading 212 is not connected for this portfolio');
  if (!req.dryRun) {
    const stale = new Date(deps.now().getTime() - STALE_LOCK_MS).toISOString();
    if (!(await deps.store.beginRun(req.userId, req.portfolioId, startedAt, stale))) {
      return failure(req, 'A sync is already running for this portfolio', 'SKIPPED');
    }
  }
  const { runStartedAt: _runStartedAt, lastError: _lastError, ...settled } = state;
  try {
    const outcome = await execute(deps, req, state);
    const finishedAt = deps.now().toISOString();
    if (!req.dryRun) {
      await deps.store.saveState({
        ...settled,
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
    log.info('Sync finished', { dryRun: req.dryRun ?? false, orders: outcome.counts.orders, dividends: outcome.counts.dividends, written: outcome.counts.written, skipped: outcome.counts.skipped });
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
  } catch (err) {
    const error = describeError(err);
    const finishedAt = deps.now().toISOString();
    log.error('Sync failed', { error });
    if (!req.dryRun) {
      await deps.store.saveState({ ...settled, status: 'FAILED', updatedAt: finishedAt, lastSyncAt: finishedAt, lastError: error });
    }
    return failure(req, error);
  }
}

/** Scheduled run: every connected (user, portfolio), one after the other. A failing one does not stop the rest. */
export async function runAll(deps: SyncDeps): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const runUser = async (userId: string): Promise<SyncResult[]> => {
    const userResults: SyncResult[] = [];
    const states = await deps.store.listStates(userId);
    for await (const result of sequentially(states, (state) => runSync(deps, { userId, portfolioId: state.portfolioId }))) {
      userResults.push(result);
    }
    return userResults;
  };
  for await (const userResults of sequentially(await deps.store.listUserIds(), runUser)) results.push(...userResults);
  return results;
}
