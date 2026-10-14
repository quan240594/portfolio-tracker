import { describe, expect, it, vi } from 'vitest';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { Transaction } from '@portfolio/shared';
import { createHandler } from './app.js';
import { loadConfig } from './config.js';
import { AUTH_REJECTED_MESSAGE, BrokerError, describeError } from './errors.js';
import { EventBridgePublisher } from './events.js';
import { MemoryBrokerStore } from './memory-store.js';
import { REDACTED, redact } from './redact.js';
import { QUANTITY_TOLERANCE, reconcilePositions } from './reconcile.js';
import { formatResult, whoami } from './report.js';
import type { SyncResult } from './sync.js';
import { loadExchangeNames, resolveSymbols } from './symbols.js';
import type { Trading212Api } from './t212/client.js';
import type { BrokerSyncState } from '@portfolio/shared';

describe('errors', () => {
  it('describes broker errors with their code and anything else generically', () => {
    expect(describeError(new BrokerError('T212_NETWORK', 'down'))).toBe('T212_NETWORK: down');
    expect(describeError(new BrokerError('NO_CREDENTIALS', 'x'.repeat(900))).length).toBe(500);
    expect(describeError(new Error('secret=hunter2'))).toBe('INTERNAL: Sync failed unexpectedly (see the sync Lambda logs)');
    expect(describeError('x')).toMatch(/^INTERNAL/);
  });

  it('keeps the auth message actionable and free of credentials', () => {
    expect(AUTH_REJECTED_MESSAGE).toMatch(/^Trading 212 rejected the credentials\. Check the key\/secret, that the key has the read scopes/);
    expect(AUTH_REJECTED_MESSAGE).toContain('IP allowlist');
    expect(new BrokerError('T212_AUTH_REJECTED', AUTH_REJECTED_MESSAGE, 401)).toMatchObject({ name: 'BrokerError', status: 401 });
  });
});

describe('redact', () => {
  const secrets = { apiKey: 'KEY-abc', apiSecret: 'SECRET-xyz' };
  it('removes the key, the secret, their Basic encoding and any Basic token', () => {
    const basic = Buffer.from('KEY-abc:SECRET-xyz').toString('base64');
    const text = `key=KEY-abc secret=SECRET-xyz Authorization: Basic ${basic} other Basic dGVzdDp0ZXN0 end`;
    const out = redact(text, secrets);
    expect(out).toBe(`key=${REDACTED} secret=${REDACTED} Authorization: Basic ${REDACTED} other Basic ${REDACTED} end`);
  });

  it('is a no-op for empty secrets and clean text', () => {
    expect(redact('plain', { apiKey: '', apiSecret: '' })).toBe('plain');
  });
});

describe('loadConfig', () => {
  it('has local defaults', () => {
    expect(loadConfig({})).toEqual({
      tableName: 'portfolio-tracker-local',
      eventBusName: 'portfolio-tracker-local',
      secretPrefix: '/portfolio-tracker/local/broker/trading212',
      symbolOverrides: {},
      syncFunctionName: undefined,
      endpointUrl: undefined,
      region: 'eu-west-1',
    });
  });

  it('reads the environment, ignoring invalid overrides', () => {
    const config = loadConfig({
      TABLE_NAME: 't',
      EVENT_BUS_NAME: 'b',
      BROKER_SECRET_PREFIX: '/p',
      BROKER_SYNC_FUNCTION: 'fn',
      AWS_ENDPOINT_URL: 'http://localhost:4573',
      AWS_DEFAULT_REGION: 'us-east-1',
      T212_SYMBOL_OVERRIDES: '{"A":"B","C":3}',
    });
    expect(config).toMatchObject({ tableName: 't', eventBusName: 'b', secretPrefix: '/p', syncFunctionName: 'fn', endpointUrl: 'http://localhost:4573', region: 'us-east-1', symbolOverrides: { A: 'B' } });
    expect(loadConfig({ AWS_REGION: 'eu-central-1' }).region).toBe('eu-central-1');
    for (const bad of ['not json', '[1]', 'null', '"x"']) expect(loadConfig({ T212_SYMBOL_OVERRIDES: bad }).symbolOverrides).toEqual({});
  });
});

