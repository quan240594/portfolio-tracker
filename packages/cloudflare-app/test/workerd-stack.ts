import { build } from 'esbuild';
import { Log, LogLevel, Miniflare, Response as MiniflareResponse } from 'miniflare';
import { fileURLToPath } from 'node:url';
import type { Stack } from './browser.js';
import { FakeGithub, FakePrices, FakeTrading212, ORIGIN, OWNER_ID, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_SECRETS_KEY, TEST_SESSION_SECRET, route } from './fakes.js';
import { PINNED_NOW, type SuiteStartOptions } from './suite.js';

const ENTRY = fileURLToPath(new URL('./entry.ts', import.meta.url));
const ASSETS = fileURLToPath(new URL('./assets', import.meta.url));

let bundle: Promise<string> | undefined;

/** Bundles the test entry the way wrangler does (one ES module, `cloudflare:workers` and `node:*` left to the runtime). */
export function bundleWorker(): Promise<string> {
  bundle ??= build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers', 'node:*'],
    logLevel: 'silent',
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

interface HubState {
  schedules: string[];
  alarm: number | null;
  pendingJobs: number | null;
  failedJobs: { job: string; error: string | null }[];
  storageBytes: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The app in real workerd: Miniflare runs the bundle with a SQLite-backed Hub; the outbound network is the fakes. */
export async function createWorkerdStack(options: SuiteStartOptions = {}): Promise<Stack & { hubState(): Promise<HubState> }> {
  const github = new FakeGithub();
  const trading212 = new FakeTrading212();
  const prices = new FakePrices(() => Date.now());
  const services = [github.service, trading212.service, prices.service];
  const mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: await bundleWorker() }],
    // The Hub logs one JSON line per request; the tests do not need them.
    log: new Log(LogLevel.ERROR),
    handleRuntimeStdio: (stdout, stderr) => {
      stdout.resume();
      stderr.pipe(process.stderr);
    },
    compatibilityDate: '2026-04-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { HUB: { className: 'Hub', useSQLite: true } },
    durableObjectsPersist: false,
    assets: {
      directory: ASSETS,
      binding: 'ASSETS',
      // wrangler.jsonc: run_worker_first for the API, sign-in, usage and health paths; everything else is a static file.
      routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/api/*', '/auth/*', '/usage', '/health'] } },
      assetConfig: { not_found_handling: 'single-page-application' },
    },
    bindings: {
      ORIGIN,
      OWNER_GITHUB_ID: String(OWNER_ID),
      GITHUB_CLIENT_ID: TEST_CLIENT_ID,
      GITHUB_CLIENT_SECRET: TEST_CLIENT_SECRET,
      SESSION_SECRET: TEST_SESSION_SECRET,
      SECRETS_KEY: TEST_SECRETS_KEY,
      ...options.prices,
      ...(options.limits ? { TEST_LIMITS: JSON.stringify(options.limits), TEST_NOW: String(PINNED_NOW) } : {}),
    },
    outboundService: (request) => {
      const reply = route(services, { url: request.url, method: request.method, header: (name) => request.headers.get(name) });
      return MiniflareResponse.json(reply.json ?? null, { status: reply.status, headers: reply.headers });
    },
  });
  await mf.ready;

  const namespace = async () =>
    (await mf.getDurableObjectNamespace('HUB')) as unknown as {
      idFromName(name: string): unknown;
      get(id: unknown): { fetch(url: string, init?: { method: string; body: string }): Promise<{ json(): Promise<unknown> }> };
    };
  const hubState = async (): Promise<HubState> => {
    const hub = await namespace();
    return (await (await hub.get(hub.idFromName('hub')).fetch('http://hub.internal/__test/state')).json()) as HubState;
  };
  const drain = async (deadline = Date.now() + 20_000): Promise<void> => {
    const state = await hubState();
    if (state.pendingJobs === null) return;
    if (Date.now() > deadline) throw new Error(`The Hub did not drain: ${JSON.stringify(state)}`);
    await sleep(50);
    await drain(deadline);
  };
  return {
    origin: ORIGIN,
    github,
    trading212,
    prices,
    hubState,
    send: async (path, init) => (await mf.dispatchFetch(`${ORIGIN}${path}`, init as never)) as unknown as Response,
    drain,
    enqueue: async (job, payload) => {
      const hub = await namespace();
      await hub.get(hub.idFromName('hub')).fetch('http://hub.internal/__test/enqueue', { method: 'POST', body: JSON.stringify({ job, payload }) });
    },
    failedJobs: async () => (await hubState()).failedJobs,
    schedules: async () => (await hubState()).schedules,
    alarmAt: async () => (await hubState()).alarm,
    cron: async () => {
      const worker = (await mf.getWorker()) as unknown as { scheduled(options: { cron: string }): Promise<unknown> };
      await worker.scheduled({ cron: '17 3 * * *' });
    },
    dispose: () => mf.dispose(),
  };
}
