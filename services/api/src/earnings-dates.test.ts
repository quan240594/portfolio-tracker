import type { EarningsRunRecord, GetEarningsDatesResponse } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import type { CalendarDatesDeps } from './deps.js';
import { createHandler } from './lambda/handler.js';
import { apiEvent, fakeDeps, txn } from './testing/fakes.js';

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const run = (over: Partial<EarningsRunRecord> = {}): EarningsRunRecord => ({ at: '2026-06-15T04:30:00.000Z', trigger: 'scheduled', status: 'ok', reason: '', tracked: 3, rows: 4800, events: 1, matchedSymbols: ['AAPL'], listed: ['AAPL', 'GOOG'], unvouched: [], ...over });

function scenario(deps: Parameters<typeof fakeDeps>[0] = {}) {
  const made = fakeDeps(deps);
  made.repo.transactions = [
    txn({ id: 'a', date: '2025-01-02', type: 'BUY', symbol: 'AAPL', quantity: 5, price: 100 }),
    txn({ id: 'g', date: '2025-01-02', type: 'BUY', symbol: 'GOOGL', quantity: 3, price: 150 }),
    txn({ id: 's', date: '2025-01-02', type: 'BUY', symbol: 'SOLD', quantity: 3, price: 150 }),
    txn({ id: 's2', date: '2025-06-02', type: 'SELL', symbol: 'SOLD', quantity: 3, price: 150 }),
    txn({ id: 'c', date: '2025-01-02', type: 'BUY', symbol: 'BTC-EUR', quantity: 1, price: 1000 }),
  ];
  made.repo.profiles = { GOOGL: { symbol: 'GOOGL', name: 'Alphabet Inc', assetClass: 'STOCK', currency: 'USD' } };
  made.repo.tracked = new Map([['AAPL', 'USD'], ['GOOGL', 'USD'], ['BTC-EUR', 'EUR'], ['SOLD', 'USD']]);
  made.repo.earningsEvents = [{ symbol: 'AAPL', date: '2026-06-18', timeOfDay: 'AMC', source: 'alphavantage' }];
  made.repo.earningsRun = run();
  made.repo.earningsLastOk = run();
  const handler = createHandler(() => made.deps);
  const read = async (): Promise<GetEarningsDatesResponse> => json(await handler(apiEvent('GET', '/diagnostics/earnings-dates')));
  return { ...made, handler, read };
}

