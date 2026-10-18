import { describe, expect, it, vi } from 'vitest';
import type { BrokerSyncState, Transaction } from '@portfolio/shared';
import { BrokerError } from './errors.js';
import { MemoryBrokerStore } from './memory-store.js';
import { runToCompletion, type JobStep } from '@portfolio/platform';
import { DEFAULT_PAGES_PER_STEP, DEFAULT_WRITE_CHUNK, STALE_LOCK_MS, countCash, runAll, runSync, syncAllJob, syncJob, validateMerged, type SyncDeps, type SyncResult } from './sync.js';
import type { Page, Trading212Api } from './t212/client.js';
import type { CashTransaction, HistoricalOrder, HistoryDividend, OpenPosition } from './t212/schemas.js';
import { cash, dividend, order } from './testing/fixtures.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const creds = { apiKey: 'KEY-abc', apiSecret: 'SECRET-xyz', environment: 'live' as const };

interface FakeData {
  orders?: HistoricalOrder[];
  dividends?: HistoryDividend[];
  cash?: CashTransaction[];
  positions?: OpenPosition[];
  currency?: string;
  pageSize?: number;
  invalid?: number;
  cashError?: Error;
  /** Pages carry no `next` link, so a step cannot stop in the middle of a history. */
  unresumable?: boolean;
}

class FakeApi implements Trading212Api {
  readonly requested: string[] = [];
  constructor(private readonly data: FakeData = {}) {}

  accountSummary() {
    return Promise.resolve({ id: '1', currency: this.data.currency ?? 'EUR' });
  }
  positions() {
    return Promise.resolve({ items: this.data.positions ?? [], invalid: 0 });
  }
  /** Pages of `pageSize` items; `from` is the `next` of a page (its index), like Trading 212's `nextPagePath`. */
  private async *paged<T>(name: string, items: T[], invalid = 0, from?: string): AsyncGenerator<Page<T>, void, undefined> {
    const size = this.data.pageSize ?? 2;
    for (let i = from === undefined ? 0 : Number(from) * size; i < Math.max(items.length, 1); i += size) {
      this.requested.push(`${name}:${i / size}`);
      await Promise.resolve();
      const hasMore = i + size < items.length;
      yield { items: items.slice(i, i + size), invalid: i === 0 ? invalid : 0, ...(hasMore && !this.data.unresumable ? { next: String(i / size + 1) } : {}) };
    }
  }
  historyOrders(from?: string) {
    return this.paged('orders', this.data.orders ?? [], this.data.invalid, from);
  }
  historyDividends(from?: string) {
    return this.paged('dividends', this.data.dividends ?? [], 0, from);
  }
  historyTransactions(from?: string) {
    if (this.data.cashError) {
      const error = this.data.cashError;
      // eslint-disable-next-line require-yield
      return (async function* (): AsyncGenerator<Page<CashTransaction>, void, undefined> {
        await Promise.resolve();
        throw error;
      })();
    }
    return this.paged('cash', this.data.cash ?? [], 0, from);
  }
  instruments() {
    return Promise.resolve([]);
  }
  exchanges() {
    return Promise.resolve([]);
  }
}

function setup(data: FakeData = {}, over: Partial<SyncDeps> = {}) {
  const store = new MemoryBrokerStore();
  store.fxRates = { USD: 1.1 };
  const api = new FakeApi(data);
  const published: unknown[] = [];
  const deps: SyncDeps = {
    store,
    events: {
      transactionsChanged: (d) => {
        published.push(d);
        return Promise.resolve();
      },
    },
    credentials: { get: () => Promise.resolve(creds) },
    createApi: () => api,
    symbolOverrides: {},
    now: () => NOW,
    ...over,
  };
  const connect = async (patch: Partial<BrokerSyncState> = {}) => {
    const state: BrokerSyncState = {
      userId: 'u1',
      portfolioId: 'p1',
      broker: 'trading212',
      environment: 'live',
      status: 'CONNECTED',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...patch,
    };
    await store.createState(state);
    await store.registerUser(state.userId);
  };
  return { store, api, deps, published, connect };
}

const REQ = { userId: 'u1', portfolioId: 'p1' };
const buy = (id: number, filledAt: string, over: Parameters<typeof order>[0] = {}) =>
  order({ id, fillId: id * 10, filledAt, fxRate: 1.1, netValue: 200 / 1.1, ...over });

