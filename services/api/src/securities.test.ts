import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { EodPrice } from '@portfolio/shared';
import { createHandler } from './app.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const close = (symbol: string, date: string, value: number, currency = 'EUR'): EodPrice => ({ symbol, date, close: value, currency });

/** Today is 2026-06-15 (fakeDeps). */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main portfolio' }), portfolio({ portfolioId: 'usd', name: 'US broker' })];
  repo.transactions = [
    txn({ id: 't1', date: '2025-06-15', type: 'BUY', symbol: 'ASML.AS', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-12-15', type: 'DIVIDEND', symbol: 'ASML.AS', quantity: 10, price: 1 }),
    txn({ id: 't3', portfolioId: 'usd', date: '2025-06-15', type: 'BUY', symbol: 'AAPL', quantity: 4, price: 125, currency: 'USD' }),
    txn({ id: 't4', portfolioId: 'usd', date: '2025-09-15', type: 'BUY', symbol: 'ASML.AS', quantity: 5, price: 105 }),
    txn({ id: 't5', date: '2026-02-01', type: 'BUY', symbol: 'OLD', quantity: 1, price: 10 }),
    txn({ id: 't6', date: '2026-03-01', type: 'SELL', symbol: 'OLD', quantity: 1, price: 15 }),
    txn({ id: 'other', userId: 'someone-else', date: '2025-07-01', type: 'BUY', symbol: 'ASML.AS', quantity: 99, price: 1 }),
  ];
  repo.quotes = {
    'ASML.AS': { symbol: 'ASML.AS', price: 121, previousClose: 120, currency: 'EUR', asOf: '2026-06-15T17:00:00Z', source: 'test' },
    AAPL: { symbol: 'AAPL', price: 150, previousClose: 150, currency: 'USD', asOf: '2026-06-15T20:00:00Z', source: 'test' },
  };
  repo.profiles = {
    'ASML.AS': { symbol: 'ASML.AS', name: 'ASML Holding', assetClass: 'STOCK', sector: 'Technology', country: 'Netherlands', currency: 'EUR', description: 'Chip tools.', eps: 20 },
    AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', sector: 'Technology', country: 'United States', currency: 'USD' },
    OLD: { symbol: 'OLD', name: 'Old Co', assetClass: 'STOCK', sector: 'Energy', country: 'Germany', currency: 'EUR' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-15T00:00:00Z' };
  repo.eod = [
    close('ASML.AS', '2025-06-15', 100),
    close('ASML.AS', '2025-12-15', 110),
    close('ASML.AS', '2026-06-12', 120),
    close('ASML.AS', '2026-06-15', 121),
    close('AAPL', '2026-06-15', 150, 'USD'),
    close('IWDA.AS', '2025-06-15', 80),
    close('IWDA.AS', '2026-06-15', 96),
  ];
  repo.dividendEvents = [
    { symbol: 'ASML.AS', exDate: '2026-03-01', payDate: '2026-03-10', amount: 2, currency: 'EUR' },
    { symbol: 'ASML.AS', exDate: '2026-07-01', amount: 2, currency: 'EUR' },
  ];
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

describe('GET /assets/{symbol}', () => {
  it('returns profile, quote, stats and dividend history', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/assets/ASML.AS'));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.profile).toMatchObject({ symbol: 'ASML.AS', name: 'ASML Holding', description: 'Chip tools.', country: 'Netherlands' });
    expect(body.quote).toMatchObject({ source: 'quote', price: 121, change: 1, priceBase: 121 });
    expect(body.stats).toMatchObject({ eps: 20, annualDividend: 2, dividendYieldPct: 1.65, payoutRatioPct: 10, nextExDate: '2026-07-01', peRatio: null, nextEarningsDate: null });
    expect(body.dividends.events).toHaveLength(2);
  });

  it('decodes an encoded symbol and answers public data without holding it', async () => {
    const { handler, repo } = setup();
    repo.profiles['BTC-EUR'] = { symbol: 'BTC-EUR', name: 'Bitcoin', assetClass: 'CRYPTO', currency: 'EUR' };
    const res = await handler(apiEvent('GET', '/assets/BTC%2DEUR', { sub: 'newcomer' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ symbol: 'BTC-EUR', quote: null });
  });

  it('is 404 for unknown and reserved symbols', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/assets/NOPE'))).statusCode).toBe(404);
    expect(json(await handler(apiEvent('GET', '/assets/NOPE'))).error.code).toBe('NOT_FOUND');
    expect((await handler(apiEvent('GET', '/assets/CASH.EUR'))).statusCode).toBe(404);
    expect((await handler(apiEvent('GET', '/assets/CUSTOM%3Aabc'))).statusCode).toBe(404);
  });
});

describe('GET /assets/{symbol}/history', () => {
  it('returns the series, the benchmark and the user markers of the scope', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { range: '1Y', benchmarks: 'iwda.as' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ symbol: 'ASML.AS', range: '1Y', currency: 'EUR' });
    expect(body.benchmarks).toHaveLength(1);
    expect(body.benchmarks[0]).toMatchObject({ symbol: 'IWDA.AS', available: true });
    expect(body.benchmarks[0].points.at(-1)).toEqual({ value: 96, returnPct: 20 });
    expect(body.points.at(-1)).toMatchObject({ date: '2026-06-15', close: 121 });
    // Held symbols and the suggestions with prices are offered as benchmarks, those with data first.
    expect(body.options.find((o: { symbol: string }) => o.symbol === 'IWDA.AS')).toMatchObject({ hasData: true });
    expect(body.options.find((o: { symbol: string }) => o.symbol === 'AAPL')).toMatchObject({ hasData: true });
    expect(body.markers.map((m: { type: string; portfolioId: string }) => `${m.type}:${m.portfolioId}`)).toEqual(['BUY:default', 'BUY:usd', 'DIVIDEND:default']);
  });

  it('scopes the markers to one portfolio; benchmarks default like Growth and can be switched off', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { portfolioId: 'usd', range: 'ALL' } })));
    expect(body.benchmarks.map((b: { symbol: string }) => b.symbol)).toEqual(['IWDA.AS']);
    const none = json(await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { benchmarks: '' } })));
    expect(none.benchmarks).toEqual([]);
    expect(body.markers).toHaveLength(1);
    expect(body.markers[0].portfolioId).toBe('usd');
    const five = json(await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { range: '5Y' } })));
    expect(five.points[0].date).toBe('2025-06-15');
  });

  it('never leaks markers of other users', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/assets/ASML.AS/history', { sub: 'someone-else', query: { range: 'ALL' } })));
    expect(body.markers).toHaveLength(1);
    expect(body.markers[0].quantity).toBe(99);
  });

  it('validates the query, the scope and the symbol', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { range: '2Y' } }))).statusCode).toBe(400);
    expect((await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { benchmarks: 'no good' } }))).statusCode).toBe(400);
    expect((await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { portfolioId: 'nope' } }))).statusCode).toBe(404);
    expect((await handler(apiEvent('GET', '/assets/NOPE/history'))).statusCode).toBe(404);
  });

  it('reports an unknown benchmark as unavailable', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/assets/ASML.AS/history', { query: { benchmarks: 'ZZZ' } })));
    expect(body.benchmarks[0]).toMatchObject({ symbol: 'ZZZ', available: false });
  });

  it('still answers for a symbol only known from the user transactions', async () => {
    const { handler, repo } = setup();
    repo.profiles = {};
    repo.eod = repo.eod.filter((p) => p.symbol !== 'OLD');
    const res = await handler(apiEvent('GET', '/assets/OLD/history', { query: { range: 'ALL' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res).points).toEqual([]);
    expect(json(res).markers).toEqual([]);
  });
});

