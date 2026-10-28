import { MAX_FILE_BYTES } from '@portfolio/cloudflare';
import { METRIC_LIMITS, type MetricLimits } from '@portfolio/platform';
import { createTestSubscriber, verifyVapidAuthorization } from '@portfolio/platform/testing';
import type { FixtureRelease } from '@portfolio/earnings/testing';
import { alarmDiagnosticsSchema, usageSnapshotSchema, type AlarmDiagnosticsReport } from '@portfolio/shared';
import { defineApiScenarios } from '@portfolio/api/testing';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Browser, type Stack } from './browser.js';
import { AAPL_CLOSE, AAPL_T212_PRICE, AV_KEY, EODHD_KEY, SAP_PRICE, T212_KEY, T212_SECRET, TD_KEY, OTHER_ID, OWNER_ID, OWNER_LOGIN, TEST_VAPID, XETRA_CLOSES } from './fakes.js';

export interface SuiteStartOptions {
  /** Caps the budget guard measures against (the Hub's clock is pinned at `PINNED_NOW` whenever limits are given). */
  limits?: MetricLimits;
  /** Environment of the price service: provider keys (test values) and tuning, e.g. `{ TWELVEDATA_API_KEY: ... }`. None by default. */
  prices?: Record<string, string>;
  /** Variables of the logo service (`LOGO_SOURCES`, `LOGO_HOURLY_LIMIT`, `LOGO_DEV_TOKEN`...). */
  logos?: Record<string, string>;
  /** Leaves the VAPID keys out: the notification feature is off. */
  noVapid?: boolean;
  /** Earnings summaries: the invented releases the fake SEC serves, the `SEC_CONTACT` of the Worker and whether the Workers AI binding exists (a fake that extracts them). */
  earnings?: EarningsStartOptions;
}

export interface EarningsStartOptions {
  releases?: readonly FixtureRelease[];
  /** The `SEC_CONTACT` variable; absent = the feature reports "not configured". */
  contact?: string;
  /** Adds the fake Workers AI binding. */
  ai?: boolean;
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