describe('runSync', () => {
  it('imports orders, dividends and splits, stores the state and emits one event', async () => {
    const { store, deps, published, connect } = setup({
      orders: [
        buy(3, '2026-03-02T10:00:00Z', { side: 'SELL', quantity: -1, price: 120 }),
        buy(2, '2026-02-02T10:00:00Z', { ticker: 'ASMLa_EQ', currency: 'EUR', isin: 'NL0010273215', price: 700, quantity: 1, fxRate: undefined, netValue: 700 }),
        buy(1, '2026-01-02T10:00:00Z', { quantity: 2, price: 100 }),
      ],
      dividends: [dividend({ reference: 'd1', paidOn: '2026-02-15T00:00:00Z' })],
      cash: [cash('DEPOSIT'), cash('WITHDRAW'), cash('INTEREST_ON_FREE_CASH'), cash('FEE'), cash('TRANSFER')],
    });
    await connect();
    const result = await runSync(deps, REQ);

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      dryRun: false,
      accountCurrency: 'EUR',
      symbols: { AAPL: 3, 'ASML.AS': 1 },
      counts: { orders: 3, dividends: 1, written: 4, skipped: 0, cashMovements: { deposits: 1, withdrawals: 1, fees: 1, interest: 1, other: 1 } },
    });
    expect([...store.transactions.values()].map((t) => t.id).sort()).toEqual(['t212-1-10', 't212-2-20', 't212-3-30', 't212-div-d1']);
    expect(store.tracked.get('AAPL')).toBe('USD');
    expect(store.users.has('u1')).toBe(true);
    expect(published).toEqual([{ userId: 'u1', portfolioId: 'p1', symbols: ['AAPL', 'ASML.AS'], reason: 'IMPORTED' }]);

    const state = (await store.getState('u1', 'p1'))!;
    expect(state).toMatchObject({
      status: 'SUCCEEDED',
      accountCurrency: 'EUR',
      lastSyncAt: NOW.toISOString(),
      lastSuccessAt: NOW.toISOString(),
      cursors: { orders: '2026-03-02T10:00:00.000Z', dividends: '2026-02-15T00:00:00.000Z', cash: '2024-01-02T09:00:00.000Z' },
    });
    expect(state).not.toHaveProperty('runStartedAt');
    expect(state).not.toHaveProperty('lastError');
  });

  it('is idempotent: an unchanged re-sync writes nothing and emits no event', async () => {
    const { store, deps, published, connect } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await connect();
    await runSync(deps, REQ);
    published.length = 0;
    const again = await runSync(deps, { ...REQ, full: true });
    expect(again.counts).toMatchObject({ orders: 1, written: 0 });
    expect(published).toEqual([]);
    expect(store.transactions.size).toBe(1);
  });

  it('reads only recent pages when a watermark exists, and everything with full', async () => {
    const orders = [
      buy(5, '2026-03-05T10:00:00Z'),
      buy(4, '2026-03-04T10:00:00Z'),
      buy(3, '2026-02-01T10:00:00Z'),
      buy(2, '2026-01-30T10:00:00Z'),
      buy(1, '2026-01-20T10:00:00Z'),
    ];
    const cashItems = [cash('DEPOSIT', '2026-03-05T09:00:00Z'), cash('FEE', '2026-03-04T09:00:00Z'), cash('DEPOSIT', '2026-01-02T09:00:00Z'), cash('DEPOSIT', '2026-01-01T09:00:00Z'), cash('FEE', '2025-12-01T09:00:00Z')];
    const incremental = setup({ orders, cash: cashItems });
    await incremental.connect({ cursors: { orders: '2026-03-04T10:00:00Z', cash: '2026-03-04T10:00:00Z' } });
    await runSync(incremental.deps, REQ);
    // page 0 (5, 4) is recent, page 1 (3, 2) is older than watermark - overlap, so reading stops there.
    expect(incremental.api.requested.filter((r) => r.startsWith('orders'))).toEqual(['orders:0', 'orders:1']);
    expect(incremental.api.requested.filter((r) => r.startsWith('cash'))).toEqual(['cash:0', 'cash:1']);

    const full = setup({ orders });
    await full.connect({ cursors: { orders: '2026-03-04T10:00:00Z' } });
    await runSync(full.deps, { ...REQ, full: true });
    expect(full.api.requested.filter((r) => r.startsWith('orders'))).toEqual(['orders:0', 'orders:1', 'orders:2']);
  });

  it('keeps reading when pages do not look newest-first and never moves a watermark backwards', async () => {
    const { api, deps, connect, store } = setup({
      orders: [buy(1, '2026-01-02T10:00:00Z'), buy(2, '2026-01-03T10:00:00Z'), buy(3, '2026-01-04T10:00:00Z')],
    });
    await connect({ cursors: { orders: '2026-03-04T10:00:00Z', dividends: '2026-03-01T00:00:00Z' } });
    await runSync(deps, REQ);
    expect(api.requested.filter((r) => r.startsWith('orders'))).toEqual(['orders:0', 'orders:1']);
    expect((await store.getState('u1', 'p1'))!.cursors).toMatchObject({ orders: '2026-03-04T10:00:00Z', dividends: '2026-03-01T00:00:00Z' });
  });

  it('ignores a malformed stored watermark', async () => {
    const { api, deps, connect } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z'), buy(2, '2026-01-01T10:00:00Z'), buy(3, '2025-12-01T10:00:00Z')] });
    await connect({ cursors: { orders: 'garbage' } });
    await runSync(deps, REQ);
    expect(api.requested.filter((r) => r.startsWith('orders'))).toEqual(['orders:0', 'orders:1']);
  });

  it('records skipped instruments (unmapped list), invalid records and warnings', async () => {
    const { deps, connect, store } = setup({
      orders: [buy(1, '2026-01-02T10:00:00Z', { ticker: 'not a ticker' }), buy(2, '2026-01-03T10:00:00Z')],
      invalid: 2,
    });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.unmapped).toEqual([{ ticker: 'not a ticker', isin: 'US0378331005', name: 'Example Corp', currency: 'USD', reason: 'NO_PATTERN', count: 1 }]);
    expect(result.warnings).toEqual(['2 Trading 212 record(s) had an unexpected shape and were skipped']);
    expect(result.counts).toMatchObject({ skipped: 3, written: 1 });
    expect((await store.getState('u1', 'p1'))!.unmapped).toHaveLength(1);
  });

  it('does not write anything in a dry run, not even a state, and needs no connection', async () => {
    const { store, deps, published } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    const result = await runSync(deps, { ...REQ, dryRun: true });
    expect(result).toMatchObject({ status: 'SUCCEEDED', dryRun: true, symbols: { AAPL: 1 }, counts: { written: 1 } });
    expect(store.transactions.size).toBe(0);
    expect(store.states.size).toBe(0);
    expect(published).toEqual([]);
  });

  it('auto-connects for the CLI and persists the connection', async () => {
    const { store, deps } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    const result = await runSync(deps, { ...REQ, autoConnect: { environment: 'demo' } });
    expect(result.status).toBe('SUCCEEDED');
    expect(await store.getState('u1', 'p1')).toMatchObject({ environment: 'demo', status: 'SUCCEEDED', connectedAt: NOW.toISOString() });
  });

  it('fails with NOT_CONNECTED when the portfolio has no state', async () => {
    const { deps } = setup();
    expect(await runSync(deps, REQ)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('NOT_CONNECTED') });
  });

  it('fails with NO_CREDENTIALS and records it on the state', async () => {
    const { deps, connect, store } = setup({}, { credentials: { get: () => Promise.resolve(null) } });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/^NO_CREDENTIALS: /);
    expect(await store.getState('u1', 'p1')).toMatchObject({ status: 'FAILED', lastError: result.error, lastSyncAt: NOW.toISOString() });
  });

  it('surfaces T212_AUTH_REJECTED in the result and the state, without secrets', async () => {
    const rejecting = {
      ...new FakeApi(),
      accountSummary: () => Promise.reject(new BrokerError('T212_AUTH_REJECTED', 'Trading 212 rejected the credentials. Check the key.', 401)),
    } as unknown as Trading212Api;
    const { deps, connect, store } = setup({}, { createApi: () => rejecting });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.error).toBe('T212_AUTH_REJECTED: Trading 212 rejected the credentials. Check the key.');
    const state = (await store.getState('u1', 'p1'))!;
    expect(state).toMatchObject({ status: 'FAILED', lastError: result.error });
    expect(JSON.stringify([result, state])).not.toMatch(/KEY-abc|SECRET-xyz/);
  });

  it('reduces unexpected errors to a generic message', async () => {
    const broken = { ...new FakeApi(), accountSummary: () => Promise.reject(new Error('db password=hunter2')) } as unknown as Trading212Api;
    const { deps, connect } = setup({}, { createApi: () => broken });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.error).toBe('INTERNAL: Sync failed unexpectedly (see the sync Lambda logs)');
  });

  it('refuses to write when the merged result would oversell, and says why', async () => {
    const { store, deps, connect } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z', { side: 'SELL', quantity: 1 })] });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/^VALIDATION_FAILED: Cannot sell .* \(check that no other import already contains the same Trading 212 trades in this portfolio\)$/);
    expect(store.transactions.size).toBe(0);
    expect((await store.getState('u1', 'p1'))!.status).toBe('FAILED');
  });

  it('points at corporate actions when an unsupported fill was skipped before an oversell', async () => {
    const { deps, connect } = setup({
      orders: [buy(2, '2026-01-03T10:00:00Z', { side: 'SELL', quantity: 1 }), buy(1, '2026-01-02T10:00:00Z', { type: 'EQUITY_RIGHTS' })],
    });
    await connect();
    expect((await runSync(deps, REQ)).error).toContain('corporate-action fills');
  });

  it('refuses a symbol that would use two currencies across the portfolios of the user', async () => {
    const { store, deps, connect } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await store.putTransactions([{ id: 'x', userId: 'u1', portfolioId: 'other', date: '2025-01-01', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: '2025-01-01T00:00:00Z' }]);
    await connect();
    expect((await runSync(deps, REQ)).error).toBe('VALIDATION_FAILED: Mixed currencies for AAPL: EUR and USD');
  });

  it('skips when another run is active, and takes over a stale lock', async () => {
    const running = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await running.connect({ status: 'RUNNING', runStartedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(await runSync(running.deps, REQ)).toMatchObject({ status: 'SKIPPED', error: 'A sync is already running for this portfolio' });
    expect(running.store.transactions.size).toBe(0);

    const stale = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await stale.connect({ status: 'RUNNING', runStartedAt: new Date(NOW.getTime() - STALE_LOCK_MS - 1000).toISOString() });
    expect((await runSync(stale.deps, REQ)).status).toBe('SUCCEEDED');
  });

  it('does not keep the run id of a crashed run when it takes over a stale lock', async () => {
    const stale = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await stale.connect({ status: 'RUNNING', runId: 'crashed', runStartedAt: new Date(NOW.getTime() - STALE_LOCK_MS - 1000).toISOString() });
    expect((await runSync(stale.deps, REQ)).status).toBe('SUCCEEDED');
    expect(stale.store.states.get('u1|p1')).not.toHaveProperty('runId');
  });

  it('lets the sync continue without cash history when the key lacks that scope', async () => {
    const { deps, connect } = setup({ cashError: new BrokerError('T212_AUTH_REJECTED', 'nope', 403) });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.warnings).toEqual(['Cash history unavailable: the key lacks the history:transactions scope']);
  });

  it('fails the run when cash history fails for another reason', async () => {
    const { deps, connect } = setup({ cashError: new BrokerError('T212_NETWORK', 'down') });
    await connect();
    expect((await runSync(deps, REQ)).error).toBe('T212_NETWORK: down');
    const other = setup({ cashError: new Error('boom') });
    await other.connect();
    expect((await runSync(other.deps, REQ)).error).toMatch(/^INTERNAL/);
  });

  it('keeps the sync successful when the event cannot be published', async () => {
    const { deps, connect } = setup(
      { orders: [buy(1, '2026-01-02T10:00:00Z')] },
      { events: { transactionsChanged: () => Promise.reject(new Error('bus down')) } },
    );
    await connect();
    const result = await runSync(deps, REQ);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.warnings).toEqual(['Price enrichment was not triggered; tickers are picked up by the next scheduled refresh']);
  });

  it('survives a disconnect during the run: the state is not resurrected', async () => {
    const { store, deps, connect } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await connect();
    const original = store.deleteStates.bind(store);
    const slowCredentials = {
      get: async () => {
        await original('u1');
        return creds;
      },
    };
    await runSync({ ...deps, credentials: slowCredentials }, REQ);
    expect(await store.getState('u1', 'p1')).toBeNull();
  });

  it('uses the ECB fallback rate stored by the prices service and tolerates its absence', async () => {
    const withRates = setup({ dividends: [dividend({ reference: 'd1' })] });
    await withRates.connect();
    expect((await runSync(withRates.deps, REQ)).counts).toMatchObject({ written: 1 });
    const failing = setup({ dividends: [dividend({ reference: 'd1' })] });
    failing.store.getFxRates = () => Promise.reject(new Error('no table'));
    await failing.connect();
    const result = await runSync(failing.deps, REQ);
    expect(result.counts).toMatchObject({ written: 0, skipped: 1 });
    expect(result.unmapped[0]).toMatchObject({ reason: 'NO_FX_RATE' });
  });

  it('gives a dividend the rate of imported orders even when the run only fetched the dividend', async () => {
    const { store, deps, connect } = setup({ orders: [buy(1, '2026-02-10T10:00:00Z', { fxRate: 1.25, netValue: 160 })] });
    store.fxRates = {};
    await connect();
    await runSync(deps, REQ);
    const dividendOnly = new FakeApi({ dividends: [dividend({ reference: 'd1', paidOn: '2026-02-15T00:00:00Z' })] });
    const result = await runSync({ ...deps, createApi: () => dividendOnly }, REQ);
    expect(result.counts).toMatchObject({ written: 1, skipped: 0 });
    expect(store.transactions.get('u1|p1|t212-div-d1')?.fxRate).toBe(1.25);
  });

  it('treats stored dividends as final, unless the sync is a full rebuild', async () => {
    const { store, deps, connect } = setup({ dividends: [dividend({ reference: 'd1' })] });
    await connect();
    await runSync(deps, REQ);
    const first = store.transactions.get('u1|p1|t212-div-d1')!;
    store.fxRates = { USD: 1.3 };
    expect((await runSync(deps, REQ)).counts?.written).toBe(0);
    expect(store.transactions.get('u1|p1|t212-div-d1')).toEqual(first);
    expect((await runSync(deps, { ...REQ, full: true })).counts?.written).toBe(1);
    expect(store.transactions.get('u1|p1|t212-div-d1')!.fxRate).toBe(1.3);
  });

  it('reconciles the replayed positions with the open positions of Trading 212', async () => {
    const position = (quantity: number): OpenPosition => ({ instrument: { ticker: 'AAPL_US_EQ', isin: 'US0378331005', name: 'x', currency: 'USD' }, quantity });
    const matching = setup({ orders: [buy(1, '2026-01-02T10:00:00Z', { quantity: 2 })], positions: [position(2)] });
    await matching.connect();
    expect((await runSync(matching.deps, { ...REQ, reconcile: true })).reconciliation).toEqual({ matched: 1, mismatched: [], unmapped: [] });
    const differing = setup({ orders: [buy(1, '2026-01-02T10:00:00Z', { quantity: 2 })], positions: [position(3)] });
    await differing.connect();
    expect((await runSync(differing.deps, { ...REQ, reconcile: true })).reconciliation?.mismatched).toEqual([{ symbol: 'AAPL', expected: 2, actual: 3 }]);
    expect((await runSync(differing.deps, REQ)).reconciliation).toBeUndefined();
  });

  it('reports a rejected positions request (missing portfolio scope) as the error of the run', async () => {
    const api = Object.assign(new FakeApi({ orders: [buy(1, '2026-01-02T10:00:00Z')] }), {
      positions: () => Promise.reject(new BrokerError('T212_AUTH_REJECTED', 'no portfolio scope', 403)),
    });
    const { deps } = setup({}, { createApi: () => api });
    const result = await runSync(deps, { ...REQ, reconcile: true, dryRun: true });
    expect(result.error).toBe('T212_AUTH_REJECTED: no portfolio scope');
  });
});

