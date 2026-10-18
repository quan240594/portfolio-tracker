import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createHandler } from './lambda/handler.js';
import type { Deps } from './deps.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const ids = (body: { events: { id: string }[] }) => body.events.map((e) => e.id);

/**
 * Today is 2026-06-15 (fakeDeps). Main portfolio: 10 VWRL.AS (EUR, quarterly payer); US broker: 10 AAPL (USD, 15 % withholding).
 * MSFT is only on the watchlist. Another user holds MSFT dividends and a split that must never show up.
 */
function setup() {
  const ctx = fakeDeps();
  const { repo, mgmt } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main portfolio' }), portfolio({ portfolioId: 'usd', name: 'US broker' })];
  repo.transactions = [
    txn({ id: 'b1', date: '2025-01-02', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100 }),
    txn({ id: 'b2', portfolioId: 'usd', date: '2025-01-02', type: 'BUY', symbol: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
    ...['2025-08-15', '2025-11-15', '2026-02-15', '2026-05-15'].map((date) =>
      txn({ id: `d-${date}`, portfolioId: 'usd', date, type: 'DIVIDEND', symbol: 'AAPL', quantity: 10, price: 0.5, fee: 0.75, currency: 'USD' }),
    ),
    txn({ id: 'other', userId: 'someone-else', date: '2025-01-01', type: 'BUY', symbol: 'KO', quantity: 5, price: 50, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 110, previousClose: 110, currency: 'EUR', asOf: '2026-06-15T17:00:00Z', source: 'test' },
    AAPL: { symbol: 'AAPL', price: 150, previousClose: 150, currency: 'USD', asOf: '2026-06-15T20:00:00Z', source: 'test' },
  };
  repo.profiles = {
    'VWRL.AS': { symbol: 'VWRL.AS', name: 'Vanguard All-World', assetClass: 'ETF', currency: 'EUR' },
    AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', currency: 'USD' },
    MSFT: { symbol: 'MSFT', name: 'Microsoft', assetClass: 'STOCK', currency: 'USD' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-15T00:00:00Z' };
  repo.dividendEvents = [
    { symbol: 'AAPL', exDate: '2026-08-01', payDate: '2026-08-14', amount: 0.55, currency: 'USD' },
    { symbol: 'VWRL.AS', exDate: '2026-06-20', payDate: '2026-07-05', amount: 0.4, currency: 'EUR' },
    { symbol: 'MSFT', exDate: '2026-06-18', payDate: '2026-07-10', amount: 0.83, currency: 'USD' },
    { symbol: 'KO', exDate: '2026-06-18', payDate: '2026-07-10', amount: 0.5, currency: 'USD' },
  ];
  repo.earningsEvents = [
    { symbol: 'AAPL', date: '2026-07-30', timeOfDay: 'AMC', epsEstimate: 1.2, source: 'alphavantage' },
    { symbol: 'MSFT', date: '2026-07-21', timeOfDay: 'BMO', source: 'alphavantage' },
    { symbol: 'AAPL', date: '2027-07-01', source: 'alphavantage' },
    { symbol: 'KO', date: '2026-07-22', source: 'alphavantage' },
  ];
  repo.splitEvents = [{ symbol: 'AAPL', date: '2026-07-10', fromFactor: 1, toFactor: 4, source: 'eodhd' }];
  mgmt.watchlist = [
    { userId: 'demo', symbol: 'MSFT', addedAt: '2026-01-01T00:00:00.000Z' },
    { userId: 'someone-else', symbol: 'NVDA', addedAt: '2026-01-01T00:00:00.000Z' },
  ];
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

describe('GET /calendar', () => {
  it('defaults to the current month ± 1 and returns events, summary, monthly income and coverage notes', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/calendar'));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
    const body = json(res);
    expect(body).toMatchObject({ baseCurrency: 'EUR', from: '2026-05-01', to: '2026-07-31' });
    expect(ids(body)).toEqual([
      'paid:d-2026-05-15',
      'ex:MSFT:2026-06-18',
      'ex:VWRL.AS:2026-06-20',
      'pay:VWRL.AS:2026-06-20',
      'pay:MSFT:2026-06-18',
      'split:AAPL:2026-07-10',
      'earn:MSFT:2026-07-21',
      'earn:AAPL:2026-07-30',
    ]);
    expect(body.events[0]).toMatchObject({ status: 'PAID', origin: 'HOLDING', expectedAmount: 3.4, name: 'Apple' });
    expect(body.events[3]).toMatchObject({ date: '2026-07-05', status: 'CONFIRMED', quantity: 10, expectedAmount: 4, currency: 'EUR' });
    expect(body.events[7]).toMatchObject({ epsEstimate: 1.2, timeOfDay: 'AMC', status: 'ESTIMATED' });
    // 4 (VWRL) + 3.74 (AAPL, net of 15 % withholding) declared, 3 × 3.40 estimated AAPL payments.
    expect(body.summary).toMatchObject({ annualIncome: 17.94, declared: 7.74, estimated: 10.2, monthlyAverage: 1.5, yieldPct: 0.78 });
    expect(body.monthly).toHaveLength(12);
    expect(body.monthly.filter((m: { total: number }) => m.total > 0).map((m: { month: string; total: number }) => [m.month, m.total])).toEqual([
      ['2026-05', 3.4],
      ['2026-07', 4],
      ['2026-08', 3.74],
      ['2026-11', 3.4],
      ['2027-02', 3.4],
    ]);
    expect(body.coverage.earnings).toMatch(/US-listed/);
    expect(body.coverage.corporateActions).toMatch(/Mergers/);
  });

  it('never returns another user’s transactions, watchlist or dividends', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/calendar', { query: { from: '2026-01-01', to: '2026-12-31' } })));
    expect(body.events.some((e: { symbol: string }) => e.symbol === 'KO' || e.symbol === 'NVDA')).toBe(false);
  });

  it('filters by scope', async () => {
    const { handler } = setup();
    const get = async (scope: string) => json(await handler(apiEvent('GET', '/calendar', { query: { scope } })));
    expect(new Set((await get('holdings')).events.map((e: { origin: string }) => e.origin))).toEqual(new Set(['HOLDING']));
    const watch = await get('watchlist');
    expect(new Set(watch.events.map((e: { symbol: string }) => e.symbol))).toEqual(new Set(['MSFT']));
    expect(ids(await get('all'))).toHaveLength(ids(await get('holdings')).length + ids(watch).length);
    // The income summary describes the holdings whatever the filter.
    expect(watch.summary.annualIncome).toBe(17.94);
  });

  it('filters by type, status and explicit date range', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/calendar', { query: { types: 'earnings,split', status: 'estimated', from: '2026-07-01', to: '2027-07-31' } }));
    expect(ids(json(res))).toEqual(['earn:MSFT:2026-07-21', 'earn:AAPL:2026-07-30', 'earn:AAPL:2027-07-01']);
    expect(ids(json(await handler(apiEvent('GET', '/calendar', { query: { types: 'SPLIT' } }))))).toEqual(['split:AAPL:2026-07-10']);
    expect(ids(json(await handler(apiEvent('GET', '/calendar', { query: { status: 'PAID', from: '2025-08-01', to: '2026-06-30' } }))))).toHaveLength(4);
  });

  it('honours ?portfolioId= and answers 404 for unknown portfolios', async () => {
    const { handler } = setup();
    const main = json(await handler(apiEvent('GET', '/calendar', { query: { portfolioId: 'default', scope: 'holdings' } })));
    expect(new Set(main.events.map((e: { symbol: string }) => e.symbol))).toEqual(new Set(['VWRL.AS']));
    expect(main.summary.annualIncome).toBe(4);
    const usd = json(await handler(apiEvent('GET', '/calendar', { query: { portfolioId: 'usd', scope: 'holdings' } })));
    expect(new Set(usd.events.map((e: { symbol: string }) => e.symbol))).toEqual(new Set(['AAPL']));
    expect(json(await handler(apiEvent('GET', '/calendar', { query: { portfolioId: 'all' } }))).summary.annualIncome).toBe(17.94);
    const missing = await handler(apiEvent('GET', '/calendar', { query: { portfolioId: 'nope' } }));
    expect(missing.statusCode).toBe(404);
  });

  it.each([
    [{ types: 'DIVIDEND' }],
    [{ status: 'later' }],
    [{ scope: 'everything' }],
    [{ from: '2026-02-30' }],
    [{ from: '2026-01-01', to: '2027-02-05' }],
    [{ from: '2026-03-01', to: '2026-02-01' }],
    [{ portfolioId: 'Bad Id!' }],
  ])('answers 400 VALIDATION_ERROR for %j', async (query) => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/calendar', { query }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
  });

  it('accepts a range of exactly 400 days', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/calendar', { query: { from: '2026-01-01', to: '2027-02-04' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res).events.length).toBeGreaterThan(0);
  });

  it('answers 503 FX_UNAVAILABLE when a rate is missing', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    const res = await handler(apiEvent('GET', '/calendar'));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.code).toBe('FX_UNAVAILABLE');
  });

  it('works for a user without transactions (watchlist only) and without a watchlist', async () => {
    const { handler, repo, mgmt } = setup();
    repo.transactions = [];
    const watch = json(await handler(apiEvent('GET', '/calendar')));
    expect(new Set(watch.events.map((e: { origin: string }) => e.origin))).toEqual(new Set(['WATCHLIST']));
    expect(watch.summary).toMatchObject({ annualIncome: 0, yieldPct: 0 });
    mgmt.watchlist = [];
    expect(json(await handler(apiEvent('GET', '/calendar'))).events).toEqual([]);
  });

  it('falls back to the symbol when the profile is unknown', async () => {
    const { handler, repo } = setup();
    repo.profiles = {};
    const body = json(await handler(apiEvent('GET', '/calendar', { query: { types: 'EARNINGS' } })));
    expect(body.events.map((e: { name: string }) => e.name)).toEqual(['MSFT', 'AAPL']);
  });
});

