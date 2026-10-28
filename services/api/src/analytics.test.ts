import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { EodPrice } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const close = (symbol: string, date: string, value: number, currency = 'EUR'): EodPrice => ({ symbol, date, close: value, currency });

/** Today is 2026-06-15 (fakeDeps). VWRL.AS: bought 10 on 2025-06-15 at 100, now 121 → +21 % in exactly 365 days. */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main portfolio' }), portfolio({ portfolioId: 'usd', name: 'US broker' })];
  repo.transactions = [
    txn({ id: 't1', date: '2025-06-15', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-12-15', type: 'DIVIDEND', symbol: 'VWRL.AS', quantity: 10, price: 1 }),
    txn({ id: 't3', portfolioId: 'usd', date: '2025-06-15', type: 'BUY', symbol: 'AAPL', quantity: 4, price: 125, currency: 'USD' }),
    txn({ id: 'other', userId: 'someone-else', date: '2025-01-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 1, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 121, previousClose: 120, currency: 'EUR', asOf: '2026-06-15T17:00:00Z', source: 'test' },
    AAPL: { symbol: 'AAPL', price: 150, previousClose: 150, currency: 'USD', asOf: '2026-06-15T20:00:00Z', source: 'test' },
  };
  repo.profiles = {
    'VWRL.AS': { symbol: 'VWRL.AS', name: 'Vanguard All-World', assetClass: 'ETF', sector: 'Diversified', country: 'Global', currency: 'EUR' },
    AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', sector: 'Technology', country: 'United States', currency: 'USD' },
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
  ];
  repo.dividendEvents = [{ symbol: 'VWRL.AS', exDate: '2026-07-01', payDate: '2026-07-10', amount: 1, currency: 'EUR' }];
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

describe('GET /analytics/summary', () => {
  it('combines every portfolio: IRR/TWR, passive income, movers and insights', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/summary'));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.baseCurrency).toBe('EUR');
    expect(body.performance).toMatchObject({ since: '2025-06-15', days: 365, irrAnnualised: true });
    // VWRL 1000 → 1210 (+210 and a 10 dividend), AAPL 4 × 125 USD = 400 EUR → 480 EUR: +80
    expect(body.performance.irrPct).toBeGreaterThan(20);
    expect(body.performance.irrPct).toBeLessThan(23);
    expect(body.performance.twrPct).toBeGreaterThan(20);
    expect(body.passiveIncome.forward12m).toBeGreaterThan(0);
    expect(body.gainers.map((g: { symbol: string }) => g.symbol)).toEqual(['VWRL.AS']);
    expect(body.insights.map((i: { id: string }) => i.id)).toContain('concentration-top-holding');
  });

  it('honours ?portfolioId= and rejects other users data and unknown portfolios', async () => {
    const { handler } = setup();
    const usd = json(await handler(apiEvent('GET', '/analytics/summary', { query: { portfolioId: 'usd' } })));
    // 4 × 125 USD → 4 × 150 USD at 1.25: +20 % in 365 days
    expect(usd.performance.irrPct).toBeCloseTo(20, 0);
    expect(usd.gainers).toEqual([]);
    const all = json(await handler(apiEvent('GET', '/analytics/summary', { query: { portfolioId: 'all' } })));
    expect(all.performance.irrPct).not.toBe(usd.performance.irrPct);
    const res = await handler(apiEvent('GET', '/analytics/summary', { query: { portfolioId: 'nope' } }));
    expect(res.statusCode).toBe(404);
    expect((await handler(apiEvent('GET', '/analytics/summary', { query: { portfolioId: 'Bad Id!' } }))).statusCode).toBe(400);
  });

  it('adds the figures of the window for ?period= and only then', async () => {
    const { handler } = setup();
    expect(json(await handler(apiEvent('GET', '/analytics/summary'))).periodPerformance).toBeUndefined();
    expect(json(await handler(apiEvent('GET', '/analytics/summary', { query: { period: '' } }))).periodPerformance).toBeUndefined();
    const ytd = json(await handler(apiEvent('GET', '/analytics/summary', { query: { period: 'ytd' } }))).periodPerformance;
    // 2026-06-15: the year started at 110 for the 10 VWRL shares and 400 → 480 EUR for AAPL
    expect(ytd).toMatchObject({ period: 'ytd', from: '2026-01-01', to: '2026-06-15', truncated: false, dividends: 0, realizedPnl: 0 });
    const ten = json(await handler(apiEvent('GET', '/analytics/summary', { query: { period: '10y' } }))).periodPerformance;
    expect(ten).toMatchObject({ truncated: true, from: '2025-06-15', dividends: 10 });
    expect((await handler(apiEvent('GET', '/analytics/summary', { query: { period: '3y' } }))).statusCode).toBe(400);
  });

  it('works for a user without transactions', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/summary', { sub: 'newcomer' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ performance: { since: null, irrPct: null }, insights: [], gainers: [], losers: [] });
  });

  it('answers 503 FX_UNAVAILABLE when a rate is missing', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    const res = await handler(apiEvent('GET', '/analytics/summary'));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.code).toBe('FX_UNAVAILABLE');
  });
});