describe('GET /assets/{symbol}/positions', () => {
  it('lists one position per portfolio with the weight in that portfolio', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/assets/ASML.AS/positions'));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.positions.map((p: { portfolioId: string; portfolioName: string }) => [p.portfolioId, p.portfolioName])).toEqual([['default', 'Main portfolio'], ['usd', 'US broker']]);
    const main = body.positions[0];
    expect(main).toMatchObject({ status: 'open', quantity: 10, averageCostBase: 100, marketValue: 1210, unrealizedPnl: 210, dividendsReceived: 10, profit: 220 });
    // The portfolio holds only ASML.AS: 1210 of 1210.
    expect(main.weight).toBe(1);
    // The US broker also holds 4 AAPL (480 EUR): 605 / (605 + 480).
    expect(body.positions[1].weight).toBeCloseTo(0.5576, 3);
    expect(body.totals).toMatchObject({ quantity: 15 });
    expect(body.received).toEqual([expect.objectContaining({ date: '2025-12-15', amount: 10, portfolioId: 'default' })]);
  });

  it('honours the scope and has no totals for a single portfolio', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/assets/ASML.AS/positions', { query: { portfolioId: 'usd' } })));
    expect(body.positions).toHaveLength(1);
    expect(body.totals).toBeNull();
    expect(body.received).toEqual([]);
  });

  it('is empty for a symbol the user does not hold and isolates users', async () => {
    const { handler } = setup();
    expect(json(await handler(apiEvent('GET', '/assets/AAPL/positions', { sub: 'newcomer' }))).positions).toEqual([]);
    const other = json(await handler(apiEvent('GET', '/assets/ASML.AS/positions', { sub: 'someone-else' })));
    expect(other.positions.map((p: { quantity: number }) => p.quantity)).toEqual([99]);
  });

  it('rejects an unknown portfolio and reserved symbols', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/assets/ASML.AS/positions', { query: { portfolioId: 'nope' } }))).statusCode).toBe(404);
    expect((await handler(apiEvent('GET', '/assets/CASH.EUR/positions'))).statusCode).toBe(404);
  });
});

describe('GET /securities/closed', () => {
  it('lists sold-out symbols of the scope only', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/securities/closed')));
    expect(body.securities).toEqual([expect.objectContaining({ symbol: 'OLD', name: 'Old Co', realizedPnl: 5, profit: 5, lastSoldDate: '2026-03-01' })]);
    const usd = json(await handler(apiEvent('GET', '/securities/closed', { query: { portfolioId: 'usd' } })));
    expect(usd.securities).toEqual([]);
  });

  it('works without any transaction', async () => {
    const { handler } = setup();
    expect(json(await handler(apiEvent('GET', '/securities/closed', { sub: 'newcomer' }))).securities).toEqual([]);
  });
});