    it('serves the ECB inflation series through the Hub and asks the ECB once per area, not per request', async () => {
      const before = stack.ecb.to('NL').length;
      const first = await call('GET', '/inflation', { query: { area: 'NL' } });
      expect(first.status).toBe(200);
      expect(first.body.series).toBe('ICP.M.NL.N.000000.4.ANR');
      const second = await call('GET', '/inflation', { query: { area: 'NL' } });
      expect(second.body.fetchedAt).toBe(first.body.fetchedAt);
      // at most the one request of the very first lookup (an earlier scenario of this suite may have made it already)
      expect(stack.ecb.to('NL').length - before).toBeLessThanOrEqual(1);
      expect(stack.ecb.requests.every((url) => url.startsWith('https://data-api.ecb.europa.eu/service/data/ICP/M.'))).toBe(true);
      expect((await call('GET', '/inflation', { query: { area: 'XX' } })).status).toBe(400);
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
      // The Worker answers 413 from the announced length without reading the body; workerd may reset the connection of a
      // client that is still sending it, which is the same refusal seen from the socket.
      const tooBig = await anonymous
        .request(path, { method: 'PUT', body: new Uint8Array(MAX_FILE_BYTES + 1), headers: { 'content-type': 'text/csv' } })
        .then((response) => response.status, () => 'connection reset');
      expect([413, 'connection reset']).toContain(tooBig);
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

  describe(`${label}: alarm diagnostics`, () => {
    let stack: Stack;
    let owner: Browser;
    beforeAll(async () => {
      stack = await start();
      owner = new Browser(stack);
      await owner.signIn();
    });
    afterAll(() => stack?.dispose());

    const report = async (): Promise<AlarmDiagnosticsReport> => {
      const response = await owner.request('/api/diagnostics/alarms?limit=20');
      expect(response.status).toBe(200);
      return alarmDiagnosticsSchema.parse(await response.json());
    };
    const waitForRun = async (deadline = Date.now() + 10_000): Promise<AlarmDiagnosticsReport> => {
      const current = await report();
      if (current.runs.some((run) => run.outcome !== null)) return current;
      if (Date.now() > deadline) throw new Error('No alarm run was recorded');
      await new Promise((resolve) => setTimeout(resolve, 50));
      return waitForRun(deadline);
    };

    it('is closed to everyone but the owner', async () => {
      expect((await new Browser(stack).request('/api/diagnostics/alarms')).status).toBe(401);
    });

    it('records what the alarm did: a started and finished run per invocation, no platform retry, and what is armed next', async () => {
      await stack.enqueue('refreshT212Quotes', { trigger: 'scheduled' });
      await stack.drain();
      const body = await waitForRun();
      const finished = body.runs.filter((run) => run.outcome !== null);
      expect(finished.length).toBeGreaterThan(0);
      for (const run of finished) {
        expect(run).toMatchObject({ unfinished: false, retryCount: 0, isRetry: false, error: null });
        expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
        expect(run.durationMs).toBe(run.finishedAt! - run.startedAt);
        expect(run.nextAlarmAt).not.toBeNull();
      }
      expect(finished.some((run) => run.jobs.some((job) => job.job === 'refreshT212Quotes'))).toBe(true);
      expect(body.summary).toMatchObject({ unfinished: 0, failed: 0, retries: 0 });
      expect(body.summary.runs).toBeGreaterThanOrEqual(finished.length);
      expect(body.armed.schedules.length).toBeGreaterThan(0);
      expect(body.armed.alarmAt).not.toBeNull();
      // The end-of-run `setAlarm` is on the run row; nothing else sets the alarm while a run is executing.
      expect(body.arms.filter((arm) => arm.runId !== null)).toEqual([]);
    });
  });

  describe(`${label}: price service`, () => {
    const keys = { TWELVEDATA_API_KEY: TD_KEY, ALPHAVANTAGE_API_KEY: AV_KEY, FX_HISTORY_START: '2026-01-01' };
    const buy = { date: '2026-01-05', type: 'BUY', symbol: 'AAPL', quantity: 2, price: 200, currency: 'USD' };

    async function signedIn(options?: SuiteStartOptions) {
      const stack = await start(options);
      const owner = new Browser(stack);
      await owner.signIn();
      const call = async (method: string, path: string, body?: unknown) => {
        const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      };
      const portfolio = (await call('POST', '/portfolios', { name: `Prices ${crypto.randomUUID().slice(0, 8)}` })).body.portfolioId as string;
      return { stack, owner, call, portfolio };
    }

    it('keeps the price schedules next to the broker sync and arms the alarm for them', async () => {
      const stack = await start({ prices: keys });
      try {
        expect(await stack.schedules()).toEqual(['broker-sync', 'broker-sync-intraday', 'notify-dividends', 'prices-calendar', 'prices-refresh', 't212-quotes', 't212-quotes-close']);
        const armed = await stack.alarmAt();
        expect(armed).not.toBeNull();
      } finally {
        await stack.dispose();
      }
    });

    it('enriches a new symbol, refreshes its price in an alarm step and serves it through the API', async () => {
      const { stack, call, portfolio } = await signedIn({ prices: keys });
      try {
        expect((await call('POST', '/transactions', { portfolioId: portfolio, ...buy })).status).toBe(201);
        await stack.drain(); // the enrichTransactions job published by the API
        expect(stack.prices.callsTo('www.alphavantage.co').length).toBeGreaterThan(0);

        await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.prices.callsTo('api.frankfurter.dev').length).toBeGreaterThan(0);
        const holdings = await call('GET', `/holdings?portfolioId=${portfolio}`);
        expect(holdings.body.holdings).toHaveLength(1);
        expect(holdings.body.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 2, priceLocal: AAPL_CLOSE, priceStale: false, name: 'Apple Inc.' });
        const summary = await call('GET', `/portfolio?portfolioId=${portfolio}`);
        expect(summary.body.totalValue).toBeGreaterThan(0);
        // No Twelve Data call in this test may carry the key anywhere but the Authorization header (the fake rejects it otherwise).
        expect(stack.prices.callsTo('api.twelvedata.com').length).toBeGreaterThan(0);
      } finally {
        await stack.dispose();
      }
    });

    it('stores the earnings dates of held companies (US, Xetra and Euronext listings) from one 12-month Alpha Vantage call and serves them, once a day', async () => {
      const { stack, call, portfolio } = await signedIn({ prices: keys });
      try {
        const listed = [
          { symbol: 'FOO.DE', name: 'Salesforce' },
          { symbol: 'ASML.AS', name: 'ASML Holding' },
        ];
        expect((await call('POST', '/transactions', { portfolioId: portfolio, ...buy })).status).toBe(201);
        const created = await Promise.all(listed.map(({ symbol }) => call('POST', '/transactions', { portfolioId: portfolio, ...buy, symbol, currency: 'EUR' })));
        expect(created.map((response) => response.status)).toEqual([201, 201]);
        await stack.drain();
        // The exchange-listed symbols have no price provider key here: their tracked marker and profile are what the price service would have stored.
        await stack.seed(
          listed.flatMap(({ symbol, name }) => [
            { PK: 'TRACKED', SK: `TICKER#${symbol}`, entityType: 'TRACKED_TICKER', symbol },
            { PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name, assetClass: 'STOCK', currency: 'EUR' },
          ]),
        );
        await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
        await stack.enqueue('refreshCalendar', { trigger: 'scheduled' });
        await stack.drain();
        // A second run later the same day (the pinned clock of the Node stack must move, a run's stamp is its budget token).
        stack.advance?.(60_000);
        await stack.enqueue('refreshCalendar', { trigger: 'scheduled' });
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.prices.calendarRequests).toEqual(['12month']);

        const calendar = await call('GET', `/calendar?portfolioId=${portfolio}&types=EARNINGS`);
        expect(calendar.status, JSON.stringify(calendar.body)).toBe(200);
        const earnings = calendar.body.events as { symbol: string; date: string; status: string; source: string; timeOfDay: string; earningsPhase: string }[];
        expect(earnings.map((event) => [event.symbol, event.date, event.status, event.source, event.earningsPhase])).toEqual(
          ['AAPL', 'ASML.AS', 'FOO.DE'].map((symbol) => [symbol, stack.prices.earningsDate(), 'ESTIMATED', 'alphavantage', 'scheduled']),
        );
        expect(earnings.find((event) => event.symbol === 'AAPL')?.timeOfDay).toBe('AMC');
      } finally {
        await stack.dispose();
      }
    });

    it('values a London ETF in pounds, not pence: pence history from the provider never reaches the portfolio history', async () => {
      const { stack, call, portfolio } = await signedIn({ prices: { ...keys, EODHD_API_KEY: EODHD_KEY } });
      try {
        const london = { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'SMGB.L', quantity: 10, price: 30, currency: 'GBP' };
        expect((await call('POST', '/transactions', london)).status).toBe(201);
        await stack.drain();
        await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.prices.callsTo('eodhd.com').length).toBeGreaterThan(0);

        const history = await call('GET', `/history?portfolioId=${portfolio}&range=ALL`);
        expect(history.status).toBe(200);
        const points = history.body.points as { date: string; value: number; invested: number }[];
        const last = points.at(-1)!;
        // 10 units at 30.40 pounds, in EUR at about 0.86 to 0.87 pounds per euro: about 350, a hundred times less than the pence reading.
        expect(last.value).toBeGreaterThan(340);
        expect(last.value).toBeLessThan(360);
        expect(Math.max(...points.map((point) => point.value))).toBeLessThan(400);
        expect(last.invested).toBeGreaterThan(340);
        expect(last.invested).toBeLessThan(360);
      } finally {
        await stack.dispose();
      }
    });

