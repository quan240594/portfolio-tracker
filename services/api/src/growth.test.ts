import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { EodPrice } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const close = (symbol: string, date: string, value: number, currency = 'EUR'): EodPrice => ({ symbol, date, close: value, currency });

/** Today is 2026-06-15 (fakeDeps). VWRL.AS: bought 10 on 2025-06-15 at 100, now 121 (+21 %); IWDA.AS goes 80 → 96 (+20 %). */
function setup() {
  const ctx = fakeDeps();
  const { repo, mgmt } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main portfolio' }), portfolio({ portfolioId: 'usd', name: 'US broker' })];
  repo.transactions = [
    txn({ id: 't1', date: '2025-06-15', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-12-15', type: 'DIVIDEND', symbol: 'VWRL.AS', quantity: 10, price: 1 }),
    txn({ id: 't3', portfolioId: 'usd', date: '2025-06-15', type: 'BUY', symbol: 'AAPL', quantity: 4, price: 125, currency: 'USD' }),
    txn({ id: 't4', portfolioId: 'usd', date: '2025-06-15', type: 'DEPOSIT', symbol: 'CASH.USD', quantity: 1000, price: 1, currency: 'USD' }),
    txn({ id: 'other', userId: 'someone-else', date: '2025-01-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 1, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 121, previousClose: 120, currency: 'EUR', asOf: '2026-06-15T17:00:00Z', source: 'test' },
    AAPL: { symbol: 'AAPL', price: 150, previousClose: 150, currency: 'USD', asOf: '2026-06-15T20:00:00Z', source: 'test' },
  };
  repo.profiles = {
    'VWRL.AS': { symbol: 'VWRL.AS', name: 'Vanguard All-World', assetClass: 'ETF', sector: 'Diversified', country: 'Global', currency: 'EUR' },
    AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', sector: 'Technology', country: 'United States', currency: 'USD' },
    NVDA: { symbol: 'NVDA', name: 'NVIDIA', assetClass: 'STOCK', sector: 'Technology', country: 'United States', currency: 'USD' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-15T00:00:00Z' };
  repo.eod = [
    close('VWRL.AS', '2025-06-15', 100),
    close('VWRL.AS', '2025-12-15', 110),
    close('VWRL.AS', '2026-06-15', 121),
    close('AAPL', '2025-06-15', 125, 'USD'),
    close('AAPL', '2026-06-15', 150, 'USD'),
    close('IWDA.AS', '2025-06-15', 80),
    close('IWDA.AS', '2026-06-15', 96),
    close('NVDA', '2026-06-10', 100, 'USD'),
  ];
  mgmt.watchlist = [
    { userId: 'demo', symbol: 'NVDA', addedAt: '2026-01-01T00:00:00Z' },
    { userId: 'demo', symbol: 'WATCHED', addedAt: '2026-01-02T00:00:00Z' },
  ];
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

describe('GET /analytics/growth', () => {
  it('returns series, benchmark replay, headline and options for the default benchmark', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/growth', { query: { portfolioId: 'default', range: 'ALL' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ range: 'ALL', baseCurrency: 'EUR' });
    expect(body.period).toMatchObject({ from: '2025-06-15', to: '2026-06-15', startValue: 1000, invested: 1000 });
    // hand check: 10 × 121 = 1210 plus 10 dividend → +22 % money; TWR +21 % price and +1 % dividend
    expect(body.period.endValue).toBeCloseTo(1220, 0);
    expect(body.period.gain).toBeCloseTo(220, 0);
    expect(body.period.returnPct).toBeGreaterThan(21);
    expect(body.series[0]).toEqual({ date: '2025-06-15', value: 1000, invested: 1000, returnPct: 0 });
    expect(body.benchmarks).toHaveLength(1);
    expect(body.benchmarks[0]).toMatchObject({ symbol: 'IWDA.AS', available: true });
    expect(body.benchmarks[0].points).toHaveLength(body.series.length);
    expect(body.benchmarks[0].points.at(-1)).toMatchObject({ returnPct: 20 });
    expect(body.benchmarks[0].points.at(-1).value).toBeCloseTo(1200, 0);
    expect(body.headline).toMatchObject({ symbol: 'IWDA.AS', benchmarkReturnPct: 20 });
    expect(body.headline.amount).toBeCloseTo(20, 0);
    expect(body.monthly[0]).toMatchObject({ month: '2025-06' });
  });

  it('supports several benchmarks, an empty list, and says so when one has no data', async () => {
    const { handler } = setup();
    const many = json(await handler(apiEvent('GET', '/analytics/growth', { query: { range: '1Y', benchmarks: 'iwda.as,VWCE.DE,VWRL.AS' } })));
    expect(many.benchmarks.map((b: { symbol: string; available: boolean }) => [b.symbol, b.available])).toEqual([
      ['IWDA.AS', true],
      ['VWCE.DE', false],
      ['VWRL.AS', true],
    ]);
    expect(many.benchmarks[1].message).toContain('VWCE.DE');
    expect(many.benchmarks[1].points.every((p: { value: unknown }) => p.value === null)).toBe(true);
    const none = json(await handler(apiEvent('GET', '/analytics/growth', { query: { benchmarks: '' } })));
    expect(none.benchmarks).toEqual([]);
    expect(none.headline).toBeNull();
    expect(none.series.length).toBeGreaterThan(0);
  });

  it('lists tracked symbols with data first, then watchlist and suggestions, without cash or other users symbols', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/analytics/growth', { query: { benchmarks: 'ZZZ.TEST' } })));
    const bySymbol = Object.fromEntries(body.options.map((o: { symbol: string }) => [o.symbol, o]));
    expect(bySymbol['VWRL.AS']).toEqual({ symbol: 'VWRL.AS', name: 'Vanguard All-World', hasData: true });
    expect(bySymbol['IWDA.AS']).toEqual({ symbol: 'IWDA.AS', name: 'iShares Core MSCI World', hasData: true });
    expect(bySymbol.NVDA).toEqual({ symbol: 'NVDA', name: 'NVIDIA', hasData: true });
    expect(bySymbol.AAPL.hasData).toBe(true);
    expect(bySymbol.WATCHED).toEqual({ symbol: 'WATCHED', hasData: false });
    expect(bySymbol['ZZZ.TEST'].hasData).toBe(false);
    expect(bySymbol['VWCE.DE'].hasData).toBe(false);
    expect(bySymbol['CASH.USD']).toBeUndefined();
    expect(bySymbol.MSFT).toBeUndefined();
    const withData = body.options.filter((o: { hasData: boolean }) => o.hasData).length;
    expect(body.options.slice(0, withData).every((o: { hasData: boolean }) => o.hasData)).toBe(true);
  });

  it('honours the portfolio scope and returns 404 for an unknown one', async () => {
    const { handler } = setup();
    const usd = json(await handler(apiEvent('GET', '/analytics/growth', { query: { portfolioId: 'usd', range: 'ALL' } })));
    expect(usd.period.startValue).toBe(400);
    expect(usd.period.returnPct).toBeCloseTo(20, 0);
    const all = json(await handler(apiEvent('GET', '/analytics/growth', { query: { portfolioId: 'all', range: 'ALL' } })));
    expect(all.period.startValue).toBe(1400);
    expect((await handler(apiEvent('GET', '/analytics/growth', { query: { portfolioId: 'nope' } }))).statusCode).toBe(404);
  });

  it('works for a user without transactions', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/growth', { sub: 'newcomer' }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ period: null, series: [], headline: null, monthly: [] });
    expect(body.benchmarks[0]).toMatchObject({ symbol: 'IWDA.AS', available: false });
    expect(body.options.length).toBeGreaterThan(0);
  });

  it('rejects invalid ranges and benchmark lists with the error envelope', async () => {
    const { handler } = setup();
    const invalid: Record<string, string>[] = [{ range: '2Y' }, { benchmarks: 'A,B,C,D' }, { benchmarks: 'no good' }, { portfolioId: 'Bad Id!' }];
    for (const query of invalid) {
      const res = await handler(apiEvent('GET', '/analytics/growth', { query }));
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(json(res).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
    }
  });

  it('answers 503 FX_UNAVAILABLE when a rate is missing', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    expect((await handler(apiEvent('GET', '/analytics/growth'))).statusCode).toBe(503);
  });
});

describe('GET /analytics/holdings-performance', () => {
  it('returns the return of every open holding, best first', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/analytics/holdings-performance', { query: { range: 'ALL' } })));
    expect(body).toMatchObject({ range: 'ALL', baseCurrency: 'EUR', from: '2025-06-15', to: '2026-06-15' });
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['VWRL.AS', 'AAPL']);
    expect(body.holdings[0]).toMatchObject({ name: 'Vanguard All-World', sincePurchase: false, from: '2025-06-15' });
    // 1.21 × (1 + 10 / 1100) from the price and the dividend
    expect(body.holdings[0].returnPct).toBeCloseTo(22.1, 1);
    expect(body.holdings[0].gain).toBeCloseTo(220, 0);
    expect(body.holdings[1].returnPct).toBeCloseTo(20, 0);
  });

  it('defaults to one year, honours the scope and validates the query', async () => {
    const { handler } = setup();
    expect(json(await handler(apiEvent('GET', '/analytics/holdings-performance'))).range).toBe('1Y');
    const usd = json(await handler(apiEvent('GET', '/analytics/holdings-performance', { query: { portfolioId: 'usd', range: '6M' } })));
    expect(usd.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['AAPL']);
    expect((await handler(apiEvent('GET', '/analytics/holdings-performance', { query: { range: 'forever' } }))).statusCode).toBe(400);
    expect((await handler(apiEvent('GET', '/analytics/holdings-performance', { query: { portfolioId: 'nope' } }))).statusCode).toBe(404);
    const empty = json(await handler(apiEvent('GET', '/analytics/holdings-performance', { sub: 'newcomer' })));
    expect(empty).toMatchObject({ from: null, holdings: [] });
  });
});
