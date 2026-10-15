import { describe, expect, it } from 'vitest';
import type { DividendsOverviewResponse } from '@portfolio/shared';
import { createHandler } from './app.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

/** Today is 2026-06-15 (fakeDeps). */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main portfolio' }), portfolio({ portfolioId: 'usd', name: 'US broker' })];
  repo.transactions = [
    txn({ id: 't1', date: '2025-01-02', type: 'BUY', symbol: 'VWRL.AS', quantity: 100, price: 100 }),
    txn({ id: 't2', date: '2025-09-01', type: 'DIVIDEND', symbol: 'VWRL.AS', quantity: 100, price: 0.5 }),
    txn({ id: 't3', date: '2026-03-01', type: 'DIVIDEND', symbol: 'VWRL.AS', quantity: 100, price: 0.5 }),
    txn({ id: 't4', portfolioId: 'usd', date: '2025-06-15', type: 'BUY', symbol: 'AAPL', quantity: 4, price: 125, currency: 'USD' }),
    txn({ id: 'other', userId: 'someone-else', date: '2025-01-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 1, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 110, previousClose: 110, currency: 'EUR', asOf: '2026-06-15T17:00:00Z', source: 'test' },
    AAPL: { symbol: 'AAPL', price: 150, previousClose: 150, currency: 'USD', asOf: '2026-06-15T20:00:00Z', source: 'test' },
  };
  repo.profiles = {
    'VWRL.AS': { symbol: 'VWRL.AS', name: 'Vanguard All-World', assetClass: 'ETF', sector: 'Diversified', country: 'Global', currency: 'EUR' },
    AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', sector: 'Technology', country: 'United States', currency: 'USD' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-15T00:00:00Z' };
  repo.dividendEvents = [
    { symbol: 'VWRL.AS', exDate: '2026-08-20', payDate: '2026-09-01', amount: 0.5, currency: 'EUR' },
    { symbol: 'VWRL.AS', exDate: '2025-02-20', payDate: '2025-03-01', amount: 0.4, currency: 'EUR' },
  ];
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null') as DividendsOverviewResponse;

describe('GET /dividends/overview', () => {
  it('returns forward income, future months and per-holding consistency for all portfolios', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/dividends/overview'));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.baseCurrency).toBe('EUR');
    expect(body.asOf).toBe('2026-06-15');
    // VWRL: 100 shares; 0.5 declared for September and one estimated payment (semi-annual: 2025-09, 2026-03)
    expect(body.summary).toMatchObject({ forward12m: 100, declared: 50, estimated: 50, monthlyAverage: 8.33, last12m: 100, growthVsLast12mPct: 0 });
    expect(body.holdings.map((h) => h.symbol)).toEqual(['VWRL.AS']);
    expect(body.holdings[0]).toMatchObject({ name: 'Vanguard All-World', marketValue: 11000, yieldPct: 0.91, sharePct: 100 });
    // the stored past event (2025-03-01) extends the received history
    expect(body.holdings[0]!.consistency).toMatchObject({ payments: 3, paymentsPerYear: 2 });
    expect(body.futureMonths).toHaveLength(12);
    expect(body.futureMonths.find((m) => m.month === '2026-09')).toEqual({ month: '2026-09', declared: 50, estimated: 0 });
    expect(body.futureMonths.find((m) => m.month === '2027-03')).toEqual({ month: '2027-03', declared: 0, estimated: 50 });
    // the same income per holding: the per-holding amounts add up to the forward income
    expect(body.futureByHolding).toEqual([
      { month: '2026-09', symbol: 'VWRL.AS', declared: 50, estimated: 0 },
      { month: '2027-03', symbol: 'VWRL.AS', declared: 0, estimated: 50 },
    ]);
  });

  it('honours ?portfolioId= and never leaks other users or unknown portfolios', async () => {
    const { handler } = setup();
    const main = json(await handler(apiEvent('GET', '/dividends/overview', { query: { portfolioId: 'default' } })));
    expect(main.holdings.map((h) => h.symbol)).toEqual(['VWRL.AS']);
    const usd = json(await handler(apiEvent('GET', '/dividends/overview', { query: { portfolioId: 'usd' } })));
    expect(usd.holdings).toEqual([]);
    expect(usd.summary.forward12m).toBe(0);
    expect(usd.futureMonths).toHaveLength(12);
    expect(usd.futureByHolding).toEqual([]);
    const all = json(await handler(apiEvent('GET', '/dividends/overview', { query: { portfolioId: 'all' } })));
    expect(all.holdings.map((h) => h.symbol)).toEqual(['VWRL.AS']);
    expect((await handler(apiEvent('GET', '/dividends/overview', { query: { portfolioId: 'nope' } }))).statusCode).toBe(404);
    const bad = await handler(apiEvent('GET', '/dividends/overview', { query: { portfolioId: 'Bad Id!' } }));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body!)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('answers with empty data for a user without transactions', async () => {
    const ctx = fakeDeps();
    const handler = createHandler(() => ctx.deps);
    const res = await handler(apiEvent('GET', '/dividends/overview'));
    expect(res.statusCode).toBe(200);
    expect(json(res).holdings).toEqual([]);
  });
});
