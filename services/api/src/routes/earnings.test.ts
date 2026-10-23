import { sampleSummary, type EarningsListResponse, type EarningsStatusResponse, type EarningsSummary } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { createHandler } from '../lambda/handler.js';
import { apiEvent, fakeDeps, fakeEarningsDeps, txn } from '../testing/fakes.js';

function setup(options: Parameters<typeof fakeEarningsDeps>[0] | 'none' = {}) {
  const earnings = options === 'none' ? undefined : fakeEarningsDeps(options);
  const ctx = fakeDeps(earnings ? { earnings: earnings.earnings } : {});
  const handler = createHandler(() => ctx.deps);
  const call = async (method: string, path: string, query?: Record<string, string>) => {
    const res = await handler(apiEvent(method, path, { query }));
    return { status: res.statusCode ?? 0, body: res.body ? JSON.parse(res.body) : undefined, headers: res.headers ?? {} };
  };
  const hold = (symbol: string, assetClass: 'STOCK' | 'ETF' = 'STOCK', type: 'BUY' | 'SELL' = 'BUY') => {
    ctx.repo.transactions.push(txn({ id: `t-${symbol}-${type}-${ctx.repo.transactions.length}`, date: '2026-01-05', type, symbol, quantity: 5, price: 10, currency: 'USD' }));
    ctx.repo.profiles[symbol] = { symbol, name: symbol, assetClass, currency: 'USD' };
  };
  const summary = (symbol: string, reportDate: string, extra: Partial<EarningsSummary> = {}): EarningsSummary => {
    const made = sampleSummary({ symbol, reportDate, ...extra });
    ctx.repo.earningsSummaries.push(made);
    return made;
  };
  return { ...ctx, call, hold, summary, refreshed: earnings?.refreshed ?? [] };
}

describe('on a deployment without the feature (AWS)', () => {
  it('answers available: false and 404s the rest', async () => {
    const { call } = setup('none');
    expect((await call('GET', '/earnings')).body).toEqual({ available: false, summaries: [], symbols: [] });
    expect((await call('GET', '/earnings/status')).body).toEqual({ available: false, configured: false, missing: [], estimatesConfigured: false, symbols: [] });
    for (const [method, path] of [['GET', '/earnings/NWND/2026-10-21'], ['POST', '/earnings/NWND/refresh']] as const) {
      const result = await call(method, path);
      expect([result.status, result.body.error.code]).toEqual([404, 'NOT_AVAILABLE']);
    }
  });
});

describe('GET /earnings', () => {
  it('lists the newest summaries of the symbols you hold or held, newest first, and the symbols that have one', async () => {
    const { call, hold, summary } = setup();
    hold('NWND');
    hold('NWND', 'STOCK', 'SELL');
    hold('CLDV');
    hold('NOSUM');
    summary('NWND', '2026-07-22');
    summary('NWND', '2026-10-21');
    summary('CLDV', '2026-10-14');
    summary('STRANGER', '2026-10-30');
    const { body } = (await call('GET', '/earnings')) as { body: EarningsListResponse };
    expect(body.available).toBe(true);
    expect(body.summaries.map((entry) => `${entry.symbol} ${entry.reportDate}`)).toEqual(['NWND 2026-10-21', 'CLDV 2026-10-14', 'NWND 2026-07-22']);
    expect(body.symbols).toEqual(['CLDV', 'NWND']);
  });

  it('filters by symbol, limits, and keeps the chips of the other symbols', async () => {
    const { call, hold, summary } = setup();
    hold('NWND');
    hold('CLDV');
    summary('NWND', '2026-07-22');
    summary('NWND', '2026-10-21');
    summary('CLDV', '2026-10-14');
    const one = (await call('GET', '/earnings', { symbol: 'nwnd', limit: '1' })).body as EarningsListResponse;
    expect(one.summaries.map((entry) => entry.reportDate)).toEqual(['2026-10-21']);
    expect(one.symbols).toEqual(['CLDV', 'NWND']);
    expect(((await call('GET', '/earnings', { symbol: 'STRANGER' })).body as EarningsListResponse).summaries).toEqual([]);
    expect(((await call('GET', '/earnings', { limit: '2' })).body as EarningsListResponse).summaries).toHaveLength(2);
  });

  it('is empty without holdings and rejects a bad limit', async () => {
    const { call, summary } = setup();
    summary('NWND', '2026-10-21');
    expect((await call('GET', '/earnings')).body).toEqual({ available: true, summaries: [], symbols: [] });
    expect((await call('GET', '/earnings', { limit: '0' })).status).toBe(400);
    expect((await call('GET', '/earnings', { limit: '99' })).status).toBe(400);
  });
});

