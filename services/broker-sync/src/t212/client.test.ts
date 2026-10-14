import { describe, expect, it, vi } from 'vitest';
import { AUTH_REJECTED_MESSAGE, BrokerError } from '../errors.js';
import { Trading212Client, resetAt, type ClientEvent, type ClientOptions } from './client.js';

const credentials = { apiKey: 'KEY-abc123', apiSecret: 'SECRET-xyz789', environment: 'live' as const };
const NOW = 1_700_000_000_000;

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

function setup(responses: (Response | Error | (() => Response))[], options: Partial<ClientOptions> = {}) {
  const queue = [...responses];
  const fetchFn = vi.fn((_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === 'function' ? next() : next);
  });
  const sleeps: number[] = [];
  const events: ClientEvent[] = [];
  const client = new Trading212Client({
    credentials,
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => NOW,
    random: () => 0.5,
    onEvent: (e) => events.push(e),
    ...options,
  });
  return { client, fetchFn, sleeps, events };
}

const urlOf = (fetchFn: ReturnType<typeof setup>['fetchFn'], n = 0) => String(fetchFn.mock.calls[n]![0]);

describe('Trading212Client requests', () => {
  it('sends Basic auth to the live or demo host and parses the account summary', async () => {
    const live = setup([json({ id: 7, currency: 'EUR', extra: 'ignored' })]);
    await expect(live.client.accountSummary()).resolves.toEqual({ id: '7', currency: 'EUR' });
    expect(urlOf(live.fetchFn)).toBe('https://live.trading212.com/api/v0/equity/account/summary');
    const init = live.fetchFn.mock.calls[0]![1]!;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('KEY-abc123:SECRET-xyz789').toString('base64')}`);

    const demo = setup([json({ currency: 'USD' })], { credentials: { ...credentials, environment: 'demo' } });
    await demo.client.accountSummary();
    expect(urlOf(demo.fetchFn)).toMatch(/^https:\/\/demo\.trading212\.com\//);
  });

  it('follows nextPagePath, validates items one by one and counts invalid ones', async () => {
    const order = { order: { id: 1, side: 'BUY', instrument: { ticker: 'AAPL_US_EQ', currency: 'USD' } }, fill: { id: 2, price: 1, quantity: 1, filledAt: '2024-01-01T00:00:00Z' } };
    const { client, fetchFn } = setup([
      json({ items: [order, { nonsense: true }], nextPagePath: '/api/v0/equity/history/orders?limit=50&cursor=123' }),
      json({ items: [order], nextPagePath: null }),
    ]);
    const pages = [];
    for await (const page of client.historyOrders()) pages.push(page);
    expect(pages.map((p) => [p.items.length, p.invalid])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(urlOf(fetchFn, 0)).toBe('https://live.trading212.com/api/v0/equity/history/orders?limit=50');
    expect(urlOf(fetchFn, 1)).toBe('https://live.trading212.com/api/v0/equity/history/orders?limit=50&cursor=123');
  });

  it('reads dividends, cash transactions (no time filter: the API needs a cursor with it), positions, instruments and exchanges', async () => {
    const dividend = {
      reference: 'r1',
      instrument: { ticker: 'AAPL_US_EQ', currency: 'USD' },
      quantity: 1,
      amount: 1,
      grossAmountPerShare: 1,
      currency: 'EUR',
      paidOn: '2024-01-01T00:00:00Z',
    };
    const { client, fetchFn } = setup([
      json({ items: [dividend] }),
      json({ items: [{ type: 'DEPOSIT', amount: 5, dateTime: '2024-01-01T00:00:00Z' }] }),
      json([{ instrument: { ticker: 'AAPL_US_EQ', currency: 'USD' }, quantity: 2 }, { bad: 1 }]),
      json([{ ticker: 'AAPL_US_EQ', workingScheduleId: 3 }]),
      json([{ name: 'NYSE', workingSchedules: [{ id: 3 }] }]),
    ]);
    const divs = (await client.historyDividends().next()).value!;
    expect(divs.items).toHaveLength(1);
    const cash = (await client.historyTransactions().next()).value!;
    expect(cash.items[0]!.type).toBe('DEPOSIT');
    expect(urlOf(fetchFn, 1)).toBe('https://live.trading212.com/api/v0/equity/history/transactions?limit=50');
    await expect(client.positions()).resolves.toMatchObject({ items: [{ quantity: 2 }], invalid: 1 });
    await expect(client.instruments()).resolves.toEqual([{ ticker: 'AAPL_US_EQ', workingScheduleId: 3 }]);
    await expect(client.exchanges()).resolves.toEqual([{ name: 'NYSE', workingSchedules: [{ id: 3 }] }]);
  });

  it('refuses pagination links that leave the API host or the equity API', async () => {
    for (const next of ['https://evil.example/api/v0/equity/history/orders', '/api/v0/account/secret', '//evil.example/api/v0/equity/x']) {
      const { client, fetchFn } = setup([json({ items: [], nextPagePath: next })]);
      const pages = client.historyOrders();
      await pages.next();
      await expect(pages.next()).rejects.toMatchObject({ code: 'T212_BAD_RESPONSE', message: 'Unexpected pagination link' });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('stops endless pagination', async () => {
    const page = () => json({ items: [], nextPagePath: '/api/v0/equity/history/orders?cursor=1' });
    const { client } = setup([page(), page(), page()], { maxPages: 2 });
    const it = client.historyOrders();
    await it.next();
    await it.next();
    await expect(it.next()).rejects.toMatchObject({ code: 'T212_BAD_RESPONSE', message: 'Pagination did not terminate' });
  });
});

describe('Trading212Client errors', () => {
  it.each([401, 403])('maps HTTP %i to T212_AUTH_REJECTED without retrying', async (status) => {
    const { client, fetchFn, sleeps } = setup([new Response('', { status })]);
    const err = await client.accountSummary().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err).toMatchObject({ code: 'T212_AUTH_REJECTED', status, message: AUTH_REJECTED_MESSAGE });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry other 4xx and redacts credentials from the reported body', async () => {
    const body = `bad request KEY-abc123 SECRET-xyz789 Basic ${Buffer.from('KEY-abc123:SECRET-xyz789').toString('base64')}`;
    const { client, fetchFn } = setup([new Response(body, { status: 400 })]);
    const err = (await client.accountSummary().catch((e: unknown) => e)) as BrokerError;
    expect(err).toMatchObject({ code: 'T212_HTTP_ERROR', status: 400 });
    expect(err.message).toContain('HTTP 400');
    for (const secret of ['KEY-abc123', 'SECRET-xyz789', Buffer.from('KEY-abc123:SECRET-xyz789').toString('base64')]) {
      expect(err.message).not.toContain(secret);
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('describes an unreadable error body as a bare status', async () => {
    const broken = new Response('x', { status: 404 });
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('stream'));
    const { client } = setup([broken]);
    await expect(client.accountSummary()).rejects.toMatchObject({ message: 'Trading 212 answered HTTP 404 for /api/v0/equity/account/summary' });
  });

  it('retries 5xx with jittered backoff and succeeds', async () => {
    const { client, fetchFn, sleeps } = setup([new Response('', { status: 503 }), new Response('', { status: 500 }), json({ currency: 'EUR' })]);
    await expect(client.accountSummary()).resolves.toMatchObject({ currency: 'EUR' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([375, 750]);
  });

  it('gives up after maxAttempts with the last error', async () => {
    const { client, fetchFn } = setup([new Response('', { status: 502 }), new Response('', { status: 502 })], { maxAttempts: 2 });
    await expect(client.accountSummary()).rejects.toMatchObject({ code: 'T212_HTTP_ERROR', status: 502 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('honours x-ratelimit-reset (unix seconds) on 429', async () => {
    const reset = String(NOW / 1000 + 12);
    const { client, sleeps, events } = setup([
      new Response('', { status: 429, headers: { 'x-ratelimit-reset': reset, 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '1' } }),
      json({ currency: 'EUR' }),
    ]);
    await client.accountSummary();
    expect(sleeps[0]).toBe(12_000);
    expect(events[0]).toMatchObject({ status: 429, remaining: '0', limit: '1', resetInMs: 12_000 });
  });

  it('waits at least a second and never longer than maxWaitMs on 429', async () => {
    const soon = String(NOW / 1000);
    const far = String(NOW / 1000 + 600);
    const { client, sleeps } = setup(
      [new Response('', { status: 429, headers: { 'x-ratelimit-reset': soon } }), new Response('', { status: 429, headers: { 'x-ratelimit-reset': far } }), json({ currency: 'EUR' })],
      { maxWaitMs: 5000 },
    );
    await client.accountSummary();
    expect(sleeps).toEqual([1000, 5000]);
  });

  it('reports T212_RATE_LIMITED when 429 persists and backs off without a reset header', async () => {
    const { client, sleeps } = setup([new Response('', { status: 429 }), new Response('', { status: 429 })], { maxAttempts: 2 });
    await expect(client.accountSummary()).rejects.toMatchObject({ code: 'T212_RATE_LIMITED', status: 429 });
    expect(sleeps).toEqual([375]);
  });

  it('retries network failures and reports them without details', async () => {
    const { client, fetchFn } = setup([new TypeError('socket SECRET-xyz789'), new TypeError('socket')], { maxAttempts: 2 });
    const err = (await client.accountSummary().catch((e: unknown) => e)) as BrokerError;
    expect(err).toMatchObject({ code: 'T212_NETWORK', message: 'Could not reach Trading 212 (TypeError)' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('labels non-Error rejections generically', async () => {
    const { client } = setup([], { maxAttempts: 1, fetchFn: (() => Promise.reject('boom')) as unknown as typeof fetch });
    await expect(client.accountSummary()).rejects.toMatchObject({ message: 'Could not reach Trading 212 (error)' });
  });

  it('rejects bodies that are not JSON or have an unexpected shape', async () => {
    const notJson = setup([new Response('<html>', { status: 200 })], { maxAttempts: 1 });
    await expect(notJson.client.accountSummary()).rejects.toMatchObject({ code: 'T212_BAD_RESPONSE' });
    const wrongShape = setup([json({ nope: true })]);
    await expect(wrongShape.client.accountSummary()).rejects.toMatchObject({ code: 'T212_BAD_RESPONSE', message: 'Unexpected response shape from /api/v0/equity/account/summary' });
    const notArray = setup([json({ items: [] })]);
    await expect(notArray.client.positions()).rejects.toMatchObject({ code: 'T212_BAD_RESPONSE' });
    const badEnvelope = setup([json([1, 2])]);
    await expect(badEnvelope.client.historyOrders().next()).rejects.toMatchObject({ code: 'T212_BAD_RESPONSE' });
  });
});

describe('Trading212Client rate limiting', () => {
  it('pauses an endpoint whose budget is used up until the reset time', async () => {
    const reset = String(NOW / 1000 + 5);
    const { client, sleeps } = setup([
      json({ currency: 'EUR' }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }),
      json({ currency: 'EUR' }),
    ]);
    await client.accountSummary();
    await client.accountSummary();
    expect(sleeps).toEqual([5000]);
  });

  it('never waits for an endpoint with budget left', async () => {
    const { client, sleeps } = setup([json({ currency: 'EUR' }, { headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(NOW / 1000 + 5) } }), json({ currency: 'EUR' })]);
    await client.accountSummary();
    await client.accountSummary();
    expect(sleeps).toEqual([]);
  });

  it('reports diagnostics without credentials', async () => {
    const { client, events } = setup([json({ currency: 'EUR' }, { headers: { 'x-ratelimit-remaining': '4', 'x-ratelimit-limit': '5' } })]);
    await client.accountSummary();
    expect(events).toEqual([{ endpoint: '/api/v0/equity/account/summary', status: 200, remaining: '4', limit: '5' }]);
    expect(JSON.stringify(events)).not.toMatch(/KEY-abc123|SECRET-xyz789/);
  });

  it('uses real timers and the system clock by default', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response('', { status: 500 }))).mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(json({ currency: 'EUR' }));
    vi.useFakeTimers();
    try {
      const client = new Trading212Client({ credentials, fetchFn: fetchFn as unknown as typeof fetch });
      const result = client.accountSummary();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toMatchObject({ currency: 'EUR' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the global fetch as the default transport', () => {
    expect(new Trading212Client({ credentials })).toBeInstanceOf(Trading212Client);
  });
});

describe('resetAt', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['abc', undefined],
    ['-3', undefined],
    [String(NOW + 5000), NOW + 5000 > 1e12 ? NOW + 5000 : undefined],
    ['1700000010', 1_700_000_010_000],
    ['30', NOW + 30_000],
  ])('interprets %s', (header, expected) => {
    expect(resetAt(header, NOW)).toBe(expected);
  });
});
