import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { EodPrice } from '@portfolio/shared';
import { createHandler } from './app.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const close = (symbol: string, date: string, value: number, currency = 'EUR'): EodPrice => ({ symbol, date, close: value, currency });
const day = (k: number): string => new Date(Date.UTC(2025, 5, 15 + k)).toISOString().slice(0, 10);

/**
 * Today is 2026-06-15 (fakeDeps). Default portfolio: 10 Alpha (P/E 20) and 10 Beta (P/E 40), equal value, plus a World ETF:
 * harmonic P/E 26.67, not 30. The "usd" portfolio holds Gamma (no P/E).
 */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main portfolio' }), portfolio({ portfolioId: 'usd', name: 'US broker' })];
  repo.transactions = [
    txn({ id: 't1', date: '2025-06-15', type: 'BUY', symbol: 'ALPHA', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-06-15', type: 'BUY', symbol: 'BETA', quantity: 10, price: 100 }),
    txn({ id: 't3', date: '2025-06-15', type: 'BUY', symbol: 'WRLD', quantity: 10, price: 100 }),
    txn({ id: 't4', portfolioId: 'usd', date: '2025-06-15', type: 'BUY', symbol: 'GAMMA', quantity: 4, price: 125, currency: 'USD' }),
    txn({ id: 'other', userId: 'someone-else', date: '2025-01-01', type: 'BUY', symbol: 'ALPHA', quantity: 1, price: 1 }),
  ];
  const quote = (symbol: string, price: number, currency = 'EUR') => ({ symbol, price, previousClose: price, currency, asOf: '2026-06-15T17:00:00Z', source: 'test' });
  repo.quotes = { ALPHA: quote('ALPHA', 150), BETA: quote('BETA', 150), WRLD: quote('WRLD', 110), GAMMA: quote('GAMMA', 150, 'USD') };
  repo.profiles = {
    ALPHA: { symbol: 'ALPHA', name: 'Alpha', assetClass: 'STOCK', currency: 'EUR', peRatio: 20, fundamentalsAsOf: '2026-05-01' },
    BETA: { symbol: 'BETA', name: 'Beta', assetClass: 'STOCK', currency: 'EUR', peRatio: 40, fundamentalsAsOf: '2026-04-01' },
    WRLD: { symbol: 'WRLD', name: 'World ETF', assetClass: 'ETF', currency: 'EUR' },
    GAMMA: { symbol: 'GAMMA', name: 'Gamma', assetClass: 'STOCK', currency: 'USD' },
    'IWDA.AS': { symbol: 'IWDA.AS', name: 'iShares World', assetClass: 'ETF', currency: 'EUR', peRatio: 19.5 },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-15T00:00:00Z' };
  repo.eod = [];
  for (let k = 0; k <= 365; k++) {
    const date = day(k);
    repo.eod.push(
      close('ALPHA', date, 100 + k * 0.1 + 2 * Math.sin(k)),
      close('BETA', date, 100 + k * 0.1 + 3 * Math.cos(k)),
      close('WRLD', date, 100 + k * 0.03 + Math.sin(k / 3)),
      close('GAMMA', date, 125 + k * 0.05, 'USD'),
      close('IWDA.AS', date, 80 + k * 0.04 + Math.sin(k / 2)),
    );
  }
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

describe('GET /analytics/metrics', () => {
  it('returns the five cards for the combined portfolios', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/metrics', { query: { portfolioId: 'default' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ baseCurrency: 'EUR', riskFreeRatePct: 2.5, benchmark: { symbol: 'IWDA.AS', available: true } });

    expect(body.pe.portfolio).toBeGreaterThan(26);
    expect(body.pe.portfolio).toBeLessThan(27.5);
    expect(body.pe.benchmark).toBe(19.5);
    expect(body.pe.coverage).toMatchObject({ includedStocks: 2, totalStocks: 2, nonStockHoldings: 1 });
    expect(body.pe.asOf).toBe('2026-04-01');
    expect(body.pe.excluded).toEqual([]);

    expect(body.twr).toMatchObject({ from: '2025-06-15', to: '2026-06-15', days: 365 });
    expect(typeof body.twr.portfolio).toBe('number');
    expect(typeof body.twr.benchmark).toBe('number');
    expect(body.twr.difference).toBeCloseTo(body.twr.portfolio - body.twr.benchmark, 1);

    for (const key of ['volatility', 'sharpe', 'sortino']) {
      expect(body[key].observations).toBeGreaterThan(200);
      expect(typeof body[key].portfolio).toBe('number');
      expect(typeof body[key].benchmark).toBe('number');
      expect(body[key].verdict).toMatchObject({ level: expect.any(String), label: expect.any(String), tone: expect.any(String) });
    }
    expect(typeof body.volatility.beta).toBe('number');
  });

  it('honours the portfolio scope: a stock without P/E gives an empty P/E, and unknown portfolios 404', async () => {
    const { handler } = setup();
    const usd = json(await handler(apiEvent('GET', '/analytics/metrics', { query: { portfolioId: 'usd' } })));
    expect(usd.pe.portfolio).toBeNull();
    expect(usd.pe.coverage).toMatchObject({ includedStocks: 0, totalStocks: 1 });
    expect(usd.pe.excluded).toEqual([expect.objectContaining({ symbol: 'GAMMA', reason: 'missing' })]);
    const all = json(await handler(apiEvent('GET', '/analytics/metrics', { query: { portfolioId: 'all' } })));
    expect(all.pe.coverage.totalStocks).toBe(3);
    const omitted = json(await handler(apiEvent('GET', '/analytics/metrics')));
    expect(omitted.pe).toEqual(all.pe);
    const missing = await handler(apiEvent('GET', '/analytics/metrics', { query: { portfolioId: 'nope' } }));
    expect(missing.statusCode).toBe(404);
    expect(json(missing).error.code).toBeDefined();
  });

  it('switches the benchmark and explains one without data instead of failing', async () => {
    const { handler } = setup();
    const unknown = await handler(apiEvent('GET', '/analytics/metrics', { query: { benchmark: 'vwce.de', portfolioId: 'default' } }));
    expect(unknown.statusCode).toBe(200);
    const body = json(unknown);
    expect(body.benchmark).toMatchObject({ symbol: 'VWCE.DE', available: false, message: expect.stringContaining('VWCE.DE') });
    expect(body.twr.benchmark).toBeNull();
    expect(body.pe.benchmark).toBeNull();
    expect(body.volatility.benchmark).toBeNull();
    expect(typeof body.sharpe.portfolio).toBe('number');
  });

  it('rejects an invalid benchmark or scope with the error envelope', async () => {
    const { handler } = setup();
    const bad = await handler(apiEvent('GET', '/analytics/metrics', { query: { benchmark: 'no good' } }));
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
    expect((await handler(apiEvent('GET', '/analytics/metrics', { query: { portfolioId: 'Bad Id!' } }))).statusCode).toBe(400);
  });

  it('works for a user without transactions and answers under the /api prefix', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/api/analytics/metrics', { sub: 'newcomer' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ twr: { portfolio: null, from: null }, pe: { portfolio: null }, benchmark: { available: false } });
  });

  it('answers 503 FX_UNAVAILABLE when a rate is missing', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    const res = await handler(apiEvent('GET', '/analytics/metrics', { query: { portfolioId: 'usd' } }));
    expect(res.statusCode).toBe(503);
  });
});