describe('GET /earnings/{symbol}/{period}', () => {
  it('returns one summary of a held symbol and 404s anything else', async () => {
    const { call, hold, summary } = setup();
    hold('NWND');
    const made = summary('NWND', '2026-10-21');
    summary('STRANGER', '2026-10-21');
    expect((await call('GET', '/earnings/NWND/2026-10-21')).body).toEqual(made);
    expect((await call('GET', '/earnings/NWND/2026-01-01')).status).toBe(404);
    expect((await call('GET', '/earnings/STRANGER/2026-10-21')).status).toBe(404);
    expect((await call('GET', '/earnings/NWND/Q3')).status).toBe(400);
    expect((await call('GET', '/earnings/bad symbol!/2026-10-21')).status).toBe(400);
  });
});

describe('GET /earnings/status', () => {
  it('passes the held symbols with their eligibility', async () => {
    const { call, hold } = setup();
    hold('NWND');
    hold('VWRL', 'ETF');
    const { body } = (await call('GET', '/earnings/status')) as { body: EarningsStatusResponse };
    expect(body).toMatchObject({ available: true, configured: true, neurons: { used: 120, dailyCap: 6000 } });
    expect(body.symbols).toEqual([{ symbol: 'NWND', eligible: true }, { symbol: 'VWRL', eligible: false }]);
  });

  it('says what is missing when the feature is not configured', async () => {
    const { call } = setup({ configured: false });
    expect((await call('GET', '/earnings/status')).body).toMatchObject({ available: true, configured: false, missing: ['sec-contact', 'ai-binding'] });
  });
});

describe('POST /earnings/{symbol}/refresh', () => {
  it('accepts a re-check of a held stock', async () => {
    const { call, hold, refreshed } = setup();
    hold('NWND');
    const result = await call('POST', '/earnings/NWND/refresh');
    expect([result.status, result.body]).toEqual([202, { accepted: true }]);
    expect(refreshed).toEqual([{ symbol: 'NWND', eligible: true }]);
  });

  it('refuses what is not held, not a stock, rate limited or not configured', async () => {
    const stranger = setup();
    expect((await stranger.call('POST', '/earnings/STRANGER/refresh')).status).toBe(404);
    expect(stranger.refreshed).toEqual([]);
    const etf = setup();
    etf.hold('VWRL', 'ETF');
    const notEligible = await etf.call('POST', '/earnings/VWRL/refresh');
    expect([notEligible.status, notEligible.body.error.code]).toEqual([422, 'NOT_ELIGIBLE']);
    const limited = setup({ refusal: 'rate-limited' });
    limited.hold('NWND');
    const tooSoon = await limited.call('POST', '/earnings/NWND/refresh');
    expect([tooSoon.status, tooSoon.body.error.code, tooSoon.body.error.details, tooSoon.headers['retry-after']]).toEqual([429, 'RATE_LIMITED', { retryAfterSeconds: 1800 }, '1800']);
    const unconfigured = setup({ refusal: 'not-configured' });
    unconfigured.hold('NWND');
    const missing = await unconfigured.call('POST', '/earnings/NWND/refresh');
    expect([missing.status, missing.body.error.code]).toEqual([503, 'NOT_CONFIGURED']);
  });
});