describe('GET /calendar.ics', () => {
  it('downloads the filtered events as an iCalendar file', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/calendar.ics', { query: { types: 'EARNINGS,SPLIT' } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'attachment; filename="portfolio-calendar-2026-05-01_2026-07-31.ics"',
      'cache-control': 'no-store',
    });
    const body = res.body!;
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(body).toContain('UID:earn:AAPL:2026-07-30@portfolio-tracker');
    expect(body).toContain('DTSTART;VALUE=DATE:20260730\r\nDTEND;VALUE=DATE:20260731');
    expect(body).toContain('DTSTAMP:20260615T120000Z');
    expect(body).not.toContain('ex:VWRL.AS');
    expect(body).not.toMatch(/[^\r]\n/);
  });

  it('uses the same validation and scoping as the JSON endpoint', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/calendar.ics', { query: { types: 'nope' } }))).statusCode).toBe(400);
    expect((await handler(apiEvent('GET', '/calendar.ics', { query: { portfolioId: 'nope' } }))).statusCode).toBe(404);
    const holdings = await handler(apiEvent('GET', '/calendar.ics', { query: { scope: 'holdings', portfolioId: 'usd' } }));
    expect(holdings.body).toContain('AAPL');
    expect(holdings.body).not.toContain('MSFT');
  });
});