describe('GET /analytics/returns', () => {
  it('returns period rows, yearly by default', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/returns', { query: { portfolioId: 'default' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.period).toBe('year');
    expect(body.rows.map((r: { period: string }) => r.period)).toEqual(['2025', '2026']);
    expect(body.rows[0]).toMatchObject({ start: '2025-06-15', startValue: 1000, contributions: 0, income: 10 });
    const months = json(await handler(apiEvent('GET', '/analytics/returns', { query: { period: 'month', portfolioId: 'default' } })));
    expect(months.rows).toHaveLength(13);
  });

  it('rejects an unknown period', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/returns', { query: { period: 'decade' } }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /analytics/risk', () => {
  it('computes risk metrics with the default benchmark', async () => {
    const { handler, repo } = setup();
    // daily closes make a real series
    repo.eod = repo.eod.filter((e) => e.symbol !== 'VWRL.AS' && e.symbol !== 'IWDA.AS');
    for (let k = 0; k <= 365; k++) {
      const date = new Date(Date.UTC(2025, 5, 15 + k)).toISOString().slice(0, 10);
      repo.eod.push(close('VWRL.AS', date, 100 + k * 0.0575 + Math.sin(k)), close('IWDA.AS', date, 80 + k * 0.04 + Math.sin(k / 2)));
    }
    const res = await handler(apiEvent('GET', '/analytics/risk', { query: { portfolioId: 'default' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.benchmark).toMatchObject({ symbol: 'IWDA.AS', available: true });
    expect(body.observations).toBeGreaterThan(200);
    expect(body.volatilityPct).toBeGreaterThan(0);
    expect(body.maxDrawdown.depthPct).toBeLessThan(0);
    expect(typeof body.benchmark.beta).toBe('number');
  });

  it('reports a benchmark without data instead of failing', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/risk', { query: { benchmark: 'vwce.de' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res).benchmark).toMatchObject({ symbol: 'VWCE.DE', available: false, message: expect.stringContaining('VWCE.DE') });
    expect((await handler(apiEvent('GET', '/analytics/risk', { query: { benchmark: 'no good' } }))).statusCode).toBe(400);
  });
});

describe('GET /analytics/benchmark', () => {
  it('replays the benchmark with the same flows', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/benchmark', { query: { portfolioId: 'default', range: 'ALL' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ range: 'ALL', baseCurrency: 'EUR', benchmark: { symbol: 'IWDA.AS', available: true } });
    // 1000 invested in IWDA.AS: 80 → 96 is +20 %; the portfolio made +21 % + 10 dividends on top
    expect(body.comparison).toMatchObject({ from: '2025-06-15', to: '2026-06-15', benchmarkReturnPct: 20, benchmarkGain: 200 });
    expect(body.comparison.portfolioGain).toBeCloseTo(220, 0);
    expect(body.points[0]).toMatchObject({ date: '2025-06-15', portfolio: 1000, benchmark: 1000, invested: 1000 });
  });

  it('says so when the benchmark has no end-of-day data', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/benchmark', { query: { benchmark: 'VWRL.AS', range: '6M' } }));
    expect(json(res).benchmark.available).toBe(true);
    const none = json(await handler(apiEvent('GET', '/analytics/benchmark', { query: { benchmark: 'MISSING' } })));
    expect(none.benchmark).toMatchObject({ available: false, message: expect.stringContaining('MISSING') });
    expect(none.comparison).toBeNull();
    expect(none.points.length).toBeGreaterThan(0);
  });

  it('validates range and benchmark', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/analytics/benchmark', { query: { range: '99Y' } }))).statusCode).toBe(400);
    expect((await handler(apiEvent('GET', '/analytics/benchmark', { query: { benchmark: '' } }))).statusCode).toBe(400);
  });
});

