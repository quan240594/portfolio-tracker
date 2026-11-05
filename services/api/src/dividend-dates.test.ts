import type { GetCalendarResponse, GetDividendDatesResponse } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import type { DividendChecksDeps } from './deps.js';
import { createHandler } from './lambda/handler.js';
import { apiEvent, fakeDeps, txn } from './testing/fakes.js';

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

/** The fake clock reads 2026-06-15 12:00 UTC: a dividend with ex-date today and a payment in 8 days. */
function scenario(deps: Parameters<typeof fakeDeps>[0] = {}) {
  const made = fakeDeps(deps);
  made.repo.transactions = [
    txn({ id: 'h', date: '2026-06-10', type: 'BUY', symbol: 'HESM', quantity: 10, price: 30, currency: 'USD' }),
    txn({ id: 'n', date: '2026-06-15', type: 'BUY', symbol: 'NEWB', quantity: 5, price: 20, currency: 'USD' }),
    txn({ id: 'c', date: '2025-01-02', type: 'BUY', symbol: 'BTC-EUR', quantity: 1, price: 1000 }),
    txn({ id: 'e', date: '2025-01-02', type: 'BUY', symbol: 'VWRL.AS', quantity: 2, price: 100 }),
  ];
  made.repo.profiles = {
    HESM: { symbol: 'HESM', name: 'Hess Midstream LP', assetClass: 'STOCK', currency: 'USD' },
    'VWRL.AS': { symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World UCITS ETF', assetClass: 'ETF', currency: 'EUR' },
  };
  made.repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-06-15T00:00:00Z' };
  made.repo.tracked = new Map([['HESM', 'USD'], ['NEWB', 'USD'], ['VWRL.AS', 'EUR']]);
  made.repo.dividendEvents = [
    { symbol: 'HESM', exDate: '2026-06-15', payDate: '2026-06-23', amount: 0.7, currency: 'USD', source: 'eodhd', declared: true },
    { symbol: 'NEWB', exDate: '2026-06-15', payDate: '2026-06-23', amount: 0.4, currency: 'USD', source: 'eodhd', declared: true },
  ];
  made.repo.dividendStates.set('HESM', { checkedAt: '2026-06-15T05:30:00.000Z', attempt: { at: '2026-06-15T05:30:00.000Z', outcome: 'ok', reason: '', source: 'eodhd', events: 1 } });
  const handler = createHandler(() => made.deps);
  const read = async (): Promise<GetDividendDatesResponse> => json(await handler(apiEvent('GET', '/diagnostics/dividend-dates')));
  const calendar = async (query: Record<string, string> = { from: '2026-06-01', to: '2026-06-30' }): Promise<GetCalendarResponse> => json(await handler(apiEvent('GET', '/calendar', { query })));
  return { ...made, handler, read, calendar };
}

describe('GET /diagnostics/dividend-dates', () => {
  it('lists the held symbols that can pay (an ETF too, crypto not) with the next dividend and why one is missing', async () => {
    const body = await scenario().read();
    expect(body.symbols.map((entry) => entry.symbol)).toEqual(['NEWB', 'VWRL.AS', 'HESM']);
    expect(body.symbols[2]).toMatchObject({
      symbol: 'HESM',
      name: 'Hess Midstream LP',
      next: { exDate: '2026-06-15', payDate: '2026-06-23', amount: 0.7, currency: 'USD', source: 'eodhd', kind: 'declared' },
      check: { outcome: 'ok', source: 'eodhd' },
      reasonCode: null,
    });
    // Bought on the ex-date: not entitled, and the report says so.
    expect(body.symbols[0]).toMatchObject({ symbol: 'NEWB', next: null, reasonCode: 'after-ex-date' });
    expect(body.symbols[1]).toMatchObject({ symbol: 'VWRL.AS', next: null, reasonCode: 'never-checked' });
    expect(body).toMatchObject({ today: '2026-06-15', held: 3, withDeclared: 1, budget: null, configured: null, feed: { status: 'untested' } });
  });

  it('answers without the Cloudflare parts where the deployment has none: no allowance, no check button', async () => {
    expect((await scenario().read()).refresh).toEqual({ available: false, reason: expect.stringContaining('scheduled job only'), nextAllowedAt: null });
  });

  it('takes the allowance, the sources and the check state from the deployment, and the feed state from the store', async () => {
    const dividendChecks: DividendChecksDeps = {
      status: () => Promise.resolve({ budget: { provider: 'EODHD', day: '2026-06-15', used: 6, limit: 20, remaining: 14, calendarUsed: 2, calendarLimit: 8 }, refresh: { available: true, reason: null, nextAllowedAt: null }, configured: { eodhd: true, alphavantage: true } }),
      refresh: () => Promise.resolve({ accepted: true }),
    };
    const { read, repo } = scenario({ dividendChecks });
    repo.dividendFeed = { status: 'unavailable', at: '2026-06-14T05:30:00.000Z', reason: 'premium endpoint' };
    expect(await read()).toMatchObject({ budget: { provider: 'EODHD', remaining: 14 }, refresh: { available: true }, configured: { eodhd: true, alphavantage: true }, feed: { status: 'unavailable', reason: 'premium endpoint' } });
  });

  it('adds the dividend dates the user entered by hand', async () => {
    const { read, mgmt } = scenario();
    mgmt.manualDividends = [{ userId: 'demo', symbol: 'VWRL.AS', exDate: '2026-06-20', payDate: '2026-06-30', amount: 0.5, currency: 'EUR', source: 'manual', declared: true, enteredAt: '2026-06-15T10:00:00.000Z' }];
    const entry = (await read()).symbols.find((symbol) => symbol.symbol === 'VWRL.AS');
    expect(entry).toMatchObject({ next: { exDate: '2026-06-20', source: 'manual', enteredByYou: true, kind: 'declared' }, reasonCode: null });
  });

  it('is empty without positions', async () => {
    const { read, repo } = scenario();
    repo.transactions = [];
    expect(await read()).toMatchObject({ held: 0, withDeclared: 0, symbols: [] });
  });
});

describe('POST /diagnostics/dividend-dates/refresh', () => {
  const post = (handler: ReturnType<typeof createHandler>) => handler(apiEvent('POST', '/diagnostics/dividend-dates/refresh'));
  const checks = (refresh: DividendChecksDeps['refresh']): DividendChecksDeps => ({ status: () => Promise.reject(new Error('unused')), refresh });

  it('answers 404 where the deployment cannot queue the check (AWS)', async () => {
    const res = await post(scenario().handler);
    expect(res.statusCode).toBe(404);
    expect(json(res).error.code).toBe('NOT_AVAILABLE');
  });

  it('answers 202 once the check is queued', async () => {
    const res = await post(scenario({ dividendChecks: checks(() => Promise.resolve({ accepted: true })) }).handler);
    expect(res.statusCode).toBe(202);
    expect(json(res)).toEqual({ accepted: true });
  });

  it('answers 429 with the reason and Retry-After, or without one, and 503 when there is no key', async () => {
    const limited = await post(scenario({ dividendChecks: checks(() => Promise.resolve({ accepted: false, reason: 'rate-limited', message: 'Ask again after 10:30 UTC.', retryAfterSeconds: 1800 })) }).handler);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers?.['retry-after']).toBe('1800');
    expect(json(limited)).toEqual({ error: { code: 'RATE_LIMITED', message: 'Ask again after 10:30 UTC.', details: { reason: 'rate-limited', retryAfterSeconds: 1800 } } });
    const low = await post(scenario({ dividendChecks: checks(() => Promise.resolve({ accepted: false, reason: 'budget-low', message: 'Spent.' })) }).handler);
    expect(low.statusCode).toBe(429);
    expect(low.headers?.['retry-after']).toBeUndefined();
    const missing = await post(scenario({ dividendChecks: checks(() => Promise.resolve({ accepted: false, reason: 'not-configured', message: 'No key.' })) }).handler);
    expect(missing.statusCode).toBe(503);
    expect(json(missing).error).toMatchObject({ code: 'NOT_CONFIGURED', message: 'No key.' });
  });
});