describe('EventBridgePublisher', () => {
  const detail = { userId: 'u', portfolioId: 'p', symbols: ['A'], reason: 'IMPORTED' as const };
  it('publishes TransactionsChanged on the custom bus', async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0 });
    await new EventBridgePublisher({ send }, 'bus').transactionsChanged(detail);
    const input = (send.mock.calls[0]![0] as PutEventsCommand).input.Entries![0]!;
    expect(input).toMatchObject({ EventBusName: 'bus', Source: 'portfolio.broker', DetailType: 'TransactionsChanged' });
    expect(JSON.parse(input.Detail!)).toEqual(detail);
  });

  it('throws on failed entries', async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'Denied' }] });
    await expect(new EventBridgePublisher({ send }, 'bus').transactionsChanged(detail)).rejects.toThrow('PutEvents failed: Denied');
    send.mockResolvedValue({ FailedEntryCount: 1 });
    await expect(new EventBridgePublisher({ send }, 'bus').transactionsChanged(detail)).rejects.toThrow('PutEvents failed: unknown');
  });
});

describe('MemoryBrokerStore', () => {
  const state = (over: Partial<BrokerSyncState> = {}): BrokerSyncState => ({
    userId: 'u1',
    portfolioId: 'p1',
    broker: 'trading212',
    environment: 'live',
    status: 'CONNECTED',
    connectedAt: 'a',
    updatedAt: 'a',
    ...over,
  });
  const txn = (id: string, userId = 'u1'): Transaction => ({ id, userId, portfolioId: 'p1', date: '2026-01-01', type: 'BUY', symbol: 'X', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: 'x' });

  it('keeps states per user and portfolio', async () => {
    const store = new MemoryBrokerStore([txn('seed')]);
    await store.createState(state());
    await store.createState(state({ userId: 'u2' }));
    expect(await store.listUserIds()).toEqual(['u1', 'u2']);
    expect((await store.listStates('u1')).length).toBe(1);
    await store.saveState(state({ status: 'SUCCEEDED' }));
    await store.saveState(state({ portfolioId: 'gone' }));
    expect((await store.getState('u1', 'p1'))!.status).toBe('SUCCEEDED');
    expect(await store.getState('u1', 'gone')).toBeNull();
    expect(await store.deleteStates('u1')).toBe(1);
    expect(await store.deleteStates('u1')).toBe(0);
  });

  it('locks runs and takes over stale locks', async () => {
    const store = new MemoryBrokerStore();
    expect(await store.beginRun('u1', 'p1', 'n', 's')).toBe(false);
    await store.createState(state());
    expect(await store.beginRun('u1', 'p1', '2026-02-01', '2026-01-01')).toBe(true);
    expect(await store.beginRun('u1', 'p1', '2026-02-02', '2026-01-01')).toBe(false);
    expect(await store.beginRun('u1', 'p1', '2026-02-02', '2026-03-01')).toBe(true);
    await store.saveState(state({ status: 'RUNNING' }));
    expect(await store.beginRun('u1', 'p1', 'n', 's')).toBe(true);
  });

  it('stores transactions, users, tickers and rates', async () => {
    const store = new MemoryBrokerStore([txn('seed'), txn('other', 'u2')]);
    await store.putTransactions([txn('a')]);
    expect((await store.listTransactions('u1')).map((t) => t.id)).toEqual(['seed', 'a']);
    await store.registerUser('u1');
    await store.trackTickers([{ symbol: 'A', currency: 'USD' }]);
    await store.ensurePortfolio();
    store.fxRates = { USD: 1.1 };
    expect(await store.getFxRates()).toEqual({ USD: 1.1 });
    expect(store.users.has('u1') && store.tracked.get('A') === 'USD').toBe(true);
  });
});

