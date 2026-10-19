import { JOBS, type JobHandler } from '@portfolio/platform';
import { usageSnapshotSchema } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import { Browser } from '../test/browser.js';
import { createNodeStack, type NodeStackOptions } from '../test/node-stack.js';
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
    const { stack, api } = await signedIn();
    const portfolio = (await api('POST', '/portfolios', { name: 'Quiet' })).body.portfolioId as string;
    await api('POST', '/transactions', { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'SAP.DE', quantity: 1, price: 100, currency: 'EUR' });
    expect(stack.storage.rows("SELECT id FROM jobs WHERE job = 'enrichTransactions'")).toEqual([]);
    expect(stack.storage.rows<{ name: string }>('SELECT name FROM schedules').map((row) => row.name)).toEqual(['broker-sync']);
  });

  it('wires a registered price service: events become jobs, its schedules are kept, and the alarm runs it', async () => {
    const enrich = vi.fn<JobHandler<never>>(() => Promise.resolve({ done: true as const, result: 'enriched' }));
    const jobFactories: JobFactories = { ...CORE_JOB_FACTORIES, enrichTransactions: () => enrich as never, refreshPrices: () => enrich as never, refreshCalendar: () => enrich as never };
    const { stack, api } = await signedIn({ jobFactories });
    expect(stack.storage.rows<{ name: string }>('SELECT name FROM schedules ORDER BY name').map((row) => row.name)).toEqual(['broker-sync', 'prices-calendar', 'prices-refresh']);
    const portfolio = (await api('POST', '/portfolios', { name: 'Priced' })).body.portfolioId as string;
    await api('POST', '/transactions', { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'SAP.DE', quantity: 1, price: 100, currency: 'EUR' });
    await stack.drain();
    expect(enrich).toHaveBeenCalledWith({ payload: { userId: 'github-424242', portfolioId: portfolio, symbols: ['SAP.DE'], reason: 'CREATED' }, cursor: undefined });
    expect(JOBS.enrichTransactions).toBe('enrichTransactions');
  });
});