    it('fetches the history of a held symbol under the listing the owner chose, as soon as it is saved, and keeps the rows when it is cleared', async () => {
      const { stack, call, portfolio } = await signedIn({ prices: { ...keys, EODHD_API_KEY: EODHD_KEY } });
      try {
        const milan = { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'FWRA.MI', quantity: 3, price: 10, currency: 'EUR' };
        expect((await call('POST', '/transactions', milan)).status).toBe(201);
        await stack.drain(); // the provider does not know the Milan line: nothing is stored
        const coverage = async () => (await call('GET', '/prices/status')).body.history.symbols.find((row: { symbol: string }) => row.symbol === 'FWRA.MI');
        expect(await coverage()).toMatchObject({ eodRows: 0, historyOverride: null });

        const refused = await call('PUT', '/classification/FWRA.MI', { historySymbol: 'FWRA/DE' });
        expect(refused).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_ERROR' } } });
        const saved = await call('PUT', '/classification/FWRA.MI', { historySymbol: ' fwra.de ' });
        expect(saved).toMatchObject({ status: 200, body: { symbol: 'FWRA.MI', held: true, override: { historySymbol: 'FWRA.DE' } } });
        expect(await coverage()).toMatchObject({ historyOverride: { symbol: 'FWRA.DE', status: 'pending', reason: null } });

        await stack.drain(); // the enrichment the save queued
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.prices.calls.filter((entry) => entry.endsWith('/api/eod/FWRA.XETRA'))).toHaveLength(1);
        expect(await coverage()).toMatchObject({
          eodRows: XETRA_CLOSES.length,
          eodSources: ['eodhd:FWRA.DE'],
          proxyListing: 'FWRA.DE',
          historyOverride: { symbol: 'FWRA.DE', status: 'applied', reason: null },
          reason: 'History symbol set by you: FWRA.DE',
        });

        const cleared = await call('PUT', '/classification/FWRA.MI', { historySymbol: null });
        expect(cleared).toMatchObject({ status: 200, body: { override: null } });
        await stack.drain();
        expect(stack.prices.calls.filter((entry) => entry.endsWith('/api/eod/FWRA.XETRA'))).toHaveLength(1);
        expect(await coverage()).toMatchObject({ eodRows: XETRA_CLOSES.length, historyOverride: null });
      } finally {
        await stack.dispose();
      }
    });

    it('refuses a history symbol quoted in another currency than the holding and stores nothing from it', async () => {
      const { stack, call, portfolio } = await signedIn({ prices: { ...keys, EODHD_API_KEY: EODHD_KEY } });
      try {
        const acme = { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'ACME.MI', quantity: 3, price: 10, currency: 'EUR' };
        expect((await call('POST', '/transactions', acme)).status).toBe(201);
        await stack.drain();
        // a bare symbol is a US listing: Twelve Data answers in USD
        expect((await call('PUT', '/classification/ACME.MI', { historySymbol: 'ACME' })).status).toBe(200);
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        const row = (await call('GET', '/prices/status')).body.history.symbols.find((entry: { symbol: string }) => entry.symbol === 'ACME.MI');
        expect(row).toMatchObject({
          eodRows: 0,
          historyOverride: { symbol: 'ACME', status: 'refused', reason: 'history symbol is quoted in USD, the holding in EUR' },
          reason: 'History symbol set by you: ACME. Not used: history symbol is quoted in USD, the holding in EUR',
        });
      } finally {
        await stack.dispose();
      }
    });

    it('skips the price jobs (completed, never failed) from 60 % of a cap, and keeps the essential ones', async () => {
      const limits: MetricLimits = { ...METRIC_LIMITS, workerRequests: 40 };
      const { stack, owner } = await signedIn({ limits, prices: keys });
      try {
        const state = async () => usageSnapshotSchema.parse(await (await owner.request('/api/usage')).json()).state;
        for (let request = 0; request < 30 && (await state()) === 'ok'; request++) await owner.request('/api/portfolios');
        expect(await state()).toBe('warn');

        await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
        await stack.enqueue('refreshCalendar', { trigger: 'scheduled' });
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.prices.callsTo('api.twelvedata.com')).toEqual([]);
        expect(stack.prices.callsTo('api.frankfurter.dev')).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });

    it('degrades gracefully without provider keys: a clear status, jobs complete, the API keeps serving', async () => {
      const { stack, owner, call, portfolio } = await signedIn();
      try {
        const status = await call('GET', '/prices/status');
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({ state: 'no-keys', missingSecrets: ['TWELVEDATA_API_KEY', 'EODHD_API_KEY', 'COINGECKO_API_KEY', 'ALPHAVANTAGE_API_KEY'] });
        expect(status.body.message).toContain('No market-data API key is set');
        expect(status.body.t212Quotes).toBeNull();
        expect(status.body.history).toMatchObject({ symbols: [], totals: { held: 0, complete: 0, partial: 0, missing: 0, valuedAtCostSince: null, valuedAtCostUntil: null, truncated: false } });
        expect(JSON.stringify(status.body)).not.toContain(TD_KEY);
        expect((await new Browser(stack).request('/api/prices/status')).status).toBe(401);

        expect((await call('POST', '/transactions', { portfolioId: portfolio, ...buy })).status).toBe(201);
        await stack.drain();
        await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
        await stack.enqueue('refreshCalendar', { trigger: 'scheduled' });
        await stack.drain();

        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.prices.callsTo('api.twelvedata.com')).toEqual([]);
        expect(stack.prices.callsTo('www.alphavantage.co')).toEqual([]);
        const holdings = await call('GET', `/holdings?portfolioId=${portfolio}`);
        expect(holdings.status).toBe(200);
        expect(holdings.body.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 2, priceStale: true });
        const history = (await call('GET', '/prices/status')).body.history;
        expect(history.symbols).toHaveLength(1);
        expect(history.symbols[0]).toMatchObject({ symbol: 'AAPL', name: 'AAPL', provider: 'twelvedata', eodRows: 0, historyState: 'missing', reason: 'No provider key for this exchange', firstTransaction: '2026-01-05' });
        // The earnings dates section says why there is no date: the calendar job ran and found no Alpha Vantage key; a refresh would be pointless.
        await stack.seed([{ PK: 'TRACKED', SK: 'TICKER#AAPL', entityType: 'TRACKED_TICKER', symbol: 'AAPL', createdAt: '2020-01-01T00:00:00.000Z' }]);
        const dates = await call('GET', '/diagnostics/earnings-dates');
        expect(dates.status).toBe(200);
        expect(dates.body).toMatchObject({ held: 1, withDate: 0, lastRun: { status: 'no-provider', trigger: 'scheduled' }, lastSuccess: null, budget: { provider: 'Alpha Vantage', used: 0, limit: 25 }, refresh: { available: false } });
        expect(dates.body.symbols[0]).toMatchObject({ symbol: 'AAPL', next: null, reasonCode: 'no-provider' });
        const refresh = await call('POST', '/diagnostics/earnings-dates/refresh');
        expect(refresh.status).toBe(503);
        expect(refresh.body.error.code).toBe('NOT_CONFIGURED');
        expect((await new Browser(stack).request('/api/diagnostics/earnings-dates')).status).toBe(401);
        expect((await owner.request('/api/usage')).status).toBe(200);
      } finally {
        await stack.dispose();
      }
    });
  });

  describe(`${label}: Trading 212 position quotes`, () => {
    const userId = `github-${OWNER_ID}`;

    async function connected(options?: SuiteStartOptions) {
      const stack = await start(options);
      const owner = new Browser(stack);
      await owner.signIn();
      const call = async (method: string, path: string, body?: unknown) => {
        const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      };
      const portfolio = (await call('POST', '/portfolios', { name: `Quotes ${crypto.randomUUID().slice(0, 8)}` })).body.portfolioId as string;
      const credentials = { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' };
      expect((await call('PUT', '/brokers/trading212', credentials)).status).toBe(204);
      return { stack, owner, call, portfolio };
    }

    it('prices the held positions right after a sync, without any market-data key, in the base currency', async () => {
      const { stack, call, portfolio } = await connected();
      try {
        // The AAPL position is a manual transaction (USD): its value needs the stored ECB rate, which the keyless FX refresh provides.
        const buy = { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: 'AAPL', quantity: 2, price: 200, currency: 'USD' };
        expect((await call('POST', '/transactions', buy)).status).toBe(201);
        await stack.drain();
        await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
        await stack.drain();
        const before = (await call('GET', `/holdings?portfolioId=${portfolio}`)).body.holdings as { priceStale: boolean }[];
        expect(before.every((holding) => holding.priceStale)).toBe(true);

        const calls = stack.trading212.positionCalls();
        expect((await call('POST', '/brokers/trading212/sync', { portfolioId: portfolio })).status).toBe(202);
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.trading212.positionCalls() - calls).toBe(1);

        const holdings = (await call('GET', `/holdings?portfolioId=${portfolio}`)).body.holdings as { symbol: string; quantity: number; priceLocal: number; priceStale: boolean; marketValue: number }[];
        const bySymbol = Object.fromEntries(holdings.map((holding) => [holding.symbol, holding]));
        expect(bySymbol['SAP.DE']).toMatchObject({ quantity: 5, priceLocal: SAP_PRICE, priceStale: false });
        expect(bySymbol.AAPL).toMatchObject({ quantity: 2, priceLocal: AAPL_T212_PRICE, priceStale: false });
        // The same run stored a keyless baseline profile per held symbol: the broker's name, type and an ISIN-prefix country.
        const classes = (await call('GET', '/classification')).body.instruments as { symbol: string; source: string; effective: { name: string; assetClass: string; country: string }; isin: string }[];
        expect(classes.find((entry) => entry.symbol === 'SAP.DE')).toMatchObject({ source: 'trading212', isin: 'DE0007164600', effective: { name: 'SAP', assetClass: 'STOCK', country: 'Germany' } });
        expect(classes.find((entry) => entry.symbol === 'AAPL')).toMatchObject({ source: 'trading212', effective: { name: 'Apple', assetClass: 'STOCK', country: 'United States' } });
        expect(bySymbol['SAP.DE']).toMatchObject({ name: 'SAP', assetClass: 'STOCK', country: 'Germany' });
        const expected = 5 * SAP_PRICE + (2 * AAPL_T212_PRICE) / 1.16;
        const total = holdings.reduce((sum, holding) => sum + holding.marketValue, 0);
        expect(Math.abs(total - expected)).toBeLessThan(0.02);
        const summary = (await call('GET', `/portfolio?portfolioId=${portfolio}`)).body;
        expect(Math.abs(summary.totalValue - expected)).toBeLessThan(0.02);

        const status = (await call('GET', '/prices/status')).body;
        expect(status).toMatchObject({ state: 'no-keys', t212Quotes: { state: 'OK', quoted: 2, lastError: null } });
        expect(status.t212Quotes.lastSuccessAt).toEqual(expect.any(String));
        expect(status.sources.find((source: { name: string }) => source.name === 't212')).toMatchObject({ configured: true, secret: null });
        expect(status.message).toContain('held positions are priced from Trading 212');
        expect(JSON.stringify(status)).not.toContain(T212_SECRET);
      } finally {
        await stack.dispose();
      }
    });

    it.each([
      [401, 'AUTH_REJECTED'],
      [429, 'RATE_LIMITED'],
      [500, 'ERROR'],
    ])('records an answer of %i as %s, backs off, and neither fails the sync nor a job', async (status, state) => {
      const { stack, call, portfolio } = await connected();
      try {
        stack.trading212.positionsReply = { status, json: { message: 'no' } };
        expect((await call('POST', '/brokers/trading212/sync', { portfolioId: portfolio })).status).toBe(202);
        await stack.drain();
        expect(await stack.failedJobs()).toEqual([]);
        expect((await call('GET', `/brokers/trading212?portfolioId=${portfolio}`)).body).toMatchObject({ connected: true, status: 'SUCCEEDED' });
        expect(stack.trading212.positionCalls()).toBe(1);

        const report = (await call('GET', '/prices/status')).body.t212Quotes;
        expect(report).toMatchObject({ state, quoted: null });
        expect(report.nextAttemptAt).toEqual(expect.any(String));
        expect(report.lastError).not.toContain(T212_SECRET);

        // The next scheduled run stays away until the back-off is over: no request, no failed job.
        await stack.enqueue('refreshT212Quotes', { trigger: 'scheduled' });
        await stack.drain();
        expect(stack.trading212.positionCalls()).toBe(1);
        expect(await stack.failedJobs()).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });

    it('runs in the warning band (60-80 %) with one positions request, and is skipped, never deferred or failed, once blocked', async () => {
      const limits: MetricLimits = { ...METRIC_LIMITS, workerRequests: 40 };
      const { stack, owner, call } = await connected({ limits });
      try {
        const state = async () => usageSnapshotSchema.parse(await (await owner.request('/api/usage')).json()).state;
        for (let request = 0; request < 60 && (await state()) === 'ok'; request++) await owner.request('/api/portfolios');
        expect(await state()).toBe('warn');
        await stack.enqueue('refreshT212Quotes', { trigger: 'sync', userId });
        await stack.drain();
        expect(stack.trading212.positionCalls()).toBe(1);
        expect((await call('GET', '/prices/status')).body.t212Quotes).toMatchObject({ state: 'OK', quoted: 2 });

        for (let request = 0; request < 60 && (await state()) !== 'blocked'; request++) await owner.request('/api/portfolios');
        expect(await state()).toBe('blocked');
        await stack.enqueue('refreshT212Quotes', { trigger: 'sync', userId });
        await stack.drain();
        expect(stack.trading212.positionCalls()).toBe(1);
        expect(await stack.failedJobs()).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });
  });

  describe(`${label}: price history coverage and end-of-day rows`, () => {
    const userId = `github-${OWNER_ID}`;
    // The pinned clock of the budget tests (Monday 5 Jan 2026, 13:00 in Amsterdam): the day the rows get.
    const DAY = '2026-01-05';
    const settle = { ignoreJobs: ['enrichTransactions'] };
    const sap = { date: '2026-01-02', type: 'BUY', symbol: 'SAP.DE', quantity: 5, price: 200, currency: 'EUR' };
    const etf = { date: '2026-01-02', type: 'BUY', symbol: 'VWRL.AS', quantity: 1, price: 100, currency: 'EUR' };

    async function held(options?: SuiteStartOptions) {
      const stack = await start({ limits: METRIC_LIMITS, ...options });
      const owner = new Browser(stack);
      await owner.signIn();
      const call = async (method: string, path: string, body?: unknown) => {
        const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      };
      const portfolio = (await call('POST', '/portfolios', { name: `History ${crypto.randomUUID().slice(0, 8)}` })).body.portfolioId as string;
      expect((await call('PUT', '/brokers/trading212', { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' })).status).toBe(204);
      for (const transaction of [sap, etf]) expect((await call('POST', '/transactions', { portfolioId: portfolio, ...transaction })).status).toBe(201);
      const coverage = async () => (await call('GET', '/prices/status')).body.history;
      const close = async () => {
        await stack.enqueue('refreshT212Quotes', { trigger: 'close', userId });
        await stack.drain(settle);
      };
      return { stack, owner, call, portfolio, coverage, close };
    }

    it('lists the held symbols with why their history is missing, and tells the chart which ones are valued at cost', async () => {
      const { stack, call, coverage, portfolio } = await held();
      try {
        const history = await coverage();
        expect(history.totals).toEqual({ held: 2, complete: 0, partial: 0, missing: 2, valuedAtCostSince: '2026-01-02', valuedAtCostUntil: DAY, truncated: false });
        expect(history.symbols.map((row: { symbol: string }) => row.symbol)).toEqual(['SAP.DE', 'VWRL.AS']);
        expect(history.symbols[0]).toMatchObject({ provider: 'eodhd', eodRows: 0, firstEod: null, lastEod: null, eodSources: [], historyState: 'missing', reason: 'No provider key for this exchange' });
        const chart = (await call('GET', `/history?portfolioId=${portfolio}&range=ALL`)).body;
        expect(chart.valuedAtCost).toEqual({ symbols: ['SAP.DE', 'VWRL.AS'], held: 2, until: DAY });
        expect(JSON.stringify(history)).not.toContain(T212_SECRET);
      } finally {
        await stack.dispose();
      }
    });

    it('keeps the Trading 212 quote as the close of the day at the close run, and the chart then ends at the headline total', async () => {
      const { stack, call, coverage, close, portfolio } = await held();
      try {
        await close();
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.trading212.positionCalls()).toBe(1);

        const history = await coverage();
        const bySymbol = Object.fromEntries(history.symbols.map((row: { symbol: string }) => [row.symbol, row]));
        expect(bySymbol['SAP.DE']).toMatchObject({ eodRows: 1, firstEod: DAY, lastEod: DAY, eodSources: ['t212'], lastQuoteSource: 't212', historyState: 'complete', reason: 'Full history stored' });
        expect(bySymbol['VWRL.AS']).toMatchObject({ eodRows: 0, historyState: 'missing' });
        expect(history.totals).toMatchObject({ held: 2, complete: 1, missing: 1, valuedAtCostSince: '2026-01-02' });

        const summary = (await call('GET', `/portfolio?portfolioId=${portfolio}`)).body;
        const chart = (await call('GET', `/history?portfolioId=${portfolio}&range=ALL`)).body;
        expect(summary.totalValue).toBeCloseTo(5 * SAP_PRICE + 100, 2);
        expect(chart.points.at(-1).value).toBeCloseTo(summary.totalValue, 2);
        // SAP.DE has a close from the 5th on: it is still valued at cost on the 2nd to the 4th
        expect(chart.valuedAtCost).toEqual({ symbols: ['SAP.DE', 'VWRL.AS'], held: 2, until: DAY });
        // the stored row is a close like any other: the asset's own history serves it
        const asset = (await call('GET', '/assets/SAP.DE/history?range=1M')).body;
        expect(JSON.stringify(asset)).toContain(String(SAP_PRICE));
      } finally {
        await stack.dispose();
      }
    });

    it('writes the row once: a second run of the same day makes no new request and no second row', async () => {
      const { stack, coverage, close } = await held();
      try {
        await close();
        await close();
        expect(stack.trading212.positionCalls()).toBe(1);
        const row = (await coverage()).symbols.find((entry: { symbol: string }) => entry.symbol === 'SAP.DE');
        expect(row).toMatchObject({ eodRows: 1, eodSources: ['t212'] });
        expect(await stack.failedJobs()).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });

    it('never replaces the close of a market-data provider', async () => {
      const { stack, coverage, close } = await held();
      try {
        await stack.seed([{ PK: 'TICKER#SAP.DE', SK: `EOD#${DAY}`, entityType: 'EOD', symbol: 'SAP.DE', date: DAY, close: 150, currency: 'EUR' }]);
        await close();
        const row = (await coverage()).symbols.find((entry: { symbol: string }) => entry.symbol === 'SAP.DE');
        expect(row).toMatchObject({ eodRows: 1, eodSources: ['provider'], lastQuoteSource: 't212' });
      } finally {
        await stack.dispose();
      }
    });

    it('reports a history taken from another listing of the same fund, and the chart reconciliation lists every held symbol', async () => {
      const { stack, call, coverage, close } = await held();
      try {
        await close();
        const rows = ['2026-01-02', '2026-01-03'].map((date) => ({ PK: 'TICKER#VWRL.AS', SK: `EOD#${date}`, entityType: 'EOD', symbol: 'VWRL.AS', date, close: 101, currency: 'EUR', source: 'eodhd:VWRL.DE' }));
        await stack.seed(rows);
        const proxied = (await coverage()).symbols.find((entry: { symbol: string }) => entry.symbol === 'VWRL.AS');
        expect(proxied).toMatchObject({ eodRows: 2, eodSources: ['eodhd:VWRL.DE'], proxyListing: 'VWRL.DE', historyState: 'complete' });
        expect(proxied.reason).toBe('History from another listing of the same fund (XETRA); prices can differ by a few tenths of a percent');

        const report = await call('GET', '/diagnostics/valuation?dates=2026-01-03');
        expect(report.status).toBe(200);
        const [day] = report.body.days;
        expect(day.date).toBe('2026-01-03');
        expect(day.lines.map((line: { symbol: string }) => line.symbol).sort()).toEqual(['SAP.DE', 'VWRL.AS']);
        expect(day.lines.find((line: { symbol: string }) => line.symbol === 'VWRL.AS')).toMatchObject({ source: 'close', priceDate: '2026-01-03', price: 101 });
        expect(day.lines.find((line: { symbol: string }) => line.symbol === 'SAP.DE')).toMatchObject({ source: 'cost' });
        expect(day.chartValue).toBeCloseTo(day.positionsValue + day.extraValue, 2);
        expect(report.body.symbolsTotal).toBe(2);
        expect(JSON.stringify(report.body)).not.toContain(T212_SECRET);
        expect((await call('GET', '/diagnostics/valuation?dates=nonsense')).status).toBe(400);
      } finally {
        await stack.dispose();
      }
    });

    it('serves the chart reconciliation to the signed-in owner only', async () => {
      const stack = await start({ limits: METRIC_LIMITS });
      try {
        const anonymous = await new Browser(stack).request('/api/diagnostics/valuation');
        expect(anonymous.status).toBe(401);
        const owner = new Browser(stack);
        await owner.signIn();
        const empty = await owner.request('/api/diagnostics/valuation');
        expect(empty.status).toBe(200);
        expect(await empty.json()).toMatchObject({ days: [], symbolsTotal: 0 });
      } finally {
        await stack.dispose();
      }
    });

    it('is dropped with the quote refresh once the budget is blocked: no request, no row, no failed job', async () => {
      const limits: MetricLimits = { ...METRIC_LIMITS, workerRequests: 40 };
      const stack = await start({ limits });
      try {
        const owner = new Browser(stack);
        await owner.signIn();
        const portfolio = (await (await owner.request('/api/portfolios', { method: 'POST', body: { name: `Blocked ${crypto.randomUUID().slice(0, 8)}` } })).json()).portfolioId as string;
        const credentials = { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' };
        expect((await owner.request('/api/brokers/trading212', { method: 'PUT', body: credentials })).status).toBe(204);
        const state = async () => usageSnapshotSchema.parse(await (await owner.request('/api/usage')).json()).state;
        for (let request = 0; request < 80 && (await state()) !== 'blocked'; request++) await owner.request('/api/portfolios');
        expect(await state()).toBe('blocked');
        await stack.enqueue('refreshT212Quotes', { trigger: 'close', userId });
        await stack.drain(settle);
        expect(stack.trading212.positionCalls()).toBe(0);
        expect(await stack.failedJobs()).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });
  });

  describe(`${label}: dividend notifications`, () => {
    async function ownerOf(options?: SuiteStartOptions) {
      const stack = await start(options);
      const owner = new Browser(stack);
      await owner.signIn();
      const call = async (method: string, path: string, requestBody?: unknown) => {
        const response = await owner.request(`/api${path}`, { method, ...(requestBody === undefined ? {} : { body: requestBody }) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      };
      return { stack, call };
    }

    const settle = { ignoreJobs: ['enrichTransactions'] };

    const dividend = (reference: string) => ({
      reference,
      ticker: 'SAPd_EQ',
      instrument: { ticker: 'SAPd_EQ', isin: 'DE0007164600', name: 'SAP', currency: 'EUR' },
      quantity: 5,
      amount: 6,
      grossAmountPerShare: 1.4,
      currency: 'EUR',
      tickerCurrency: 'EUR',
      paidOn: '2026-01-05T09:30:00Z',
      type: 'ORDINARY',
    });

    it('keeps the intraday sync and the daily notification run next to the daily ones and arms the alarm for them', async () => {
      const { stack } = await ownerOf();
      try {
        expect(await stack.schedules()).toEqual(expect.arrayContaining(['broker-sync', 'broker-sync-intraday', 'notify-dividends']));
        expect(await stack.alarmAt()).not.toBeNull();
      } finally {
        await stack.dispose();
      }
    });

    it('announces a dividend the sync booked, end-to-end encrypted to the device, once, and drops a device the push service reports gone', async () => {
      // The pinned Hub clock is 13:00 Amsterdam time on 5 January 2026: outside quiet hours. Enrichment of the new symbol may stay pending (a frozen clock never brings a deferred job back).
      const { stack, call } = await ownerOf({ limits: METRIC_LIMITS });
      try {
        const portfolio = (await call('POST', '/portfolios', { name: `Notify ${crypto.randomUUID().slice(0, 8)}` })).body.portfolioId as string;
        expect((await call('PUT', '/brokers/trading212', { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' })).status).toBe(204);
        const sync = async () => {
          expect((await call('POST', '/brokers/trading212/sync', { portfolioId: portfolio })).status).toBe(202);
          await stack.drain(settle);
        };
        await sync();

        // Enabling on this device: nothing that already exists is announced.
        const device = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/device-${crypto.randomUUID()}`);
        const { endpoint } = device.subscription;
        expect((await call('POST', '/notifications/subscriptions', { ...device.subscription, label: 'Test phone' })).status).toBe(201);
        await stack.enqueue('notifyDividends', { trigger: 'scheduled' });
        await stack.drain(settle);
        expect(stack.push.to(endpoint)).toEqual([]);

        // A dividend is booked by the next sync and announced right away.
        stack.trading212.dividends = [dividend('div-1')];
        await sync();
        const messages = stack.push.to(endpoint);
        expect(messages).toHaveLength(1);
        const [message] = messages;
        const { claims, publicKey } = await verifyVapidAuthorization(message!.authorization ?? '');
        expect([claims.aud, claims.sub, publicKey]).toEqual(['https://fcm.googleapis.com', stack.origin, TEST_VAPID.publicKey]);
        expect(message!.contentEncoding).toBe('aes128gcm');
        const payload = await device.decrypt(message!.body);
        expect(payload).toMatchObject({ type: 'received', symbol: 'SAP.DE', url: '/assets/SAP.DE' });
        expect(String(payload.title)).toMatch(/dividend received: EUR 6\.00$/);
        expect(payload.body).toBe('€1.40 per share');
        expect(JSON.stringify(payload)).not.toContain('fcm.googleapis.com');

        // The same sync again, and a scheduled run, announce nothing twice.
        await sync();
        await stack.enqueue('notifyDividends', { trigger: 'scheduled' });
        await stack.drain(settle);
        expect(stack.push.to(endpoint)).toHaveLength(1);

        // The push service forgets the device: the next announcement removes it.
        stack.push.answers.set(endpoint, 410);
        stack.trading212.dividends = [dividend('div-1'), dividend('div-2')];
        await sync();
        expect(stack.push.to(endpoint)).toHaveLength(2);
        expect((await call('GET', '/notifications')).body.devices).toEqual([]);
        expect(await stack.failedJobs()).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });

    it('is switched off, not broken, without VAPID keys: the API says so, a notification run completes and nothing is sent', async () => {
      const { stack, call } = await ownerOf({ noVapid: true });
      try {
        const state = await call('GET', '/notifications');
        expect(state.body).toMatchObject({ available: true, configured: false });
        expect(state.body.publicKey).toBeUndefined();
        const device = await createTestSubscriber();
        expect((await call('POST', '/notifications/subscriptions', device.subscription)).body.error.code).toBe('PUSH_NOT_CONFIGURED');
        await stack.enqueue('notifyDividends', { trigger: 'scheduled' });
        await stack.drain(settle);
        expect(await stack.failedJobs()).toEqual([]);
        expect(stack.push.received).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });
  });
}