describe('authentication', () => {
  const sub = (id: string) => `${id}0000000-0000-4000-8000-000000000000`;

  function cognito() {
    const ctx = setup();
    const deps: Deps = { ...ctx.deps, config: { ...ctx.deps.config, authMode: 'cognito' } };
    return { ...ctx, handler: createHandler(() => deps) };
  }

  it('requires a JWT subject on both endpoints', async () => {
    const { handler } = cognito();
    for (const path of ['/calendar', '/calendar.ics']) {
      const res = await handler(apiEvent('GET', path));
      expect(res.statusCode).toBe(401);
      expect(json(res).error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('serves each user only their own data', async () => {
    const { handler, repo, mgmt } = cognito();
    const alice = sub('11111111');
    const bob = sub('22222222');
    repo.transactions = [
      txn({ id: 'a1', userId: alice, date: '2025-01-02', type: 'BUY', symbol: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
      txn({ id: 'b1', userId: bob, date: '2025-01-02', type: 'BUY', symbol: 'KO', quantity: 10, price: 50, currency: 'USD' }),
    ];
    mgmt.watchlist = [{ userId: bob, symbol: 'MSFT', addedAt: '2026-01-01T00:00:00.000Z' }];
    const symbolsOf = async (user: string, path = '/calendar') => {
      const res = await handler(apiEvent('GET', path, { sub: user, query: { from: '2026-01-01', to: '2026-12-31' } }));
      return new Set<string>(json(res).events.map((e: { symbol: string }) => e.symbol));
    };
    expect(await symbolsOf(alice)).toEqual(new Set(['AAPL']));
    expect(await symbolsOf(bob)).toEqual(new Set(['KO', 'MSFT']));
    const ics = await handler(apiEvent('GET', '/calendar.ics', { sub: alice, query: { from: '2026-01-01', to: '2026-12-31' } }));
    expect(ics.body).toContain('AAPL');
    expect(ics.body).not.toMatch(/KO|MSFT/);
    // Identity comes from the token only, never from the query string.
    const spoof = await handler(apiEvent('GET', '/calendar', { sub: alice, query: { userId: bob, from: '2026-01-01', to: '2026-12-31' } }));
    expect(new Set(json(spoof).events.map((e: { symbol: string }) => e.symbol))).toEqual(new Set(['AAPL']));
  });
});