describe('createHandler', () => {
  const deps = () => ({ store: new MemoryBrokerStore(), events: { transactionsChanged: () => Promise.resolve() }, credentials: { get: () => Promise.resolve(null) }, createApi: vi.fn(), symbolOverrides: {}, now: () => new Date('2026-01-01T00:00:00Z') });

  it('runs one portfolio for {userId, portfolioId}', async () => {
    const result = await createHandler(deps)({ userId: 'u1', portfolioId: 'p1', full: true });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ userId: 'u1', portfolioId: 'p1', status: 'FAILED' });
  });

  it('runs every connection for {all:true}', async () => {
    expect(await createHandler(deps)({ all: true })).toEqual({ results: [] });
  });

  it('rejects other payloads', async () => {
    await expect(createHandler(deps)({ all: false })).rejects.toThrow('Invalid sync event');
    await expect(createHandler(deps)(undefined)).rejects.toThrow('Invalid sync event');
  });

  it('builds the dependencies lazily', async () => {
    const getDeps = vi.fn(deps);
    const handler = createHandler(getDeps);
    expect(getDeps).not.toHaveBeenCalled();
    await handler({ all: true });
    expect(getDeps).toHaveBeenCalledTimes(1);
  });
});

describe('formatResult', () => {
  const base: SyncResult = { userId: 'u', portfolioId: 'p', status: 'SUCCEEDED', dryRun: false, unmapped: [], warnings: [], symbols: {} };

  it('prints counts, sorted symbols, skipped instruments, reconciliation and warnings', () => {
    const text = formatResult({
      ...base,
      dryRun: true,
      accountCurrency: 'EUR',
      counts: { orders: 3, dividends: 2, written: 4, skipped: 1, cashMovements: { deposits: 1, withdrawals: 2, fees: 3, interest: 4, other: 5 } },
      symbols: { ZZZ: 1, AAA: 3 },
      unmapped: [{ ticker: 'X_EQ', reason: 'NO_PATTERN', count: 2, currency: 'USD' }],
      warnings: ['careful'],
      reconciliation: { matched: 5, mismatched: [{ symbol: 'AAA', expected: 1, actual: 2 }], unmapped: ['Y'] },
    });
    expect(text).toBe(
      [
        'Trading 212 sync (dry run, nothing written) -> SUCCEEDED',
        '  account currency: EUR',
        '  orders: 3, dividends: 2, skipped: 1',
        '  would write: 4 transaction(s)',
        '  cash movements (not imported): deposits 1, withdrawals 2, fees 3, interest 4, other 5',
        '  symbols (2): AAA×3, ZZZ×1',
        '  UNMAPPED / skipped (1):',
        '    X_EQ [NO_PATTERN] ×2',
        '  positions reconciled: 5 match, 1 differ, 1 not comparable (unmapped)',
        '    AAA: imported 1, Trading 212 2',
        '  warning: careful',
      ].join('\n'),
    );
  });

  it('prints failures', () => {
    expect(formatResult({ ...base, status: 'FAILED', error: 'T212_AUTH_REJECTED: nope' })).toBe('Trading 212 sync -> FAILED\n  error: T212_AUTH_REJECTED: nope');
    expect(formatResult({ ...base, counts: { orders: 0, dividends: 0, written: 0, skipped: 0, cashMovements: { deposits: 0, withdrawals: 0, fees: 0, interest: 0, other: 0 } } })).toContain('account currency: unknown');
  });
});

describe('whoami', () => {
  it('returns the public IPv4 from a credential-free request', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('203.0.113.7\n'));
    expect(await whoami(fetchFn)).toBe('203.0.113.7');
    expect(fetchFn.mock.calls[0]![0]).toBe('https://checkip.amazonaws.com');
    expect(Object.keys(fetchFn.mock.calls[0]![1] as object)).toEqual(['signal']);
  });

  it('rejects failures and non-IPv4 answers', async () => {
    await expect(whoami(vi.fn().mockResolvedValue(new Response('2001:db8::1'))) ).rejects.toThrow('Could not determine');
    await expect(whoami(vi.fn().mockResolvedValue(new Response('1.2.3.4', { status: 500 })))).rejects.toThrow('Could not determine');
  });

  it('uses the global fetch by default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('198.51.100.1')));
    expect(await whoami()).toBe('198.51.100.1');
    vi.unstubAllGlobals();
  });
});

