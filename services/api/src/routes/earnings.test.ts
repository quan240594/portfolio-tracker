import { sampleSummary, type ConsensusQuarter, type EarningsListResponse, type EarningsStatusResponse, type EarningsSummary } from '@portfolio/shared';
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
  return { ...ctx, call, hold, summary, refreshed: earnings?.refreshed ?? [], backfilled: earnings?.backfilled ?? [] };
}

describe('on a deployment without the feature (AWS)', () => {
  it('answers available: false and 404s the rest', async () => {
    const { call } = setup('none');
    expect((await call('GET', '/earnings')).body).toEqual({ available: false, summaries: [], symbols: [] });
    expect((await call('GET', '/earnings/status')).body).toEqual({ available: false, configured: false, missing: [], estimatesConfigured: false, symbols: [] });
    for (const [method, path] of [['GET', '/earnings/NWND/2026-10-21'], ['POST', '/earnings/NWND/refresh'], ['POST', '/earnings/backfill']] as const) {
      const result = await call(method, path);
      expect([result.status, result.body.error.code]).toEqual([404, 'NOT_AVAILABLE']);
    }
  });
});

describe('GET /earnings', () => {
  it('lists the newest summaries of the symbols you hold now, newest first, and the symbols that have one', async () => {
    const { call, hold, summary } = setup();
    hold('NWND');
    hold('CLDV');
    hold('NOSUM');
    hold('SOLD');
    hold('SOLD', 'STOCK', 'SELL');
    summary('NWND', '2026-07-22');
    summary('NWND', '2026-10-21');
    summary('CLDV', '2026-10-14');
    summary('SOLD', '2026-10-28');
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
    hold('SOLD');
    hold('SOLD', 'STOCK', 'SELL');
    summary('SOLD', '2026-10-21');
    expect((await call('GET', '/earnings/SOLD/2026-10-21')).status).toBe(404);
    expect((await call('GET', '/earnings/NWND/2026-10-21')).body).toEqual({ ...made, consensus: expect.objectContaining({ provider: 'Alpha Vantage' }) });
    expect((await call('GET', '/earnings/NWND/2026-01-01')).status).toBe(404);
    expect((await call('GET', '/earnings/STRANGER/2026-10-21')).status).toBe(404);
    expect((await call('GET', '/earnings/NWND/Q3')).status).toBe(400);
    expect((await call('GET', '/earnings/bad symbol!/2026-10-21')).status).toBe(400);
  });
});

