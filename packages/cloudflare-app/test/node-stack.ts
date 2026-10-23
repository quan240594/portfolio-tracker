import type { JobFactories } from '../src/jobs.js';
import { HubCore } from '../src/hub-core.js';
import { createWorker } from '../src/worker.js';
import type { WorkerEnv } from '../src/runtime.js';
import { SqlJsStorage, TestClock } from '@portfolio/cloudflare/testing';
import { parseAllowedHosts, parseLogosConfig, type MetricLimits } from '@portfolio/platform';
import { parsePricesConfig } from '@portfolio/prices';
import { parseEarningsConfig } from '@portfolio/earnings';
import { fakeAiFor, secFor } from './earnings-fakes.js';
import { FakeGithub, FakeLogos, FakePrices, FakePush, FakeTrading212, ORIGIN, OWNER_ID, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_SECRETS_KEY, TEST_SESSION_SECRET, TEST_VAPID, route, type FakeRequest, type FakeService } from './fakes.js';
import type { Stack } from './browser.js';
import type { EarningsStartOptions } from './suite.js';

export const T0 = Date.UTC(2026, 0, 5, 12);

export interface NodeStackOptions {
  limits?: MetricLimits;
  jobFactories?: JobFactories;
  /** Replaces the vars of the Worker/Hub (e.g. to leave one out). */
  env?: Partial<WorkerEnv>;
  /** Environment of the price service (provider keys, tuning): none by default, i.e. no price source is on. */
  prices?: Record<string, string>;
  /** Variables of the logo service (`LOGO_SOURCES`, `LOGO_HOURLY_LIMIT`, ...): the defaults when absent. */
  logos?: Record<string, string>;
  /** Extra outbound services, tried before the built-in fakes. */
  services?: FakeService[];
  /** Leaves the VAPID keys out: the notification feature is then switched off (the default has them). */
  noVapid?: boolean;
  /** Earnings summaries: the fake SEC's releases, `SEC_CONTACT` and the Workers AI binding. */
  earnings?: EarningsStartOptions;
}

const asFakeRequest = async (input: RequestInfo | URL, init?: RequestInit): Promise<FakeRequest> => {
  const request = new Request(input, init);
  return { url: request.url, method: request.method, header: (name) => request.headers.get(name), body: new Uint8Array(await request.arrayBuffer()) };
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
  const logos = new FakeLogos();
  const push = new FakePush();
  const sec = secFor(options.earnings);
  const services = [...(options.services ?? []), github.service, trading212.service, sec.service, prices.service, logos.service, push.service];
  const outbound = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const reply = route(services, await asFakeRequest(input, init));
    if (reply.bytes !== undefined) return new Response(reply.bytes as Uint8Array<ArrayBuffer>, { status: reply.status, headers: reply.headers });
    return Response.json(reply.json ?? null, { status: reply.status, headers: reply.headers });
  };
  const storage = await SqlJsStorage.create();
  const vars = { ORIGIN, OWNER_GITHUB_ID: String(OWNER_ID), GITHUB_CLIENT_ID: TEST_CLIENT_ID, GITHUB_CLIENT_SECRET: TEST_CLIENT_SECRET, SESSION_SECRET: TEST_SESSION_SECRET, SECRETS_KEY: TEST_SECRETS_KEY };
  const core = new HubCore(
    { storage, blockConcurrencyWhile: (callback) => callback() },
    {
      secretsKey: TEST_SECRETS_KEY,
      origin: ORIGIN,
      baseCurrency: 'EUR',
      brokerSecretPrefix: '/test/broker/trading212',
      symbolOverrides: {},
      prices: parsePricesConfig(options.prices ?? {}),
      logos: parseLogosConfig(options.logos ?? {}),
      earnings: parseEarningsConfig({ ...(options.earnings?.contact === undefined ? {} : { SEC_CONTACT: options.earnings.contact }), ...(options.prices?.ALPHAVANTAGE_API_KEY === undefined ? {} : { ALPHAVANTAGE_API_KEY: options.prices.ALPHAVANTAGE_API_KEY }) }),
      push: { ...(options.noVapid ? {} : { publicKey: TEST_VAPID.publicKey, privateKey: TEST_VAPID.privateKey }), allowedHosts: parseAllowedHosts(undefined) },
    },
    { now: clock.now, limits: options.limits, jobFactories: options.jobFactories, ...(options.earnings?.ai ? { ai: fakeAiFor(options.earnings.releases ?? []) } : {}), fetch: outbound, sleep: () => Promise.resolve(), queue: { baseBackoffMs: 1_000 } },
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
    await storage.runAlarmHandler(() => core.alarm());
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
    logos,
    push,
    sec,
    storage,
    core,
    clock,
    worker,
    env,
    send: (path, init) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env),
    drain: () => drain(),
    seed: (items) => core.platform.items.batchWrite(items.map((item) => ({ type: 'put' as const, item }))),
    enqueue: (job, payload) => core.platform.jobs.enqueue({ job, payload } as never),
    failedJobs: () => Promise.resolve(core.platform.jobs.failedJobs().map(({ job, error }) => ({ job, error }))),
    schedules: () => Promise.resolve(storage.rows<{ name: string }>('SELECT name FROM schedules ORDER BY name').map((row) => row.name)),
    alarmAt: () => Promise.resolve(storage.alarm),
    cron: () => worker.scheduled({}, env),
    advance: (ms) => clock.advance(ms),
    dispose: () => Promise.resolve(),
  };
}