describe('runAll', () => {
  it('runs every connected portfolio of every user and continues after a failure', async () => {
    const { store, deps, connect } = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] });
    await connect();
    await connect({ userId: 'u2', portfolioId: 'p9' });
    await connect({ userId: 'u3', portfolioId: 'p1' });
    const failingFor = new Set(['u2']);
    const results = await runAll({
      ...deps,
      credentials: { get: (userId) => Promise.resolve(failingFor.has(userId) ? null : creds) },
    });
    expect(results.map((r) => [r.userId, r.portfolioId, r.status]).sort()).toEqual([
      ['u1', 'p1', 'SUCCEEDED'],
      ['u2', 'p9', 'FAILED'],
      ['u3', 'p1', 'SUCCEEDED'],
    ]);
    expect(store.transactions.size).toBe(2);
  });

  it('does nothing without connections', async () => {
    expect(await runAll(setup().deps)).toEqual([]);
  });
});

describe('countCash', () => {
  it('buckets cash movement types', () => {
    expect(countCash([cash('DEPOSIT'), cash('DEPOSIT'), cash('WITHDRAW'), cash('FEE'), cash('LENDING_INTEREST'), cash('INTEREST_ON_FREE_CASH'), cash('TRANSFER')])).toEqual({
      deposits: 2,
      withdrawals: 1,
      fees: 1,
      interest: 2,
      other: 1,
    });
  });
});