describe('the analyst consensus on a summary', () => {
  const NWND = (extra: Partial<ConsensusQuarter> = {}): ConsensusQuarter => ({
    symbol: 'NWND',
    quarterEnd: '2026-09-30',
    ticker: 'NWND',
    fetchedAt: '2026-10-12T06:20:00.000Z',
    eps: { average: 6.45, high: 6.6, low: 6.3, analysts: 12 },
    revenue: { average: 20_000_000_000, high: 20_500_000_000, low: 19_600_000_000, analysts: 10 },
    ...extra,
  });

  it('joins the stored consensus of the matching quarter with beat or miss against the actual, in the list and for one summary', async () => {
    const { call, hold, summary, repo } = setup();
    hold('NWND');
    summary('NWND', '2026-10-21');
    summary('NWND', '2026-07-22');
    repo.consensusQuarters.push(NWND(), NWND({ quarterEnd: '2026-06-30', eps: { average: 7 }, revenue: { average: 19_000_000_000 } }));
    const { body } = (await call('GET', '/earnings')) as { body: EarningsListResponse };
    expect(body.summaries[0]?.consensus).toEqual({
      provider: 'Alpha Vantage',
      quarterEnd: '2026-09-30',
      asOf: '2026-10-12T06:20:00.000Z',
      eps: { average: 6.45, high: 6.6, low: 6.3, analysts: 12, source: 'consensus', surprise: { amount: 0.47, pct: 7.3, verdict: 'beat' } },
      revenue: { average: 20_000_000_000, high: 20_500_000_000, low: 19_600_000_000, analysts: 10, source: 'consensus', surprise: { amount: 710_000_000, pct: 3.6, verdict: 'beat' } },
    });
    expect(body.summaries[1]?.consensus).toMatchObject({ quarterEnd: '2026-06-30', eps: { surprise: { verdict: 'miss' } } });
    const one = (await call('GET', '/earnings/NWND/2026-10-21')).body as EarningsSummary;
    expect(one.consensus?.quarterEnd).toBe('2026-09-30');
  });

  it('uses the calendar\u2019s EPS estimate when no consensus is stored, and says why there is no revenue estimate', async () => {
    const { call, hold, summary, repo } = setup();
    hold('NWND');
    summary('NWND', '2026-10-21', { headline: { eps: { value: 6.92, unit: 'perShare' }, revenue: { value: 20_710_000_000, unit: 'money' } } });
    repo.earningsEvents.push({ symbol: 'NWND', date: '2026-10-22', epsEstimate: 6.5, currency: 'USD', source: 'alphavantage' });
    repo.consensusStates.set('NWND', { symbol: 'NWND', outcome: 'premium', at: '2026-10-21T08:20:00.000Z', updatedAt: '2026-10-21T08:20:00.000Z' });
    const { body } = (await call('GET', '/earnings')) as { body: EarningsListResponse };
    expect(body.summaries[0]?.consensus).toEqual({
      provider: 'Alpha Vantage',
      eps: { average: 6.5, source: 'calendar', surprise: { amount: 0.42, pct: 6.5, verdict: 'beat' } },
      reason: 'premium',
    });
  });

  it('says a missing key is the reason, not "pending", when the deployment has no Alpha Vantage key', async () => {
    const keyless = setup({ estimatesConfigured: false });
    keyless.hold('NWND');
    keyless.summary('NWND', '2026-10-21', { headline: { revenue: { value: 1, unit: 'money' } } });
    expect(((await keyless.call('GET', '/earnings')).body as EarningsListResponse).summaries[0]?.consensus?.reason).toBe('no-key');
    const keyed = setup({ estimatesConfigured: true });
    keyed.hold('NWND');
    keyed.summary('NWND', '2026-10-21', { headline: { revenue: { value: 1, unit: 'money' } } });
    expect((await keyed.call('GET', '/earnings/NWND/2026-10-21')).body.consensus.reason).toBe('pending');
    keyless.repo.consensusStates.set('NWND', { symbol: 'NWND', outcome: 'premium', at: '2026-10-21T08:20:00.000Z', updatedAt: '2026-10-21T08:20:00.000Z' });
    expect((await keyless.call('GET', '/earnings/NWND/2026-10-21')).body.consensus.reason).toBe('premium');
  });

  it('leaves the summaries as they are when the consensus cannot be read', async () => {
    const { call, hold, summary, repo } = setup();
    hold('NWND');
    const made = summary('NWND', '2026-10-21');
    repo.getConsensus = () => Promise.reject(new Error('store down'));
    const { body } = (await call('GET', '/earnings')) as { body: EarningsListResponse };
    expect(body.summaries).toEqual([made]);
    repo.getConsensus = () => Promise.reject('not an error');
    expect(((await call('GET', '/earnings')).body as EarningsListResponse).summaries).toEqual([made]);
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

  it('lists only what is held now (the Dashboard holdings) and counts the sold-out symbols apart', async () => {
    const { call, hold, repo } = setup();
    const heldNow = Array.from({ length: 26 }, (_, index) => `HELD${String(index).padStart(2, '0')}`);
    const soldOut = Array.from({ length: 94 }, (_, index) => `SOLD${String(index).padStart(2, '0')}`);
    for (const symbol of heldNow) hold(symbol);
    for (const symbol of soldOut) {
      hold(symbol);
      hold(symbol, 'STOCK', 'SELL');
    }
    hold('LEFTOVER');
    repo.transactions.push(txn({ id: 't-leftover-sell', date: '2026-02-01', type: 'SELL', symbol: 'LEFTOVER', quantity: 5 - 1e-8, price: 10, currency: 'USD' }));
    const { body } = (await call('GET', '/earnings/status')) as { body: EarningsStatusResponse };
    expect(body.symbols.map((entry) => entry.symbol)).toEqual(heldNow);
    expect(body.notHeld).toBe(95);
  });

  it('leaves out a symbol that was sold when its position moved to a new ticker', async () => {
    const { call, hold } = setup();
    hold('OLDT');
    hold('OLDT', 'STOCK', 'SELL');
    hold('NEWT');
    const { body } = (await call('GET', '/earnings/status')) as { body: EarningsStatusResponse };
    expect(body.symbols.map((entry) => entry.symbol)).toEqual(['NEWT']);
    expect(body.notHeld).toBe(1);
  });

  it('an instrument whose class is not known counts unless its name reads like a fund', async () => {
    const { call, hold, repo } = setup();
    hold('FOO.DE');
    repo.profiles['FOO.DE'] = { symbol: 'FOO.DE', name: 'Salesforce', assetClass: 'OTHER', currency: 'EUR' };
    hold('VWRL');
    repo.profiles.VWRL = { symbol: 'VWRL', name: 'Vanguard FTSE All-World UCITS ETF', assetClass: 'OTHER', currency: 'EUR' };
    const { body } = (await call('GET', '/earnings/status')) as { body: EarningsStatusResponse };
    expect(body.symbols).toEqual([{ symbol: 'FOO.DE', eligible: true }, { symbol: 'VWRL', eligible: false }]);
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
    const sold = setup();
    sold.hold('SOLD');
    sold.hold('SOLD', 'STOCK', 'SELL');
    expect((await sold.call('POST', '/earnings/SOLD/refresh')).status).toBe(404);
    expect(sold.refreshed).toEqual([]);
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

describe('POST /earnings/backfill', () => {
  it('accepts "Fetch all now"', async () => {
    const { call, backfilled } = setup();
    const result = await call('POST', '/earnings/backfill');
    expect([result.status, result.body]).toEqual([202, { accepted: true }]);
    expect(backfilled).toHaveLength(1);
  });

  it('is rate limited (once an hour) or not configured', async () => {
    const limited = await setup({ refusal: 'rate-limited' }).call('POST', '/earnings/backfill');
    expect([limited.status, limited.body.error.code, limited.body.error.details, limited.headers['retry-after']]).toEqual([429, 'RATE_LIMITED', { retryAfterSeconds: 1800 }, '1800']);
    const missing = await setup({ refusal: 'not-configured' }).call('POST', '/earnings/backfill');
    expect([missing.status, missing.body.error.code]).toEqual([503, 'NOT_CONFIGURED']);
  });
});
