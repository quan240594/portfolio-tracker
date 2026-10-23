import { describe, expect, it, vi } from 'vitest';
import { JOBS } from '../job.js';
import type { PortableRequest, PortableResponse } from '../http.js';
import { MemoryUsageStore } from '../memory/usage-store.js';
import { FlakyStore, clock, spyLogger } from '../testing/budget-helpers.js';
import { BudgetGuard } from './guard.js';
import { JOB_CEILINGS, guardJob } from './jobs.js';
import { ALWAYS_ALLOWED_PATHS, isAllowedPath, withBudget, workKindOf } from './middleware.js';

const request = (path: string, method = 'GET'): PortableRequest => ({ method, path, query: {}, headers: {} });
const okResponse: PortableResponse = { status: 200, headers: {}, body: '{"ok":true}' };

function setup(start = '2026-10-19T10:00:00Z') {
  const store = new FlakyStore();
  const time = clock(start);
  const log = spyLogger();
  const guard = new BudgetGuard({ store, now: time.now, logger: log.logger });
  const handler = vi.fn((_request: PortableRequest) => Promise.resolve(okResponse));
  return { store, time, log, guard, handler, app: withBudget(handler, guard) };
}

describe('withBudget', () => {
  it('counts one Worker request and one Durable Object request per call and passes the response through', async () => {
    const { app, guard } = setup();
    expect(await app(request('/portfolio'))).toBe(okResponse);
    await app(request('/holdings'));
    const { metrics } = await guard.snapshot();
    expect([metrics.workerRequests.used, metrics.durableObjectRequests.used]).toEqual([2, 2]);
  });

  it('counts a custom cost instead', async () => {
    const store = new MemoryUsageStore();
    const guard = new BudgetGuard({ store, now: () => new Date('2026-10-19T10:00:00Z') });
    const app = withBudget(() => Promise.resolve(okResponse), guard, { cost: { workerRequests: 2 } });
    await app(request('/x'));
    expect(await store.read('2026-10-19')).toMatchObject({ workerRequests: 2, durableObjectRequests: 0 });
  });

  it('serves requests while warn', async () => {
    const { app, guard, handler } = setup();
    await guard.record({ workerRequests: 65_000 });
    expect((await app(request('/portfolio'))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses with 429, the standard error shape and Retry-After until the next UTC midnight when blocked', async () => {
    const { app, guard, handler } = setup('2026-10-19T22:00:00Z');
    await guard.record({ durableObjectRequests: 80_000 });
    const response = await app(request('/portfolio', 'POST'));
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '7200' });
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'BUDGET_EXHAUSTED',
        message: 'The daily free-plan usage limit is nearly reached, so requests are paused until it resets.',
        details: { blockedMetrics: ['durableObjectRequests'] },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses reads too when blocked, and counts the refused request', async () => {
    const { app, guard } = setup();
    await guard.record({ workerRequests: 79_999 });
    expect((await app(request('/portfolio'))).status).toBe(429);
    expect((await guard.snapshot()).metrics.workerRequests.used).toBe(80_000);
  });

  it('serves again after the UTC midnight reset', async () => {
    const { app, guard, time } = setup('2026-10-19T23:59:59Z');
    await guard.record({ rowsWritten: 90_000 });
    const refused = await app(request('/x'));
    expect(refused.headers['retry-after']).toBe('1');
    time.set('2026-10-20T00:00:00Z');
    expect((await app(request('/x'))).status).toBe(200);
  });

  it('keeps the allow-listed paths working while blocked', async () => {
    const { app, guard, handler } = setup();
    await guard.record({ workerRequests: 90_000 });
    for (const path of ['/health', '/usage', '/auth/login', '/auth/callback/github', '/auth', '/usage/']) {
      expect((await app(request(path))).status).toBe(200);
    }
    expect(handler).toHaveBeenCalledTimes(6);
  });

  it('does not let look-alike or traversal paths use the allow-list', async () => {
    const { app, guard } = setup();
    await guard.record({ workerRequests: 90_000 });
    for (const path of ['/healthz', '/usage/extra', '/authentic', '/auth/../transactions', '/auth/./x', '/auth/%2e%2e/x', '/%61uth/login', 'auth/login', '/health/..', '/portfolio']) {
      expect((await app(request(path))).status).toBe(429);
    }
  });

  it('accepts a custom allow-list', async () => {
    const store = new MemoryUsageStore();
    await store.add('2026-10-19', { workerRequests: 90_000 });
    const guard = new BudgetGuard({ store, now: () => new Date('2026-10-19T10:00:00Z') });
    const app = withBudget(() => Promise.resolve(okResponse), guard, { allowPaths: ['/ping'] });
    expect([(await app(request('/ping'))).status, (await app(request('/health'))).status]).toEqual([200, 429]);
  });

  describe('when the usage ledger fails', () => {
    it('serves GET and HEAD but refuses writes with 503 and a warning', async () => {
      const { app, store, handler, log } = setup();
      store.failing = true;
      expect((await app(request('/portfolio', 'GET'))).status).toBe(200);
      expect((await app(request('/portfolio', 'head'))).status).toBe(200);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await app(request('/transactions', method));
        expect(response.status).toBe(503);
        expect(response.headers['retry-after']).toBe('60');
        expect(JSON.parse(response.body).error.code).toBe('BUDGET_UNAVAILABLE');
      }
      expect(handler).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalled();
    });

    it('still serves the allow-listed paths for every method', async () => {
      const { app, store } = setup();
      store.failing = true;
      expect((await app(request('/auth/logout', 'POST'))).status).toBe(200);
    });
  });

  it('classifies methods as read or write', () => {
    expect([workKindOf({ method: 'GET' }), workKindOf({ method: 'head' }), workKindOf({ method: 'POST' }), workKindOf({ method: 'OPTIONS' })]).toEqual(['read', 'read', 'write', 'write']);
  });

  it('matches paths against patterns', () => {
    expect(ALWAYS_ALLOWED_PATHS).toEqual(['/health', '/usage', '/auth/*']);
    expect(isAllowedPath('/', ['/'])).toBe(true);
    expect(isAllowedPath('/x', ['/'])).toBe(false);
  });
});