describe('GET /analytics/dividend-growth', () => {
  it('returns growth by year, month and per share', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/dividend-growth', { query: { portfolioId: 'default' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      baseCurrency: 'EUR',
      byYear: [{ year: '2025', total: 10, payments: 1, yoyPct: null, partial: false }],
      byMonth: [{ month: '2025-12', total: 10 }],
      perShare: [{ symbol: 'VWRL.AS', years: [{ year: '2025', perShare: 1 }] }],
      growthStats: { asOf: '2026-06-15', qoq: { basis: 'QUARTER', change: -10, pct: -100 }, yoy: null, cagr: null },
    });
    const none = await handler(apiEvent('GET', '/analytics/dividend-growth', { query: { portfolioId: 'usd' } }));
    expect(json(none).byYear).toEqual([]);
  });
});

describe('GET /analytics/goal', () => {
  it('projects three scenarios from the portfolio income', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/analytics/goal', { query: { portfolioId: 'default' } }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.inputs).toMatchObject({ targetIncome: 12_000, dividendGrowthPct: 5, yieldOnNewMoneyPct: 3.5, monthlyContribution: 250, years: 30, reinvestDividends: true, currentValue: 1210 });
    expect(body.scenarios.map((s: { id: string }) => s.id)).toEqual(['cautious', 'base', 'optimistic']);
    expect(body.scenarios[1].points).toHaveLength(31);
  });

  it('applies query parameters', async () => {
    const { handler } = setup();
    const res = await handler(
      apiEvent('GET', '/analytics/goal', { query: { targetIncome: '500', monthlyContribution: '1000', yieldOnNewMoneyPct: '5', dividendGrowthPct: '0', currentYieldPct: '1', years: '3', reinvestDividends: 'false', portfolioId: 'default' } }),
    );
    const body = json(res);
    expect(body.inputs).toMatchObject({ targetIncome: 500, currentYieldPct: 1, currentIncome: 12.1, years: 3, reinvestDividends: false });
    const baseScenario = body.scenarios.find((s: { id: string }) => s.id === 'base');
    expect(baseScenario.yearsToGoal).toBe(0.83);
    expect(baseScenario.points.map((p: { income: number }) => p.income)).toEqual([12.1, 612.1, 1212.1, 1812.1]);
  });

  it('rejects invalid parameters with the error envelope', async () => {
    const { handler } = setup();
    const invalid: Record<string, string>[] = [{ targetIncome: '-5' }, { years: '99' }, { reinvestDividends: 'maybe' }, { dividendGrowthPct: 'lots' }];
    for (const query of invalid) {
      const res = await handler(apiEvent('GET', '/analytics/goal', { query }));
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(json(res).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
    }
  });
});

describe('routing', () => {
  it('serves analytics under the /api prefix and rejects non-GET methods', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/api/analytics/summary/'))).statusCode).toBe(200);
    expect((await handler(apiEvent('POST', '/analytics/summary'))).statusCode).toBe(404);
    expect((await handler(apiEvent('GET', '/analytics/unknown'))).statusCode).toBe(404);
  });
});