describe('GET /diagnostics/earnings-dates', () => {
  it('lists the open positions only, the ones without a date first, with the reason and the last run', async () => {
    const { read } = scenario();
    const body = await read();
    expect(body.symbols.map((entry) => entry.symbol)).toEqual(['BTC-EUR', 'GOOGL', 'AAPL']);
    expect(body.symbols[0]).toMatchObject({ next: null, reasonCode: 'not-applicable' });
    expect(body.symbols[1]).toMatchObject({ symbol: 'GOOGL', name: 'Alphabet Inc', next: null, reasonCode: 'not-listed' });
    expect(body.symbols[1]!.reason).toBe("Not in the provider's calendar: its calendar of 4800 rows (2026-06-15) has no row for GOOGL.");
    expect(body.symbols[2]).toMatchObject({ symbol: 'AAPL', name: 'AAPL', next: { date: '2026-06-18', source: 'scheduled', timeOfDay: 'AMC' } });
    expect(body).toMatchObject({ today: '2026-06-15', held: 3, withDate: 1, lastRun: { status: 'ok', rows: 4800, matchedHeld: 1 }, budget: null });
  });

  it('answers without the Cloudflare parts where the deployment has none: no allowance, no refresh', async () => {
    const { read } = scenario();
    expect((await read()).refresh).toEqual({ available: false, reason: expect.stringContaining('scheduled job only'), nextAllowedAt: null });
  });

  it('takes the allowance and the refresh state from the deployment', async () => {
    const calendarDates: CalendarDatesDeps = {
      status: () => Promise.resolve({ budget: { provider: 'Alpha Vantage', day: '2026-06-15', used: 3, limit: 25, remaining: 22, calendarUsed: 1, calendarLimit: 1 }, refresh: { available: true, reason: null, nextAllowedAt: null } }),
      refresh: () => Promise.resolve({ accepted: true }),
    };
    const { read } = scenario({ calendarDates });
    expect(await read()).toMatchObject({ budget: { used: 3, remaining: 22 }, refresh: { available: true } });
  });

  it('says the job has not run when nothing is recorded, and that a new holding was not looked up yet', async () => {
    const { read, repo } = scenario();
    repo.earningsRun = null;
    repo.earningsLastOk = null;
    expect((await read()).symbols.find((entry) => entry.symbol === 'GOOGL')).toMatchObject({ reasonCode: 'never-run' });
    repo.earningsRun = run({ at: '2026-06-15T04:30:00.000Z' });
    repo.earningsLastOk = run();
    repo.trackedAt.set('GOOGL', '2026-06-15T09:00:00.000Z');
    expect((await read()).symbols.find((entry) => entry.symbol === 'GOOGL')).toMatchObject({ reasonCode: 'since-bought' });
  });

  it('projects the next date from the last stored report when the provider lists none', async () => {
    const { read, repo } = scenario();
    repo.earningsSummaries = [{ symbol: 'GOOGL', reportDate: '2026-04-30', period: 'Q1 2026' } as never];
    expect((await read()).symbols.find((entry) => entry.symbol === 'GOOGL')?.next).toMatchObject({ date: '2026-07-30', source: 'projected' });
  });

  it('is empty without positions', async () => {
    const { read, repo } = scenario();
    repo.transactions = [];
    expect(await read()).toMatchObject({ held: 0, withDate: 0, symbols: [] });
  });
});

describe('POST /diagnostics/earnings-dates/refresh', () => {
  const post = (handler: ReturnType<typeof createHandler>) => handler(apiEvent('POST', '/diagnostics/earnings-dates/refresh'));

  it('answers 404 where the deployment cannot queue the job (AWS)', async () => {
    const { handler } = scenario();
    const res = await post(handler);
    expect(res.statusCode).toBe(404);
    expect(json(res).error.code).toBe('NOT_AVAILABLE');
  });

  it('answers 202 once the job is queued', async () => {
    const { handler } = scenario({ calendarDates: { status: () => Promise.reject(new Error('unused')), refresh: () => Promise.resolve({ accepted: true }) } });
    const res = await post(handler);
    expect(res.statusCode).toBe(202);
    expect(json(res)).toEqual({ accepted: true });
  });

  it('answers 429 with the reason and Retry-After when it was asked less than an hour ago or the allowance is nearly used', async () => {
    const { handler } = scenario({
      calendarDates: { status: () => Promise.reject(new Error('unused')), refresh: () => Promise.resolve({ accepted: false, reason: 'rate-limited', message: 'Ask again after 10:30 UTC.', retryAfterSeconds: 1800 }) },
    });
    const res = await post(handler);
    expect(res.statusCode).toBe(429);
    expect(res.headers?.['retry-after']).toBe('1800');
    expect(json(res)).toEqual({ error: { code: 'RATE_LIMITED', message: 'Ask again after 10:30 UTC.', details: { reason: 'rate-limited', retryAfterSeconds: 1800 } } });
  });

  it('answers 429 without Retry-After when the refusal has no wait, and 503 when there is no key', async () => {
    const refusal = (reason: 'budget-low' | 'not-configured') => scenario({ calendarDates: { status: () => Promise.reject(new Error('unused')), refresh: () => Promise.resolve({ accepted: false, reason, message: 'Because.' }) } });
    const low = await post(refusal('budget-low').handler);
    expect(low.statusCode).toBe(429);
    expect(low.headers?.['retry-after']).toBeUndefined();
    const missing = await post(refusal('not-configured').handler);
    expect(missing.statusCode).toBe(503);
    expect(json(missing).error).toMatchObject({ code: 'NOT_CONFIGURED', message: 'Because.' });
  });
});