describe('symbol resolution', () => {
  const api = (over: Partial<Pick<Trading212Api, 'instruments' | 'exchanges'>> = {}) => ({
    instruments: () => Promise.resolve([{ ticker: 'SAP_EQ', workingScheduleId: 1 }, { ticker: 'NOSCHEDULE_EQ' }, { ticker: 'ORPHAN_EQ', workingScheduleId: 99 }]),
    exchanges: () => Promise.resolve([{ name: 'Xetra', workingSchedules: [{ id: 1 }] }]),
    ...over,
  });

  it('maps tickers to exchange names', async () => {
    expect([...(await loadExchangeNames(api())).entries()]).toEqual([['SAP_EQ', 'Xetra']]);
  });

  it('loads the metadata only when a ticker cannot be resolved from its shape', async () => {
    const load = vi.fn(() => Promise.resolve(new Map([['SAP_EQ', 'Xetra']])));
    const done = await resolveSymbols([{ ticker: 'AAPL_US_EQ', currency: 'USD' }, { ticker: 'AAPL_US_EQ', currency: 'USD' }], {}, load);
    expect(load).not.toHaveBeenCalled();
    expect(done.get('AAPL_US_EQ')).toMatchObject({ ok: true, symbol: 'AAPL' });

    const resolved = await resolveSymbols([{ ticker: 'SAP_EQ', currency: 'EUR', isin: 'IE1' }, { ticker: 'ZZZ_EQ', currency: 'EUR' }], {}, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(resolved.get('SAP_EQ')).toMatchObject({ ok: true, symbol: 'SAP.DE', via: 'exchange' });
    expect(resolved.get('ZZZ_EQ')).toMatchObject({ ok: false, reason: 'AMBIGUOUS_LISTING' });
  });

  it('leaves instruments unmapped when the metadata cannot be loaded', async () => {
    const resolved = await resolveSymbols([{ ticker: 'SAP_EQ', currency: 'EUR' }], {}, () => Promise.reject(new Error('rate limited')));
    expect(resolved.get('SAP_EQ')).toMatchObject({ ok: false });
  });

  it('applies overrides without metadata', async () => {
    const load = vi.fn();
    const resolved = await resolveSymbols([{ ticker: 'X_EQ', currency: 'EUR' }], { X_EQ: 'x.de' }, load);
    expect(resolved.get('X_EQ')).toEqual({ ok: true, symbol: 'X.DE', via: 'override' });
    expect(load).not.toHaveBeenCalled();
  });
});

describe('reconcilePositions', () => {
  const held = (ticker: string, quantity: number, currency = 'USD') => ({ instrument: { ticker, isin: undefined, name: undefined, currency }, quantity });
  const tx = (symbol: string, type: 'BUY' | 'SELL', quantity: number, day: number, currency = 'USD'): Transaction => ({
    id: `${symbol}${day}`, userId: 'u', portfolioId: 'p', date: `2026-01-${String(day).padStart(2, '0')}`, type, symbol, quantity, price: 1, fee: 0, currency, createdAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
  });
  const apiWith = (items: ReturnType<typeof held>[]) => ({ positions: () => Promise.resolve({ items, invalid: 0 }), instruments: () => Promise.resolve([]), exchanges: () => Promise.resolve([]) });
  const noExchanges = () => Promise.resolve(new Map<string, string>());

  it('matches quantities within the tolerance and lists every difference', async () => {
    const result = await reconcilePositions(
      apiWith([held('AAPL_US_EQ', 2 + QUANTITY_TOLERANCE / 2), held('MSFT_US_EQ', 5), held('NVDA_US_EQ', 1), held('weird ticker', 1)]),
      [tx('AAPL', 'BUY', 2, 1), tx('MSFT', 'BUY', 4, 1), tx('TSLA', 'BUY', 3, 1), tx('GONE', 'BUY', 1, 1), tx('GONE', 'SELL', 1, 2)],
      {},
      noExchanges,
    );
    expect(result).toEqual({
      matched: 1,
      mismatched: [
        { symbol: 'MSFT', expected: 4, actual: 5 },
        { symbol: 'NVDA', expected: 0, actual: 1 },
        { symbol: 'TSLA', expected: 3, actual: 0 },
      ],
      unmapped: ['weird ticker'],
    });
  });

  it('adds up several instruments that map to one symbol', async () => {
    const result = await reconcilePositions(apiWith([held('AAPL_US_EQ', 1), held('AAPL_US_EQ', 1)]), [tx('AAPL', 'BUY', 2, 1)], {}, noExchanges);
    expect(result).toEqual({ matched: 1, mismatched: [], unmapped: [] });
  });
});