describe('validateMerged', () => {
  const t = (over: Partial<Transaction>): Transaction => ({ id: 'a', userId: 'u', portfolioId: 'p1', date: '2026-01-01', type: 'BUY', symbol: 'X', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: '2026-01-01T00:00:00Z', ...over });

  it('lets synced transactions replace stored ones with the same id', () => {
    expect(() => validateMerged([t({ id: 'a', quantity: 1 })], [t({ id: 'a', quantity: 5 }), t({ id: 'b', type: 'SELL', quantity: 5, date: '2026-01-02' })], 'p1', '')).not.toThrow();
  });

  it('only checks overselling within the target portfolio', () => {
    expect(() => validateMerged([t({ id: 'z', portfolioId: 'p2', type: 'SELL', quantity: 100 })], [t({ id: 'b' })], 'p1', '')).not.toThrow();
  });

  it('rethrows unexpected errors', () => {
    const filter = Array.prototype.filter;
    const spy = vi
      .spyOn(Array.prototype, 'filter')
      // The first call is the lookup of the stored transactions; the one inside the position check fails.
      .mockImplementationOnce(function (this: unknown[], ...args: Parameters<typeof filter>) {
        return filter.apply(this, args);
      })
      .mockImplementationOnce(() => {
        throw new TypeError('boom');
      });
    expect(() => validateMerged([], [], 'p1', '')).toThrow(TypeError);
    spy.mockRestore();
  });
});

