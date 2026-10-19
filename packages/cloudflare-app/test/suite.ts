import { MAX_FILE_BYTES } from '@portfolio/cloudflare';
import { METRIC_LIMITS, type MetricLimits } from '@portfolio/platform';
import { usageSnapshotSchema } from '@portfolio/shared';
import { defineApiScenarios } from '@portfolio/api/testing';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Browser, type Stack } from './browser.js';
import { T212_KEY, T212_SECRET, OTHER_ID, OWNER_ID, OWNER_LOGIN } from './fakes.js';

export interface SuiteStartOptions {
  /** Caps the budget guard measures against (the Hub's clock is pinned at `PINNED_NOW` whenever limits are given). */
  limits?: MetricLimits;
}

export type StartStack = (options?: SuiteStartOptions) => Promise<Stack>;

/** The pinned Hub clock of the budget tests: 2026-01-05 12:00 UTC, i.e. 12 hours before the daily reset. */
export const PINNED_NOW = Date.UTC(2026, 0, 5, 12);
const SECONDS_TO_RESET = 12 * 3600;

const json = async (response: Response) => (await response.json()) as { error?: { code: string; details?: { blockedMetrics?: string[] } } } & Record<string, unknown>;

/**
 * The behaviour of the deployed app, written once and run twice: in Node (the real Worker and Hub over SQLite compiled to
 * WebAssembly, pinned clock) and in real workerd through Miniflare (the bundle `wrangler deploy` would upload).
 */