describe('the calendar on the day of the ex-date', () => {
  it('shows the ex-dividend entry today and the payment in 8 days for a position bought before the ex-date', async () => {
    const { calendar } = scenario();
    const hesm = (await calendar()).events.filter((event) => event.symbol === 'HESM');
    expect(hesm.map((event) => [event.type, event.date, event.status])).toEqual([
      ['EX_DIVIDEND', '2026-06-15', 'CONFIRMED'],
      ['DIVIDEND_PAY', '2026-06-23', 'CONFIRMED'],
    ]);
  });

  it('shows nothing for a position bought on the ex-date, and the default range and filters find the entries', async () => {
    const { calendar } = scenario();
    expect((await calendar()).events.filter((event) => event.symbol === 'NEWB')).toEqual([]);
    const defaults = await calendar({});
    expect(defaults.events.some((event) => event.symbol === 'HESM' && event.type === 'EX_DIVIDEND')).toBe(true);
    const filtered = await calendar({ types: 'EX_DIVIDEND', status: 'CONFIRMED', scope: 'holdings' });
    expect(filtered.events.map((event) => event.symbol)).toEqual(['HESM']);
  });
});

describe('dividend dates entered by hand', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ symbol: 'vwrl.as', exDate: '2026-06-20', payDate: '2026-06-30', amount: 0.5, currency: 'eur', ...extra });
  const add = (made: ReturnType<typeof scenario>, payload: unknown) => made.handler(apiEvent('POST', '/calendar/dividends', { body: payload }));

  it('stores an entry for a symbol of the user and shows it in the calendar as entered by the user', async () => {
    const made = scenario();
    const res = await add(made, body());
    expect(res.statusCode).toBe(201);
    expect(json(res)).toEqual({ symbol: 'VWRL.AS', exDate: '2026-06-20', payDate: '2026-06-30', amount: 0.5, currency: 'EUR', source: 'manual', declared: true, enteredAt: '2026-06-15T12:00:00.000Z' });
    expect(made.mgmt.manualDividends).toHaveLength(1);
    const events = (await made.calendar()).events.filter((event) => event.symbol === 'VWRL.AS');
    expect(events.map((event) => [event.type, event.date, event.source, event.status])).toEqual([
      ['EX_DIVIDEND', '2026-06-20', 'manual', 'CONFIRMED'],
      ['DIVIDEND_PAY', '2026-06-30', 'manual', 'CONFIRMED'],
    ]);
  });

  it('takes the currency of the symbol and no amount when none is given, and edits the same ex-date', async () => {
    const made = scenario();
    const first = json(await add(made, { symbol: 'HESM', exDate: '2026-09-04' }));
    expect(first).toMatchObject({ amount: 0, currency: 'USD' });
    expect(first).not.toHaveProperty('payDate');
    expect(json(await add(made, { symbol: 'NEWB', exDate: '2026-09-04' }))).toMatchObject({ currency: 'EUR' });
    await add(made, { symbol: 'HESM', exDate: '2026-09-04', amount: 0.72 });
    expect(made.mgmt.manualDividends.filter((entry) => entry.symbol === 'HESM')).toEqual([expect.objectContaining({ amount: 0.72 })]);
  });

  it('lets a stored provider event for the same ex-date win once it has an amount', async () => {
    const made = scenario();
    await add(made, { symbol: 'HESM', exDate: '2026-06-15', payDate: '2026-06-22', amount: 0.9 });
    const hesm = (await made.calendar()).events.filter((event) => event.symbol === 'HESM');
    expect(hesm.map((event) => [event.source, event.amountPerShare, event.payDate])).toEqual([['market-data', 0.7, '2026-06-23'], ['market-data', 0.7, '2026-06-23']]);
  });

  it('refuses a bad body, a symbol that is not yours, a pay date before the ex-date, an ex-date far away and too many entries', async () => {
    const made = scenario();
    expect((await add(made, { symbol: 'HESM' })).statusCode).toBe(400);
    expect((await made.handler(apiEvent('POST', '/calendar/dividends'))).statusCode).toBe(400);
    expect((await add(made, body({ symbol: 'ZZZZ' }))).statusCode).toBe(400);
    const early = await add(made, body({ payDate: '2026-06-19' }));
    expect(early.statusCode).toBe(422);
    expect((await add(made, body({ exDate: '2028-01-01', payDate: undefined }))).statusCode).toBe(422);
    made.mgmt.manualDividends = Array.from({ length: 200 }, (_, index) => ({ userId: 'demo', symbol: 'HESM', exDate: `2026-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}x${index}`, amount: 1, currency: 'USD', source: 'manual' as const, declared: true as const, enteredAt: 'x' }));
    expect((await add(made, body())).statusCode).toBe(422);
    expect(made.mgmt.manualDividends).toHaveLength(200);
  });

  it('removes an entry, and answers 404 for one that is not there', async () => {
    const made = scenario();
    await add(made, body());
    expect((await made.handler(apiEvent('DELETE', '/calendar/dividends/vwrl.as/2026-06-20'))).statusCode).toBe(204);
    expect(made.mgmt.manualDividends).toEqual([]);
    const missing = await made.handler(apiEvent('DELETE', '/calendar/dividends/VWRL.AS/2026-06-20'));
    expect(missing.statusCode).toBe(404);
    expect(json(missing).error.code).toBe('NOT_FOUND');
  });
});