describe('resumable steps', () => {
  const DATA: FakeData = {
    orders: [
      buy(5, '2026-03-05T10:00:00Z', { side: 'SELL', quantity: -1, price: 120 }),
      buy(4, '2026-03-04T10:00:00Z', { ticker: 'ASMLa_EQ', currency: 'EUR', isin: 'NL0010273215', price: 700, quantity: 1, fxRate: undefined, netValue: 700 }),
      buy(3, '2026-03-03T10:00:00Z', { quantity: 1, price: 110 }),
      buy(2, '2026-02-02T10:00:00Z', { quantity: 1, price: 105 }),
      buy(1, '2026-01-02T10:00:00Z', { quantity: 3, price: 100 }),
    ],
    dividends: [dividend({ reference: 'd2', paidOn: '2026-03-01T00:00:00Z' }), dividend({ reference: 'd1', paidOn: '2026-02-15T00:00:00Z' }), dividend({ reference: 'd0', paidOn: '2026-01-15T00:00:00Z' })],
    cash: [cash('DEPOSIT'), cash('FEE'), cash('INTEREST_ON_FREE_CASH')],
  };
  const SMALL_STEPS = { pagesPerStep: 1, writeChunk: 2 };

  /** A restarted worker: new dependencies and a new API client around the same persistent store. */
  const restarted = (store: MemoryBrokerStore, published: unknown[], data: FakeData = DATA): SyncDeps => ({
    ...setup(data).deps,
    store,
    events: { transactionsChanged: (d) => { published.push(d); return Promise.resolve(); } },
    limits: SMALL_STEPS,
  });

  const phaseOf = (next: string) => (JSON.parse(next) as { phase: string }).phase;

  /** The cursors of an uninterrupted run, and its result. */
  async function uninterrupted(req = REQ, data: FakeData = DATA) {
    const { store, deps, published, connect } = setup(data, { limits: SMALL_STEPS });
    await connect();
    const cursors: (string | undefined)[] = [undefined];
    let step: JobStep<SyncResult>;
    do {
      step = await syncJob(deps)({ payload: req, cursor: cursors.at(-1) });
      if (!step.done) cursors.push(step.next);
    } while (!step.done);
    return { cursors, result: step.result, store, published };
  }

  /** The stored items; the registry rows carry the wall-clock time of the write, which is not part of the comparison. */
  const snapshot = (store: MemoryBrokerStore) =>
    store.items
      .snapshot()
      .map(({ createdAt, updatedAt, ...item }) => (item.PK === 'USERS' || item.PK === 'TRACKED' ? item : { ...item, createdAt, updatedAt }))
      .sort((a, b) => `${a.PK}${a.SK}`.localeCompare(`${b.PK}${b.SK}`));

  it('splits a sync into bounded steps with a cursor each: lock, account, orders, dividends, cash, prepare, write, announce, finish', async () => {
    const { cursors, result } = await uninterrupted();
    const phases = cursors.slice(1).map((c) => phaseOf(c!));
    expect([...new Set(phases)]).toEqual(['lock', 'account', 'orders', 'dividends', 'cash', 'prepare', 'write', 'announce', 'finish']);
    expect(phases.filter((p) => p === 'orders')).toHaveLength(3);
    expect(phases.filter((p) => p === 'write')).toHaveLength(4);
    expect(result).toMatchObject({ status: 'SUCCEEDED', counts: { orders: 5, dividends: 3, written: 8 } });
    // Each cursor is plain JSON and the raw history is dropped once it has been mapped.
    expect(JSON.parse(cursors.at(-1)!).orders.items).toEqual([]);
  });

  it('reads every page once across steps (the Trading 212 page link is the cursor)', async () => {
    const api = new FakeApi(DATA);
    const { deps, connect } = setup(DATA, { createApi: () => api, limits: SMALL_STEPS });
    await connect();
    await runSync(deps, REQ);
    expect(api.requested).toEqual(['orders:0', 'orders:1', 'orders:2', 'dividends:0', 'dividends:1', 'cash:0', 'cash:1']);
  });

  /**
   * A run whose worker dies after `interruptAfter` steps: the next step has executed but its cursor was lost, so a new
   * worker (new dependencies, new API client) is handed the same cursor again and runs it a second time.
   */
  async function interrupted(req: typeof REQ & { dryRun?: boolean }, interruptAfter: number, connected = true) {
    const { store, connect } = setup(DATA);
    if (connected) await connect();
    const published: unknown[] = [];
    const job = () => syncJob(restarted(store, published));
    let cursor: string | undefined;
    for (let i = 0; i < interruptAfter; i++) {
      const step = await job()({ payload: req, cursor });
      cursor = step.done ? cursor : step.next;
    }
    await job()({ payload: req, cursor });
    let step: JobStep<SyncResult>;
    do {
      step = await job()({ payload: req, cursor });
      if (!step.done) cursor = step.next;
    } while (!step.done);
    return { result: step.result, store, published };
  }

  it('gives the same result as one run when interrupted after any step', async () => {
    const baseline = await uninterrupted();
    expect(baseline.cursors.length).toBeGreaterThan(10);
    for (let interruptAfter = 0; interruptAfter < baseline.cursors.length; interruptAfter++) {
      const run = await interrupted(REQ, interruptAfter);
      expect(run.result, `interrupted after step ${interruptAfter}`).toEqual(baseline.result);
      expect(snapshot(run.store), `interrupted after step ${interruptAfter}`).toEqual(snapshot(baseline.store));
      // Delivery is at-least-once: the event may repeat, never differ.
      expect(new Set(run.published.map((p) => JSON.stringify(p)))).toEqual(new Set(baseline.published.map((p) => JSON.stringify(p))));
    }
  });

  it('resumes an interrupted dry run to the same result without writing anything', async () => {
    const req = { ...REQ, dryRun: true };
    const baseline = await uninterrupted(req);
    expect(baseline.cursors.map((c) => c && phaseOf(c))).not.toContain('write');
    for (let interruptAfter = 0; interruptAfter < baseline.cursors.length; interruptAfter++) {
      const run = await interrupted(req, interruptAfter, false);
      expect(run.result, `interrupted after step ${interruptAfter}`).toEqual(baseline.result);
      expect(run.store.transactions.size).toBe(0);
      expect(run.store.states.size).toBe(0);
    }
    expect(baseline.result).toMatchObject({ status: 'SUCCEEDED', dryRun: true });
  });

  it('does not lock out its own redelivered lock step, but skips a second run while one is active', async () => {
    const { deps, connect, store } = setup(DATA, { limits: SMALL_STEPS });
    await connect();
    const lockStep = async () => {
      const first = await syncJob(deps)({ payload: REQ });
      return syncJob(deps)({ payload: REQ, cursor: first.done ? undefined : first.next });
    };
    expect(await lockStep()).toMatchObject({ done: false });
    expect(await store.getState('u1', 'p1')).toMatchObject({ status: 'RUNNING', runId: expect.any(String) });
    expect(await lockStep()).toMatchObject({ done: true, result: { status: 'SKIPPED', error: 'A sync is already running for this portfolio' } });
  });

  it('records a failure that happens in a later step and ends the job', async () => {
    const failing = Object.assign(new FakeApi(DATA), { historyDividends: () => { throw new BrokerError('T212_HTTP_ERROR', 'boom', 500); } });
    const { deps, connect, store } = setup(DATA, { createApi: () => failing, limits: SMALL_STEPS });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result).toMatchObject({ status: 'FAILED', error: 'T212_HTTP_ERROR: boom' });
    expect(await store.getState('u1', 'p1')).toMatchObject({ status: 'FAILED', lastError: 'T212_HTTP_ERROR: boom' });
  });

  it('reads a history to its end in one step when its pages cannot be resumed', async () => {
    const { deps, connect, store } = setup({ ...DATA, unresumable: true }, { limits: SMALL_STEPS });
    await connect();
    const result = await runSync(deps, REQ);
    expect(result).toMatchObject({ status: 'SUCCEEDED', counts: { orders: 5, written: 8 } });
    expect(store.transactions.size).toBe(8);
  });

  it('has defaults that fit a whole history into a few steps', async () => {
    expect(DEFAULT_PAGES_PER_STEP).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_WRITE_CHUNK).toBeGreaterThanOrEqual(25);
    const { deps, connect } = setup(DATA);
    await connect();
    const steps: string[] = [];
    await runToCompletion(syncJob(deps), REQ, { onStep: (step) => { if (!step.done) steps.push(phaseOf(step.next)); } });
    expect(steps).toEqual(['lock', 'account', 'orders', 'dividends', 'cash', 'prepare', 'write', 'announce', 'finish']);
  });

  it('resumes the scheduled run over every portfolio after any step', async () => {
    const build = async () => {
      const ctx = setup({ orders: [buy(1, '2026-01-02T10:00:00Z')] }, { limits: SMALL_STEPS });
      await ctx.connect();
      await ctx.connect({ userId: 'u2', portfolioId: 'p9' });
      await ctx.connect({ userId: 'u3', portfolioId: 'p1' });
      await ctx.connect({ userId: 'u3', portfolioId: 'p2' });
      return { ...ctx, deps: { ...ctx.deps, credentials: { get: (userId: string) => Promise.resolve(userId === 'u2' ? null : creds) } } };
    };
    const reference = await build();
    const cursors: (string | undefined)[] = [undefined];
    let step: JobStep<SyncResult[]>;
    do {
      step = await syncAllJob(reference.deps)({ payload: undefined, cursor: cursors.at(-1) });
      if (!step.done) cursors.push(step.next);
    } while (!step.done);
    const expected = step.result;
    expect(expected.map((r) => [r.userId, r.portfolioId, r.status])).toEqual([
      ['u1', 'p1', 'SUCCEEDED'],
      ['u2', 'p9', 'FAILED'],
      ['u3', 'p1', 'SUCCEEDED'],
      ['u3', 'p2', 'SUCCEEDED'],
    ]);

    for (let interruptAfter = 0; interruptAfter < cursors.length; interruptAfter++) {
      const run = await build();
      const job = () => syncAllJob(run.deps);
      let cursor: string | undefined;
      for (let i = 0; i < interruptAfter; i++) {
        const next = await job()({ payload: undefined, cursor });
        cursor = next.done ? cursor : next.next;
      }
      await job()({ payload: undefined, cursor });
      let next: JobStep<SyncResult[]>;
      do {
        next = await job()({ payload: undefined, cursor });
        if (!next.done) cursor = next.next;
      } while (!next.done);
      expect(next.result, `interrupted after step ${interruptAfter}`).toEqual(expected);
      expect(snapshot(run.store), `interrupted after step ${interruptAfter}`).toEqual(snapshot(reference.store));
    }
  });
});
