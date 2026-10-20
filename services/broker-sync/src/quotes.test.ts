import { JOBS, type JobQueue, type JobStep } from '@portfolio/platform';
import { keys, type BrokerSyncState, type Quote } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { HandlerResult } from './app.js';
import { BrokerError } from './errors.js';
import { MemoryBrokerStore } from './memory-store.js';
import { ItemQuoteStore } from './quote-store.js';
import { MIN_INTERVAL_MS, refreshQuotesAfterSync, refreshQuotesJob, type QuoteDeps, type QuoteRunResult } from './quotes.js';
import type { SyncResult } from './sync.js';
import { Trading212Client, type Trading212Api } from './t212/client.js';
import type { OpenPosition } from './t212/schemas.js';
import { position } from './testing/fixtures.js';

const START = Date.parse('2026-10-20T10:15:00.000Z');
const credentials = { apiKey: 'KEY-abc123', apiSecret: 'SECRET-xyz789', environment: 'live' as const };

class Clock {
  constructor(public ms = START) {}
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

interface FakeApiData {
  positions?: OpenPosition[];
  error?: Error;
  instruments?: { ticker: string; workingScheduleId?: number }[];
  exchanges?: { name: string; workingSchedules: { id: number }[] }[];
  metadataError?: Error;
}

class FakeApi implements Pick<Trading212Api, 'positions' | 'instruments' | 'exchanges'> {
  positionCalls = 0;
  metadataCalls = 0;
  constructor(public data: FakeApiData = {}) {}
  positions() {
    this.positionCalls++;
    return this.data.error ? Promise.reject(this.data.error) : Promise.resolve({ items: this.data.positions ?? [], invalid: 0 });
  }
  instruments() {
    this.metadataCalls++;
    return this.data.metadataError ? Promise.reject(this.data.metadataError) : Promise.resolve(this.data.instruments ?? []);
  }
  exchanges() {
    return Promise.resolve(this.data.exchanges ?? []);
  }
}

const state = (patch: Partial<BrokerSyncState> = {}): BrokerSyncState => ({
  userId: 'u1',
  portfolioId: 'p1',
  broker: 'trading212',
  environment: 'live',
  status: 'SUCCEEDED',
  connectedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

async function setup(data: FakeApiData = {}, over: Partial<QuoteDeps> = {}) {
  const store = new MemoryBrokerStore();
  store.fxRates = { USD: 1.1, GBP: 0.87 };
  await store.createState(state());
  await store.registerUser('u1');
  const clock = new Clock();
  const api = new FakeApi(data);
  const quotes = new ItemQuoteStore(store.items);
  const deps: QuoteDeps = {
    store,
    quotes,
    credentials: { get: () => Promise.resolve(credentials) },
    createApi: () => api,
    symbolOverrides: {},
    now: clock.now,
    ...over,
  };
  const job = refreshQuotesJob(() => deps);
  /** Runs the job to its end like the alarm does and returns its result. */
  const run = async (payload: unknown = { trigger: 'scheduled' }): Promise<QuoteRunResult> => {
    let step: JobStep<QuoteRunResult> = await job({ payload });
    while (!step.done) step = await job({ payload, cursor: step.next });
    return step.result;
  };
  const stored = (symbol: string) => store.items.snapshot().find((item) => item.PK === keys.quote(symbol).PK && item.SK === keys.quote(symbol).SK);
  const status = () => quotes.getStatus('u1');
  return { store, clock, api, deps, run, stored, status, quotes };
}

const HELD = [
  position({ ticker: 'AAPL_US_EQ', currentPrice: 212.5 }),
  position({ ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBX', currentPrice: 9650 }),
  position({ ticker: 'SAPd_EQ', isin: 'DE0007164600', currency: 'EUR', currentPrice: 231.4 }),
];

describe('refreshQuotesJob', () => {
  it('stores one quote per held symbol with the importer symbols, one positions request, and a status', async () => {
    const t = await setup({ positions: HELD });
    const { results } = await t.run();
    expect(results).toEqual([{ userId: 'u1', outcome: 'refreshed', quoted: 3, skipped: 0 }]);
    expect(t.api.positionCalls).toBe(1);
    expect(t.api.metadataCalls).toBe(0);
    const asOf = '2026-10-20T10:15:00.000Z';
    expect(t.stored('AAPL')).toEqual({ PK: 'TICKER#AAPL', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'AAPL', price: 212.5, previousClose: 212.5, currency: 'USD', asOf, source: 't212' });
    expect(t.stored('VUSA.L')).toMatchObject({ price: 96.5, previousClose: 96.5, currency: 'GBP', asOf, source: 't212' });
    expect(t.stored('SAP.DE')).toMatchObject({ price: 231.4, currency: 'EUR' });
    expect(await t.status()).toEqual({ userId: 'u1', state: 'OK', lastAttemptAt: asOf, lastSuccessAt: asOf, failures: 0, quoted: 3, skipped: 0, tickerSymbols: {} });
  });

  it('writes the quotes and the status in one batched write', async () => {
    const t = await setup({ positions: HELD });
    const batches: number[] = [];
    const original = t.store.items.batchWrite.bind(t.store.items);
    t.store.items.batchWrite = (operations) => {
      batches.push(operations.length);
      return original(operations);
    };
    await t.run();
    expect(batches).toEqual([4]);
  });

  it('corrects a London price that is in pence but labelled GBP, using the value of the position', async () => {
    const t = await setup({ positions: [position({ ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBP', quantity: 10, currentPrice: 9650, currentValue: 1109.2 })] });
    await t.run();
    expect(t.stored('VUSA.L')).toMatchObject({ price: 96.5, currency: 'GBP' });
  });

  it('is idempotent: another run keeps the day change base and the same shape', async () => {
    const t = await setup({ positions: [position({ currentPrice: 200 })] });
    await t.run();
    t.clock.advance(15 * 60_000);
    t.api.data.positions = [position({ currentPrice: 205 })];
    await t.run();
    expect(t.stored('AAPL')).toMatchObject({ price: 205, previousClose: 200, asOf: '2026-10-20T10:30:00.000Z' });
    t.clock.advance(15 * 60_000);
    await t.run();
    expect(t.stored('AAPL')).toMatchObject({ price: 205, previousClose: 200 });
  });

  it('uses the last stored price as the previous close on the next day', async () => {
    const t = await setup({ positions: [position({ currentPrice: 200 })] });
    await t.run();
    t.clock.advance(24 * 3600_000);
    t.api.data.positions = [position({ currentPrice: 210 })];
    await t.run();
    expect(t.stored('AAPL')).toMatchObject({ price: 210, previousClose: 200 });
  });

  it('never overwrites a provider quote with the same or a newer time, but replaces an older one', async () => {
    const t = await setup({ positions: [position({ currentPrice: 212.5 })] });
    const provider = (asOf: string): Quote => ({ symbol: 'AAPL', price: 199, previousClose: 197, currency: 'USD', asOf, source: 'twelvedata' });
    await t.quotes.save([provider('2026-10-20T10:15:00.000Z')], { userId: 'other', state: 'OK', lastAttemptAt: '2026-10-20T00:00:00.000Z', failures: 0 });
    expect(await t.run()).toEqual({ results: [{ userId: 'u1', outcome: 'refreshed', quoted: 0, skipped: 1 }] });
    expect(t.stored('AAPL')).toMatchObject({ price: 199, source: 'twelvedata' });

    t.clock.advance(MIN_INTERVAL_MS + 15 * 60_000);
    await t.quotes.save([provider('2026-10-20T08:00:00.000Z')], { userId: 'other', state: 'OK', lastAttemptAt: '2026-10-20T00:00:00.000Z', failures: 0 });
    await t.run();
    expect(t.stored('AAPL')).toMatchObject({ price: 212.5, previousClose: 197, source: 't212' });
  });

  it('skips unmapped instruments, instruments without a price and repeated symbols', async () => {
    const t = await setup({
      positions: [
        position({ ticker: 'AAPL_US_EQ', currentPrice: 212.5 }),
        position({ ticker: 'AAPL_US_EQ', currentPrice: 1 }),
        position({ ticker: 'ZZZ_EQ', isin: 'IE00ZZZZZZZ0' }),
        position({ ticker: 'MSFT_US_EQ', isin: 'US5949181045', noPrice: true }),
      ],
    });
    const { results } = await t.run();
    expect(results[0]).toMatchObject({ quoted: 1, skipped: 3 });
    expect(t.stored('AAPL')).toMatchObject({ price: 212.5 });
    expect(t.stored('MSFT')).toBeUndefined();
  });

  it('applies the symbol overrides of the configuration', async () => {
    const t = await setup({ positions: [position({ ticker: 'ZZZ_EQ', isin: 'IE00ZZZZZZZ0', currency: 'USD', currentPrice: 12 })] }, { symbolOverrides: { ZZZ_EQ: 'ZZZ' } });
    await t.run();
    expect(t.stored('ZZZ')).toMatchObject({ price: 12 });
  });

  it('writes a status and no quotes for an account without positions', async () => {
    const t = await setup({ positions: [] });
    expect((await t.run()).results[0]).toMatchObject({ outcome: 'refreshed', quoted: 0 });
    expect(await t.status()).toMatchObject({ state: 'OK', quoted: 0 });
  });

  it('skips a user that is not connected, without any request', async () => {
    const t = await setup({ positions: HELD });
    expect(await t.run({ trigger: 'sync', userId: 'nobody' })).toEqual({ results: [{ userId: 'nobody', outcome: 'skipped', reason: 'not-connected', quoted: 0, skipped: 0 }] });
    expect(t.api.positionCalls).toBe(0);
  });

  it('does not call Trading 212 again within the minimum interval', async () => {
    const t = await setup({ positions: HELD });
    await t.run();
    t.clock.advance(MIN_INTERVAL_MS - 1);
    expect((await t.run({ trigger: 'sync', userId: 'u1' })).results[0]).toMatchObject({ outcome: 'skipped', reason: 'too-soon' });
    t.clock.advance(1);
    expect((await t.run({ trigger: 'sync', userId: 'u1' })).results[0]).toMatchObject({ outcome: 'refreshed' });
    expect(t.api.positionCalls).toBe(2);
  });

  it('refreshes every user, one step each', async () => {
    const t = await setup({ positions: HELD });
    await t.store.createState(state({ userId: 'u2', portfolioId: 'p9' }));
    await t.store.registerUser('u2');
    const job = refreshQuotesJob(() => t.deps);
    const payload = { trigger: 'scheduled' };
    const first = await job({ payload });
    expect(first.done).toBe(false);
    const second = await job({ payload, cursor: first.done ? undefined : first.next });
    expect(t.api.positionCalls).toBe(2);
    const results = second.done ? second.result.results : [];
    expect(results.map((r) => [r.userId, r.outcome])).toEqual([
      ['u1', 'refreshed'],
      ['u2', 'refreshed'],
    ]);
  });

  it('finishes at once when there is no user, and rejects an invalid payload', async () => {
    const t = await setup({ positions: HELD });
    const finished = await refreshQuotesJob(() => t.deps)({ payload: { trigger: 'scheduled' }, cursor: JSON.stringify({ users: [], index: 0, results: [] }) });
    expect(finished).toEqual({ done: true, result: { results: [] } });
    await expect(refreshQuotesJob(() => t.deps)({ payload: { trigger: 'daily' } })).rejects.toThrow('Invalid quote refresh payload');
  });
});

describe('refreshQuotesJob failures', () => {
  it('records a rejected key, backs off for 6 hours and stays away without any request', async () => {
    const t = await setup({ error: new BrokerError('T212_AUTH_REJECTED', 'rejected', 401) });
    expect((await t.run()).results[0]).toEqual({ userId: 'u1', outcome: 'failed', reason: 'AUTH_REJECTED', quoted: 0, skipped: 0 });
    expect(await t.status()).toMatchObject({ state: 'AUTH_REJECTED', failures: 1, nextAttemptAt: '2026-10-20T16:15:00.000Z', lastError: expect.stringContaining('T212_AUTH_REJECTED') });
    t.clock.advance(15 * 60_000);
    expect((await t.run()).results[0]).toMatchObject({ outcome: 'skipped', reason: 'backing-off' });
    expect(t.api.positionCalls).toBe(1);
  });

  it('lets a fresh sync try again despite the back-off, and clears the failure on success', async () => {
    const t = await setup({ error: new BrokerError('T212_AUTH_REJECTED', 'rejected', 403) });
    await t.run();
    t.clock.advance(60_000);
    t.api.data = { positions: HELD };
    expect((await t.run({ trigger: 'sync', userId: 'u1' })).results[0]).toMatchObject({ outcome: 'refreshed', quoted: 3 });
    const status = await t.status();
    expect(status).toMatchObject({ state: 'OK', failures: 0 });
    expect(status).not.toHaveProperty('nextAttemptAt');
    expect(status).not.toHaveProperty('lastError');
  });

  it('backs off a rate limit by 5 minutes, doubling up to an hour', async () => {
    const t = await setup({ error: new BrokerError('T212_RATE_LIMITED', 'slow down', 429) });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await t.run({ trigger: 'sync', userId: 'u1' });
      const next = (await t.status())!.nextAttemptAt!;
      waits.push((Date.parse(next) - t.clock.ms) / 60_000);
      t.clock.advance(MIN_INTERVAL_MS);
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60]);
    expect(await t.status()).toMatchObject({ state: 'RATE_LIMITED', failures: 6 });
  });

  it('records other failures (5xx, network, unexpected) as ERROR with a safe message', async () => {
    const http = await setup({ error: new BrokerError('T212_HTTP_ERROR', 'HTTP 503', 503) });
    await http.run();
    expect(await http.status()).toMatchObject({ state: 'ERROR', nextAttemptAt: '2026-10-20T10:45:00.000Z' });
    const unexpected = await setup({ error: new Error('KEY-abc123 leaked in a stack trace') });
    await unexpected.run();
    const status = await unexpected.status();
    expect(status).toMatchObject({ state: 'ERROR', lastError: 'INTERNAL: The quote refresh failed unexpectedly' });
    expect(JSON.stringify(status)).not.toContain('KEY-abc123');
  });

  it('records missing or unusable credentials without a request', async () => {
    const missing = await setup({ positions: HELD }, { credentials: { get: () => Promise.resolve(null) } });
    expect((await missing.run()).results[0]).toMatchObject({ outcome: 'failed', reason: 'NO_CREDENTIALS' });
    expect(missing.api.positionCalls).toBe(0);
    const broken = await setup({ positions: HELD }, { credentials: { get: () => Promise.reject(new BrokerError('NO_CREDENTIALS', 'incomplete')) } });
    expect((await broken.run()).results[0]).toMatchObject({ outcome: 'failed', reason: 'NO_CREDENTIALS' });
    expect(await broken.status()).toMatchObject({ state: 'NO_CREDENTIALS', nextAttemptAt: '2026-10-20T16:15:00.000Z' });
  });

  it('lets a failing secret store fail the step (the queue retries it) instead of recording it', async () => {
    const t = await setup({ positions: HELD }, { credentials: { get: () => Promise.reject(new Error('secret store down')) } });
    await expect(t.run()).rejects.toThrow('secret store down');
    expect(await t.status()).toBeNull();
  });
});

describe('refreshQuotesJob over the real client', () => {
  const run = async (responses: Response[]) => {
    const t = await setup({ positions: [] });
    const queue = [...responses];
    const fetchFn = vi.fn(() => Promise.resolve(queue.shift() ?? new Response('unexpected', { status: 599 })));
    const deps: QuoteDeps = { ...t.deps, createApi: (c) => new Trading212Client({ credentials: c, fetchFn: fetchFn as unknown as typeof fetch, maxAttempts: 1, sleep: () => Promise.resolve() }) };
    const job = refreshQuotesJob(() => deps);
    const step = await job({ payload: { trigger: 'scheduled' } });
    return { t, fetchFn, step };
  };

  it('parses the positions of the public API and makes exactly one request', async () => {
    const body = [
      { instrument: { ticker: 'AAPL_US_EQ', isin: 'US0378331005', name: 'Example', currency: 'USD' }, quantity: 2, currentPrice: 212.5, averagePricePaid: 150, walletImpact: { currency: 'EUR', totalCost: 270, currentValue: 386.4, unrealizedProfitLoss: 116.4, fxImpact: 3 } },
      { instrument: { ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBX' }, quantity: 1.5, currentPrice: 9650 },
    ];
    const { t, fetchFn, step } = await run([Response.json(body)]);
    expect(step).toMatchObject({ done: true, result: { results: [{ outcome: 'refreshed', quoted: 2 }] } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe('https://live.trading212.com/api/v0/equity/positions');
    expect(t.stored('VUSA.L')).toMatchObject({ price: 96.5, currency: 'GBP' });
  });

  it.each([
    [401, 'AUTH_REJECTED'],
    [403, 'AUTH_REJECTED'],
    [429, 'RATE_LIMITED'],
    [500, 'ERROR'],
    [503, 'ERROR'],
  ])('answers %i with a recorded %s status, one request and no retry loop', async (status, state) => {
    const { t, fetchFn, step } = await run([new Response('{}', { status })]);
    expect(step).toMatchObject({ done: true, result: { results: [{ outcome: 'failed', reason: state }] } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await t.status()).toMatchObject({ state, failures: 1 });
    expect(JSON.stringify(await t.status())).not.toContain('KEY-abc123');
  });

  it('treats a response that is not a list as a recorded failure', async () => {
    const { t, step } = await run([Response.json({ items: [] })]);
    expect(step).toMatchObject({ done: true, result: { results: [{ outcome: 'failed', reason: 'ERROR' }] } });
    expect(await t.status()).toMatchObject({ lastError: expect.stringContaining('T212_BAD_RESPONSE') });
  });
});

describe('exchange metadata', () => {
  const bare = [position({ ticker: 'SAP_EQ', currency: 'EUR', isin: 'LU0000000000', currentPrice: 231.4 })];
  const metadata = {
    instruments: [{ ticker: 'SAP_EQ', workingScheduleId: 7 }],
    exchanges: [{ name: 'Xetra', workingSchedules: [{ id: 7 }] }],
  };

  it('is loaded once for an instrument that cannot be mapped otherwise, then remembered', async () => {
    const t = await setup({ positions: bare, ...metadata });
    await t.run();
    expect(t.api.metadataCalls).toBe(1);
    expect(t.stored('SAP.DE')).toMatchObject({ price: 231.4 });
    expect(await t.status()).toMatchObject({ tickerSymbols: { SAP_EQ: 'SAP.DE' }, metadataTriedAt: '2026-10-20T10:15:00.000Z' });

    t.clock.advance(2 * 3600_000);
    t.api.data = { positions: bare };
    await t.run();
    expect(t.api.metadataCalls).toBe(1);
    expect(t.stored('SAP.DE')).toMatchObject({ asOf: '2026-10-20T12:15:00.000Z' });
    expect(await t.status()).toMatchObject({ tickerSymbols: { SAP_EQ: 'SAP.DE' } });
  });

  it('forgets cached tickers that are no longer held', async () => {
    const t = await setup({ positions: bare, ...metadata });
    await t.run();
    t.clock.advance(15 * 60_000);
    t.api.data = { positions: HELD };
    await t.run();
    expect((await t.status())?.tickerSymbols).toEqual({});
  });

  it('is retried at most hourly when it fails, and the instrument is skipped meanwhile', async () => {
    const t = await setup({ positions: bare, metadataError: new BrokerError('T212_RATE_LIMITED', 'slow', 429) });
    expect((await t.run()).results[0]).toMatchObject({ outcome: 'refreshed', quoted: 0, skipped: 1 });
    t.clock.advance(15 * 60_000);
    await t.run();
    expect(t.api.metadataCalls).toBe(1);
    t.clock.advance(46 * 60_000);
    t.api.data = { positions: bare, ...metadata };
    await t.run();
    expect(t.api.metadataCalls).toBe(2);
    expect(t.stored('SAP.DE')).toBeDefined();
  });

  it('is not requested when every instrument maps from its ticker or ISIN', async () => {
    const t = await setup({ positions: [position({ ticker: 'SAP_EQ', currency: 'EUR', isin: 'DE0007164600', currentPrice: 231.4 })] });
    await t.run();
    expect(t.api.metadataCalls).toBe(0);
    expect(t.stored('SAP.DE')).toBeDefined();
  });
});

describe('refreshQuotesAfterSync', () => {
  const result = (over: Partial<SyncResult>): SyncResult => ({ userId: 'u1', portfolioId: 'p1', status: 'SUCCEEDED', dryRun: false, unmapped: [], warnings: [], symbols: {}, ...over });
  const finished = (...results: SyncResult[]): JobStep<HandlerResult> => ({ done: true, result: { results } });
  const setupWrap = (step: JobStep<HandlerResult>, enqueue = vi.fn((_message: unknown) => Promise.resolve())) => {
    const queue = { enqueue } as unknown as JobQueue;
    return { enqueue, handler: refreshQuotesAfterSync(() => Promise.resolve(step), queue) };
  };

  it('enqueues one refresh per user whose sync succeeded', async () => {
    const { handler, enqueue } = setupWrap(finished(result({}), result({ portfolioId: 'p2' }), result({ userId: 'u2' }), result({ userId: 'u3', status: 'FAILED' }), result({ userId: 'u4', status: 'SKIPPED' }), result({ userId: 'u5', dryRun: true })));
    const step = await handler({ payload: { all: true } });
    expect(step.done).toBe(true);
    expect(enqueue.mock.calls.map(([message]) => message)).toEqual([
      { job: JOBS.refreshT212Quotes, payload: { trigger: 'sync', userId: 'u1' } },
      { job: JOBS.refreshT212Quotes, payload: { trigger: 'sync', userId: 'u2' } },
    ]);
  });

  it('does nothing while the sync is still running', async () => {
    const { handler, enqueue } = setupWrap({ done: false, next: 'cursor' });
    expect(await handler({ payload: { all: true } })).toEqual({ done: false, next: 'cursor' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never fails the sync when the refresh cannot be enqueued', async () => {
    const { handler } = setupWrap(finished(result({})), vi.fn((_message: unknown) => Promise.reject(new Error('queue down'))));
    await expect(handler({ payload: { all: true } })).resolves.toMatchObject({ done: true });
  });
});
