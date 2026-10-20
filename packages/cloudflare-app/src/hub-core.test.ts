import { JOBS, type JobHandler } from '@portfolio/platform';
import { usageSnapshotSchema } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import { Browser } from '../test/browser.js';
import { createNodeStack, type NodeStackOptions } from '../test/node-stack.js';
import { AAPL_T212_PRICE, SAP_PRICE, T212_KEY, T212_SECRET, TD_KEY } from '../test/fakes.js';
import { CORE_JOB_FACTORIES, type JobFactories } from './jobs.js';

const HUB = 'https://hub.internal';

async function signedIn(options?: NodeStackOptions) {
  const stack = await createNodeStack(options);
  const owner = new Browser(stack);
  await owner.signIn();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
  };
  const ledger = () => stack.storage.rows<{ worker_requests: number; durable_object_requests: number; rows_written: number }>('SELECT worker_requests, durable_object_requests, rows_written FROM usage');
  return { stack, owner, api, ledger };
}

describe('HubCore', () => {
  it('answers the keep-alive call and refuses everything else without the Worker-verified subject', async () => {
    const { stack } = await signedIn();
    expect((await stack.core.handle(new Request(`${HUB}/internal/arm`, { method: 'POST' }))).status).toBe(204);
    for (const path of ['/api/portfolios', '/usage', '/internal/arm']) {
      expect((await stack.core.handle(new Request(`${HUB}${path}`))).status, path).toBe(401);
    }
    const forged = await stack.core.handle(new Request(`${HUB}/api/portfolios`, { headers: { 'x-pt-subject': 'someone-else' } }));
    expect(forged.status).toBe(401);
  });

  it('never lets a client request reach the keep-alive call through the Worker', async () => {
    const { stack, owner } = await signedIn();
    const hub = vi.spyOn(stack.core, 'handle');
    await owner.request('/internal/arm', { method: 'POST' });
    const viaApi = await owner.request('/api/internal/arm', { method: 'POST' });
    expect(viaApi.status).toBe(404);
    expect(hub.mock.calls.every(([request]) => new URL(request.url).pathname !== '/internal/arm')).toBe(true);
  });

  it('writes the ledger at the end of every request, not only after 20 records', async () => {
    const { api, ledger } = await signedIn();
    await api('GET', '/portfolios');
    expect(ledger()[0]!.worker_requests).toBe(1);
    await api('GET', '/portfolios');
    await api('GET', '/health');
    expect(ledger()).toHaveLength(1); // one row per UTC day
    expect(ledger()[0]!.worker_requests).toBe(3);
    expect(ledger()[0]!.rows_written).toBeGreaterThan(0);
  });

  it('keeps reads and refuses writes with 503 BUDGET_UNAVAILABLE while the ledger cannot be read', async () => {
    const { stack, api } = await signedIn();
    stack.storage.exec('DROP TABLE usage');
    expect((await api('GET', '/portfolios')).status).toBe(200);
    const write = await api('POST', '/portfolios', { name: 'Blocked' });
    expect(write.status).toBe(503);
    expect(write.body.error.code).toBe('BUDGET_UNAVAILABLE');
    expect(write.headers.get('retry-after')).toBe('60');
    const usage = await api('GET', '/usage');
    expect(usage.status).toBe(200);
    expect(usageSnapshotSchema.parse(usage.body).state).toBe('unavailable');
  });

  it('reports the storage gauge from the database size (0 where the runtime has none)', async () => {
    const { api } = await signedIn();
    const snapshot = usageSnapshotSchema.parse((await api('GET', '/usage')).body);
    expect(snapshot.metrics.storageBytes).toMatchObject({ used: 0, limit: 1_000_000_000, state: 'ok' });
  });

  it('answers 410 for an expired upload token and 413 (token kept) for an oversized body at the Hub itself', async () => {
    const { stack, api } = await signedIn();
    const portfolio = (await api('POST', '/portfolios', { name: 'Uploads' })).body.portfolioId as string;
    const created = (await api('POST', '/imports', { fileName: 'a.csv', portfolioId: portfolio })).body as { uploadUrl: string };
    const path = new URL(created.uploadUrl).pathname;
    const big = await stack.core.handle(new Request(`${HUB}${path}`, { method: 'PUT', body: new Uint8Array(1_572_865) }));
    expect(big.status).toBe(413);
    stack.advance!(301_000);
    const late = await stack.core.handle(new Request(`${HUB}${path}`, { method: 'PUT', body: 'a' }));
    expect(late.status).toBe(410);
  });

  it('counts an alarm as one Durable Object request and writes the ledger', async () => {
    const { stack, ledger } = await signedIn();
    await stack.core.alarm();
    await stack.core.alarm();
    expect(ledger()[0]!.durable_object_requests).toBe(2);
  });

  it('defers an essential job while the budget is blocked and runs it after the reset, never failing it', async () => {
    const { stack, api, owner } = await signedIn();
    const portfolio = (await api('POST', '/portfolios', { name: 'Deferred' })).body.portfolioId as string;
    const created = (await api('POST', '/imports', { fileName: 'a.csv', portfolioId: portfolio })).body as { importId: string; uploadUrl: string };
    const csv = 'date,type,symbol,quantity,price,fee,currency\n2026-01-02,BUY,SAP.DE,1,200,0,EUR\n';
    expect((await new Browser(stack).request(new URL(created.uploadUrl).pathname, { method: 'PUT', body: csv })).status).toBe(204);

    await stack.core.guard.record({ workerRequests: 90_000 });
    await stack.core.alarm();
    expect(stack.core.platform.jobs.nextJobDueAt()).not.toBeNull();
    expect(stack.core.platform.jobs.failedJobs()).toEqual([]);
    expect((await owner.request(`/api/imports/${created.importId}`)).status).toBe(429);

    stack.advance!(25 * 3_600_000);
    await stack.drain();
    expect(stack.core.platform.jobs.failedJobs()).toEqual([]);
    expect((await (await owner.request(`/api/imports/${created.importId}`)).json()).status).toBe('COMPLETED');
  });

  it('enqueues nothing for events while no price service is registered', async () => {
    const { stack, api } = await signedIn({ jobFactories: CORE_JOB_FACTORIES });
    const portfolio = (await api('POST', '/portfolios', { name: 'Quiet' })).body.portfolioId as string;
    await api('POST', '/transactions', { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'SAP.DE', quantity: 1, price: 100, currency: 'EUR' });
    expect(stack.storage.rows("SELECT id FROM jobs WHERE job = 'enrichTransactions'")).toEqual([]);
    expect(stack.storage.rows<{ name: string }>('SELECT name FROM schedules').map((row) => row.name)).toEqual(['broker-sync', 't212-quotes', 't212-quotes-close']);
  });

  it('wires a replaced price service: events become jobs, its schedules are kept, and the alarm runs it', async () => {
    const enrich = vi.fn<JobHandler<never>>(() => Promise.resolve({ done: true as const, result: 'enriched' }));
    const jobFactories: JobFactories = { ...CORE_JOB_FACTORIES, enrichTransactions: () => enrich as never, refreshPrices: () => enrich as never, refreshCalendar: () => enrich as never };
    const { stack, api } = await signedIn({ jobFactories });
    expect(stack.storage.rows<{ name: string }>('SELECT name FROM schedules ORDER BY name').map((row) => row.name)).toEqual(['broker-sync', 'prices-calendar', 'prices-refresh', 't212-quotes', 't212-quotes-close']);
    const portfolio = (await api('POST', '/portfolios', { name: 'Priced' })).body.portfolioId as string;
    await api('POST', '/transactions', { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'SAP.DE', quantity: 1, price: 100, currency: 'EUR' });
    await stack.drain();
    expect(enrich).toHaveBeenCalledWith({ payload: { userId: 'github-424242', portfolioId: portfolio, symbols: ['SAP.DE'], reason: 'CREATED' }, cursor: undefined });
    expect(JOBS.enrichTransactions).toBe('enrichTransactions');
  });

  it('fires the price schedules by itself when their slot comes, through the same guarded alarm', async () => {
    const { stack } = await signedIn({ prices: { TWELVEDATA_API_KEY: TD_KEY, FX_HISTORY_START: '2026-01-01' } });
    expect(stack.prices.calls).toEqual([]);
    stack.advance!(8 * 3_600_000); // Monday 20:00 UTC, past the 13:00, 18:00 and 22:00 (Amsterdam) slots of the day
    await stack.drain();
    expect(stack.core.platform.jobs.failedJobs()).toEqual([]);
    expect(stack.prices.callsTo('api.frankfurter.dev').length).toBeGreaterThan(0);
  });

  it('never makes more than 45 outbound calls in one alarm, however many a job tries', async () => {
    const callUntilRefused = async (context: { fetch: typeof fetch }, made = 0): Promise<number> => {
      const refused = await context.fetch('https://api.frankfurter.dev/v1/latest').then(() => false, () => true);
      return refused || made >= 100 ? made : callUntilRefused(context, made + 1);
    };
    const jobFactories: JobFactories = {
      ...CORE_JOB_FACTORIES,
      refreshPrices: (context) => async () => ({ done: true as const, result: await callUntilRefused(context) }),
    };
    const { stack } = await signedIn({ jobFactories });
    await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
    await stack.core.alarm();
    expect(stack.prices.callsTo('api.frankfurter.dev')).toHaveLength(45);
    expect(stack.core.platform.jobs.failedJobs()).toEqual([]);
  });

  it('offers the platform MarketDataService over the same store, with a counted fetch', async () => {
    const { stack } = await signedIn({ prices: { TWELVEDATA_API_KEY: TD_KEY, FX_HISTORY_START: '2026-01-05' } });
    const summary = await stack.core.marketData().refreshScheduled(new Date(stack.clock.ms));
    expect(summary).toMatchObject({ fxUpdated: true, failed: 0 });
    expect(stack.storage.rows("SELECT pk FROM items WHERE pk = 'FX#EUR' AND sk = 'LATEST'")).toHaveLength(1);
  });

  it('refreshes the Trading 212 quotes in the alarm of their slot with one request and a few rows, then sleeps until the next slot', async () => {
    const { stack, api, ledger } = await signedIn();
    const portfolio = (await api('POST', '/portfolios', { name: 'Slots' })).body.portfolioId as string;
    expect((await api('PUT', '/brokers/trading212', { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' })).status).toBe(204);
    await api('POST', '/brokers/trading212/sync', { portfolioId: portfolio });
    await stack.drain();
    expect(stack.trading212.positionCalls()).toBe(1); // the refresh that follows the sync

    const slot = stack.storage.rows<{ next_run_at: number }>("SELECT next_run_at FROM schedules WHERE name = 't212-quotes'")[0]!.next_run_at;
    expect(slot).toBeGreaterThan(stack.clock.ms);
    expect(slot - stack.clock.ms).toBeLessThanOrEqual(15 * 60_000);
    stack.clock.ms = slot;
    const written = ledger()[0]!.rows_written;
    await stack.core.alarm();
    expect(stack.trading212.positionCalls()).toBe(2);
    expect(stack.core.platform.jobs.failedJobs()).toEqual([]);
    expect(stack.core.platform.jobs.nextJobDueAt()).toBeNull();
    expect(await stack.core.platform.items.get({ PK: 'TICKER#SAP.DE', SK: 'QUOTE#LATEST' })).toMatchObject({ price: SAP_PRICE, asOf: new Date(slot).toISOString(), source: 't212' });
    expect(await stack.core.platform.items.get({ PK: 'TICKER#AAPL', SK: 'QUOTE#LATEST' })).toMatchObject({ price: AAPL_T212_PRICE, currency: 'USD' });
    // 8 rows for two held symbols, i.e. 6 + one per symbol: the quotes, the status, the job row (insert, delete), the schedules and the ledger.
    expect(ledger()[0]!.rows_written - written).toBeLessThanOrEqual(10);
    // The next wake-up is the next 15-minute slot (the sync schedule or the quote schedule, whichever is first): nothing in between.
    expect(stack.storage.alarm).toBe(slot + 15 * 60_000);
  });
});