describe('guardJob', () => {
  const guardWith = async (delta: Parameters<BudgetGuard['record']>[0]) => {
    const { guard, store } = setup();
    await guard.record(delta);
    return { guard, store };
  };

  it('lets every job run below 60 %', async () => {
    const { guard } = await guardWith({ workerRequests: 59_999 });
    for (const job of Object.values(JOBS)) expect(await guardJob(guard, job)).toEqual({ allowed: true, state: 'ok', reason: 'within-budget' });
  });

  it('defers the price and calendar refresh at 60 % but still runs the broker sync, enrichment and imports', async () => {
    const { guard } = await guardWith({ rowsRead: 3_000_000 });
    expect(await guardJob(guard, JOBS.refreshPrices)).toEqual({ allowed: false, state: 'warn', reason: 'deferred-by-priority' });
    expect((await guardJob(guard, JOBS.refreshCalendar)).allowed).toBe(false);
    for (const job of [JOBS.syncBroker, JOBS.enrichTransactions, JOBS.importUploaded]) {
      expect(await guardJob(guard, job)).toEqual({ allowed: true, state: 'warn', reason: 'within-budget' });
    }
  });

  it('runs the earnings jobs only below 60 % (they are a convenience: the next watch tries again)', async () => {
    const { guard } = await guardWith({ rowsRead: 3_000_000 });
    for (const job of [JOBS.watchEarnings, JOBS.fetchEarningsSummary]) expect(await guardJob(guard, job)).toEqual({ allowed: false, state: 'warn', reason: 'deferred-by-priority' });
    const calm = await guardWith({ rowsRead: 100 });
    expect((await guardJob(calm.guard, JOBS.fetchEarningsSummary)).allowed).toBe(true);
  });

  it('stops every job at 80 %', async () => {
    const { guard } = await guardWith({ rowsRead: 4_000_000 });
    for (const job of Object.values(JOBS)) expect(await guardJob(guard, job)).toEqual({ allowed: false, state: 'blocked', reason: 'blocked' });
  });

  it('denies every job while the ledger is unavailable', async () => {
    const { guard, store } = await guardWith({});
    store.failing = true;
    expect(await guardJob(guard, JOBS.syncBroker)).toEqual({ allowed: false, state: 'unavailable', reason: 'store-unavailable' });
  });

  it('treats an unknown job as non-essential', async () => {
    const { guard } = await guardWith({ rowsRead: 3_000_000 });
    expect((await guardJob(guard, 'somethingNew')).allowed).toBe(false);
    expect((await guardJob(guard, 'toString')).allowed).toBe(false);
  });

  it('has a ceiling for every job name', () => {
    expect([...Object.keys(JOB_CEILINGS)].sort((a, b) => a.localeCompare(b))).toEqual([...Object.values(JOBS)].sort((a, b) => a.localeCompare(b)));
  });
});