export function defineAppSuite(label: string, start: StartStack): void {
  describe(`${label}: sign-in and access control`, () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await start();
    });
    afterAll(() => stack?.dispose());

    it('answers the health check and serves the app shell without signing in', async () => {
      const browser = new Browser(stack);
      expect(await (await browser.request('/health')).json()).toEqual({ status: 'ok' });
      const shell = await browser.request('/some/deep/link');
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('<title>');
    });

    it('signs the owner in through the full OAuth round trip and out again', async () => {
      const browser = new Browser(stack);
      expect(await (await browser.request('/auth/session')).json()).toEqual({ authenticated: false });
      const login = await browser.request('/auth/login', { query: { returnTo: '/holdings' } });
      expect(login.status).toBe(302);
      const authorize = new URL(login.headers.get('location')!);
      expect(`${authorize.origin}${authorize.pathname}`).toBe('https://github.com/login/oauth/authorize');
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${stack.origin}/auth/callback`);
      expect(authorize.searchParams.get('scope')).toBe('');
      const callback = await browser.signIn('/holdings');
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('/holdings');
      expect(browser.cookieNames).toContain('pt_session');
      expect(await (await browser.request('/auth/session')).json()).toEqual({ authenticated: true, login: OWNER_LOGIN });
      expect((await browser.request('/api/portfolios')).status).toBe(200);
      expect((await browser.request('/auth/logout', { method: 'POST' })).status).toBe(204);
      expect((await browser.request('/api/portfolios')).status).toBe(401);
    });

    it('refuses every other GitHub account without a session and without revealing the owner', async () => {
      const browser = new Browser(stack);
      stack.github.signedInAs = { id: OTHER_ID, login: 'someone-else' };
      try {
        const callback = await browser.signIn();
        expect(callback.status).toBe(403);
        const text = await callback.text();
        expect(text).not.toContain(String(OWNER_ID));
        expect(text).not.toContain(OWNER_LOGIN);
      } finally {
        stack.github.signedInAs = { id: OWNER_ID, login: OWNER_LOGIN };
      }
      expect(browser.cookieNames).not.toContain('pt_session');
      expect((await browser.request('/api/portfolios')).status).toBe(401);
    });

    it('answers anonymous API calls with 401 and the error envelope, and reveals no route', async () => {
      const browser = new Browser(stack);
      for (const path of ['/api/portfolios', '/api/holdings', '/api/usage', '/usage', '/api/definitely-not-a-route', '/api/calendar.ics']) {
        const response = await browser.request(path);
        expect(response.status, path).toBe(401);
        expect((await json(response)).error?.code).toBe('UNAUTHENTICATED');
      }
    });

    it('rejects a forged or foreign session cookie', async () => {
      const response = await stack.send('/api/portfolios', { headers: { cookie: 'pt_session=eyJzdWIiOiJnaXRodWI6NDI0MjQyIn0.AAAA' } });
      expect(response.status).toBe(401);
    });

    it('does not let a client choose its identity through the internal header', async () => {
      const response = await stack.send('/api/portfolios', { headers: { 'x-pt-subject': `github:${OWNER_ID}` } });
      expect(response.status).toBe(401);
    });

    it('refuses cross-origin mutations (wrong Origin, no Origin) before anything else', async () => {
      const browser = new Browser(stack);
      await browser.signIn();
      const body = { name: 'Should not exist' };
      const foreign = await browser.request('/api/portfolios', { method: 'POST', body, origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      const missing = await browser.request('/api/portfolios', { method: 'POST', body, origin: null });
      expect(missing.status).toBe(403);
      const anonymous = await new Browser(stack).request('/api/portfolios', { method: 'POST', body, origin: 'https://evil.example' });
      expect(anonymous.status).toBe(403);
      const listed = await (await browser.request('/api/portfolios')).json();
      expect(JSON.stringify(listed)).not.toContain('Should not exist');
    });

    it('arms the Hub alarm and keeps it armed through the daily cron trigger', async () => {
      const armed = await stack.alarmAt();
      expect(armed).not.toBeNull();
      await stack.cron();
      expect(await stack.alarmAt()).not.toBeNull();
    });
  });

  describe(`${label}: the API through the Worker and the Hub`, () => {
    let stack: Stack;
    let owner: Browser;
    beforeAll(async () => {
      stack = await start();
      owner = new Browser(stack);
      await owner.signIn();
    });
    afterAll(() => stack?.dispose());

    const call = async (method: string, path: string, options: { query?: Record<string, string>; body?: unknown } = {}) => {
      const response = await owner.request(`/api${path}`, { method, ...options });
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return { status: response.status, body: text ? JSON.parse(text) : undefined, headers };
    };

    // The very same scenarios run on the in-memory dependencies and on LocalStack (services/api).
    defineApiScenarios(`${label}: Worker + Hub Durable Object`, {
      call: (method, path, options) => call(method, path, options),
      importCsv: async ({ uploadUrl }, csv) => {
        const target = new URL(uploadUrl);
        expect(target.origin).toBe(stack.origin);
        // The upload is public (the token is the credential): a fresh browser without a session.
        const put = await new Browser(stack).request(target.pathname, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv' } });
        expect(put.status).toBe(204);
        await stack.drain();
      },
    });

    it('keeps the stored data per user id and answers CORS preflights without data', async () => {
      const created = await call('POST', '/portfolios', { body: { name: `Owner data ${crypto.randomUUID().slice(0, 8)}` } });
      expect(created.status).toBe(201);
      const options = await call('OPTIONS', '/portfolios');
      expect(options.status).toBe(204);
      expect(options.headers['access-control-allow-origin']).toBe(stack.origin);
    });

    it('serves the usage snapshot at /api/usage and /usage', async () => {
      for (const path of ['/api/usage', '/usage']) {
        const response = await owner.request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const snapshot = usageSnapshotSchema.parse(await response.json());
        expect(snapshot.state).toBe('ok');
        expect(snapshot.metrics.workerRequests.used).toBeGreaterThan(0);
        expect(snapshot.metrics.durableObjectRequests.used).toBeGreaterThan(0);
        expect(snapshot.metrics.rowsWritten.used).toBeGreaterThan(0);
        expect(snapshot.metrics.workerRequests.limit).toBe(100_000);
      }
    });

    it('counts the requests in the ledger', async () => {
      const used = async () => usageSnapshotSchema.parse(await (await owner.request('/api/usage')).json()).metrics.workerRequests.used;
      const before = await used();
      await call('GET', '/portfolios');
      await call('GET', '/portfolios');
      expect((await used()) - before).toBe(3); // the two calls and the second reading of /api/usage
    });

    it('accepts uploads without sign-in only with a valid token, and bounds their size', async () => {
      const anonymous = new Browser(stack);
      const unknown = await anonymous.request('/api/uploads/does-not-exist-token', { method: 'PUT', body: 'a,b', headers: { 'content-type': 'text/csv' } });
      expect(unknown.status).toBe(404);
      const portfolio = (await call('POST', '/portfolios', { body: { name: `Upload ${crypto.randomUUID().slice(0, 8)}` } })).body.portfolioId as string;
      const created = (await call('POST', '/imports', { body: { fileName: 'big.csv', portfolioId: portfolio } })).body as { uploadUrl: string };
      const path = new URL(created.uploadUrl).pathname;
      const tooBig = await anonymous.request(path, { method: 'PUT', body: new Uint8Array(MAX_FILE_BYTES + 1), headers: { 'content-type': 'text/csv' } });
      expect(tooBig.status).toBe(413);
      const csv = 'date,type,symbol,quantity,price,fee,currency\n2026-01-02,BUY,SAP.DE,1,200,0,EUR\n';
      expect((await anonymous.request(path, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv' } })).status).toBe(204);
      // The token is single use.
      expect((await anonymous.request(path, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv' } })).status).toBe(404);
      await stack.drain();
    });

    it('syncs Trading 212 through resumable alarm steps with the stored (encrypted) credentials', async () => {
      const portfolio = (await call('POST', '/portfolios', { body: { name: `Broker ${crypto.randomUUID().slice(0, 8)}` } })).body.portfolioId as string;
      const credentials = { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' };
      stack.trading212.rejectCredentials = true;
      expect((await call('PUT', '/brokers/trading212', { body: credentials })).status).toBe(422);
      stack.trading212.rejectCredentials = false;
      expect((await call('PUT', '/brokers/trading212', { body: credentials })).status).toBe(204);

      const status = await call('GET', '/brokers/trading212', { query: { portfolioId: portfolio } });
      expect(status.status).toBe(200);
      expect(JSON.stringify(status.body)).not.toContain(T212_SECRET);

      expect((await call('POST', '/brokers/trading212/sync', { body: { portfolioId: portfolio } })).status).toBe(202);
      await stack.drain();

      const holdings = await call('GET', '/holdings', { query: { portfolioId: portfolio } });
      expect(holdings.body.holdings.map((h: { symbol: string; quantity: number }) => [h.symbol, h.quantity])).toEqual([['SAP.DE', 5]]);
      const after = await call('GET', '/brokers/trading212', { query: { portfolioId: portfolio } });
      expect(after.body).toMatchObject({ connected: true, status: 'SUCCEEDED' });
      expect(stack.trading212.calls.filter((entry) => entry === 'GET history/orders').length).toBeGreaterThanOrEqual(2);
      expect(stack.trading212.authorized).toBe(true);

      // Running the sync again changes nothing (deterministic ids, idempotent steps).
      expect((await call('POST', '/brokers/trading212/sync', { body: { portfolioId: portfolio } })).status).toBe(202);
      await stack.drain();
      const again = await call('GET', '/transactions', { query: { portfolioId: portfolio } });
      expect(again.body.transactions).toHaveLength(2);
      expect((await call('DELETE', '/brokers/trading212')).status).toBe(204);
    });
  });

  describe(`${label}: free-plan budget guard`, () => {
    let stack: Stack;
    let owner: Browser;
    const limits: MetricLimits = { ...METRIC_LIMITS, workerRequests: 30 };
    beforeAll(async () => {
      stack = await start({ limits });
      owner = new Browser(stack);
      await owner.signIn();
    });
    afterAll(() => stack?.dispose());

    it('answers 429 BUDGET_EXHAUSTED with Retry-After at 80 % of a cap, but keeps /api/usage and sign-in reachable', async () => {
      const created = await owner.request('/api/portfolios', { method: 'POST', body: { name: 'Before the limit' } });
      expect(created.status).toBe(201);
      const portfolio = ((await created.json()) as { portfolioId: string }).portfolioId;
      const upload = (await (await owner.request('/api/imports', { method: 'POST', body: { fileName: 'a.csv', portfolioId: portfolio } })).json()) as { uploadUrl: string };

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 30 && !statuses.includes(429); attempt++) statuses.push((await owner.request('/api/portfolios')).status);
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
      // A request is counted before it is checked: the 24th (80 % of 30) is the first one refused, 2 were used above.
      expect(statuses).toHaveLength(22);

      const refused = await owner.request('/api/portfolios');
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe(String(SECONDS_TO_RESET));
      expect(refused.headers.get('cache-control')).toBe('no-store');
      const body = await json(refused);
      expect(body.error?.code).toBe('BUDGET_EXHAUSTED');
      expect(body.error?.details?.blockedMetrics).toEqual(['workerRequests']);

      expect((await owner.request('/api/portfolios', { method: 'POST', body: { name: 'After the limit' } })).status).toBe(429);
      const put = await new Browser(stack).request(new URL(upload.uploadUrl).pathname, { method: 'PUT', body: 'x', headers: { 'content-type': 'text/csv' } });
      expect(put.status).toBe(429);

      for (const path of ['/api/usage', '/usage']) {
        const usage = await owner.request(path);
        expect(usage.status).toBe(200);
        const snapshot = usageSnapshotSchema.parse(await usage.json());
        expect(snapshot.state).toBe('blocked');
        expect(snapshot.metrics.workerRequests.state).toBe('blocked');
        expect(snapshot.resetsAt).toBe('2026-01-06T00:00:00.000Z');
      }
      expect((await new Browser(stack).request('/auth/session')).status).toBe(200);
      expect((await new Browser(stack).request('/health')).status).toBe(200);
    });
  });
}
