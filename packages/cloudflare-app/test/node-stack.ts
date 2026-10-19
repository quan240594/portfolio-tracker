import type { JobFactories } from '../src/jobs.js';
import { HubCore } from '../src/hub-core.js';
import { createWorker } from '../src/worker.js';
import type { WorkerEnv } from '../src/runtime.js';
import { SqlJsStorage, TestClock } from '@portfolio/cloudflare/testing';
import type { MetricLimits } from '@portfolio/platform';
import { parsePricesConfig } from '@portfolio/prices';
import { FakeGithub, FakePrices, FakeTrading212, ORIGIN, OWNER_ID, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_SECRETS_KEY, TEST_SESSION_SECRET, route, type FakeRequest, type FakeService } from './fakes.js';
import type { Stack } from './browser.js';

export const T0 = Date.UTC(2026, 0, 5, 12);

export interface NodeStackOptions {
  limits?: MetricLimits;
  jobFactories?: JobFactories;
  /** Replaces the vars of the Worker/Hub (e.g. to leave one out). */
  env?: Partial<WorkerEnv>;
  /** Environment of the price service (provider keys, tuning): none by default, i.e. no price source is on. */
  prices?: Record<string, string>;
  /** Extra outbound services, tried before the built-in fakes. */
  services?: FakeService[];
}

const asFakeRequest = (input: RequestInfo | URL, init?: RequestInit): FakeRequest => {
  const request = new Request(input, init);
  return { url: request.url, method: request.method, header: (name) => request.headers.get(name) };
};

/**
 * The whole app in Node: the real Worker in front of a real `HubCore` on real SQLite (WebAssembly), with the outbound
 * network replaced by the fakes. The clock is pinned; the alarm is driven by `drain()`.
 */
export async function createNodeStack(options: NodeStackOptions = {}): Promise<Stack & { storage: SqlJsStorage; core: HubCore; clock: TestClock; worker: ReturnType<typeof createWorker>; env: WorkerEnv }> {
  const github = new FakeGithub();
  const trading212 = new FakeTrading212();
  const clock = new TestClock(T0);
  const prices = new FakePrices(() => clock.ms);
  const services = [...(options.services ?? []), github.service, trading212.service, prices.service];
  const outbound = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const reply = route(services, asFakeRequest(input, init));
    return Promise.resolve(Response.json(reply.json ?? null, { status: reply.status, headers: reply.headers }));
  };
  const storage = await SqlJsStorage.create();
  const vars = { ORIGIN, OWNER_GITHUB_ID: String(OWNER_ID), GITHUB_CLIENT_ID: TEST_CLIENT_ID, GITHUB_CLIENT_SECRET: TEST_CLIENT_SECRET, SESSION_SECRET: TEST_SESSION_SECRET, SECRETS_KEY: TEST_SECRETS_KEY };
  const core = new HubCore(
    { storage, blockConcurrencyWhile: (callback) => callback() },
    { secretsKey: TEST_SECRETS_KEY, origin: ORIGIN, baseCurrency: 'EUR', brokerSecretPrefix: '/test/broker/trading212', symbolOverrides: {}, prices: parsePricesConfig(options.prices ?? {}) },
    { now: clock.now, limits: options.limits, jobFactories: options.jobFactories, fetch: outbound, sleep: () => Promise.resolve(), queue: { baseBackoffMs: 1_000 } },
  );
  await core.start();
  const env: WorkerEnv = {
    ...vars,
    HUB: { idFromName: () => 'hub', get: () => ({ fetch: (request) => core.handle(request) }) },
    ASSETS: { fetch: () => Promise.resolve(new Response('<!doctype html><title>app</title>', { headers: { 'content-type': 'text/html' } })) },
    ...options.env,
  };
  const worker = createWorker({ fetch: (url, init) => outbound(url, init as RequestInit), now: () => clock.ms });
  const drain = async (round = 0): Promise<void> => {
    if (round >= 100) throw new Error('The queue did not drain');
    await core.alarm();
    const due = core.platform.jobs.nextJobDueAt();
    if (due === null) return;
    clock.ms = Math.max(clock.ms, due);
    await drain(round + 1);
  };
  return {
    origin: ORIGIN,
    github,
    trading212,
    prices,
    storage,
    core,
    clock,
    worker,
    env,
    send: (path, init) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env),
    drain,
    enqueue: (job, payload) => core.platform.jobs.enqueue({ job, payload } as never),
    failedJobs: () => Promise.resolve(core.platform.jobs.failedJobs().map(({ job, error }) => ({ job, error }))),
    schedules: () => Promise.resolve(storage.rows<{ name: string }>('SELECT name FROM schedules ORDER BY name').map((row) => row.name)),
    alarmAt: () => Promise.resolve(storage.alarm),
    cron: () => worker.scheduled({}, env),
    advance: (ms) => clock.advance(ms),
    dispose: () => Promise.resolve(),
  };
}
