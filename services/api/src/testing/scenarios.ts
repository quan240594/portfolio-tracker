import { createTestSubscriber } from '@portfolio/platform/testing';
import { MAX_PUSH_DEVICES, drain, sequentially } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';

export interface ScenarioResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scenarios read response bodies of many shapes
  body: any;
  /** Response headers when the target exposes them (lower-case names). */
  headers?: Record<string, string>;
}

export type ScenarioCall = (method: string, path: string, options?: { query?: Record<string, string>; body?: unknown }) => Promise<ScenarioResponse>;

export interface ApiScenarioTarget {
  /** Calls the API as the signed-in user of the platform under test. */
  call: ScenarioCall;
  /**
   * Delivers a CSV to the upload target of `POST /imports` and waits until the platform has processed it (S3 event + SQS
   * on AWS, the upload route + alarm on Cloudflare). Omit it for a target that has no ingestion pipeline: the CSV
   * scenario is then skipped.
   */
  importCsv?: (created: { importId: string; uploadUrl: string }, csv: string) => Promise<void>;
}

const unique = (prefix: string): string => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;

const BUY = { date: '2026-01-05', type: 'BUY', symbol: 'SAP.DE', quantity: 10, price: 100, currency: 'EUR' } as const;

/**
 * The platform-neutral API scenarios: what a signed-in user can do, through the HTTP contract only. The same suite runs
 * on the in-memory dependencies (`services/api`), against LocalStack (`api.int.test.ts`) and against the Cloudflare
 * Worker + Durable Object (`packages/cloudflare-app`), which is how "a feature is done when it works on every adapter"
 * is enforced. Each scenario creates its own portfolio (unique name), so they run in any order on a shared backend.
 */
export function defineApiScenarios(label: string, target: ApiScenarioTarget): void {
  const { call } = target;

  async function createPortfolio(name = unique('Scenario')): Promise<string> {
    const created = await call('POST', '/portfolios', { body: { name } });
    expect(created.status).toBe(201);
    return created.body.portfolioId as string;
  }

  describe(`API scenarios: ${label}`, () => {
    it('answers the health check', async () => {
      const health = await call('GET', '/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });

    it('answers unknown routes with the error envelope', async () => {
      const missing = await call('GET', '/definitely-not-a-route');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');
    });

    it('creates, renames and force-deletes a portfolio with its transactions', async () => {
      const before = (await call('GET', '/portfolios')).body.portfolios.length as number;
      const name = unique('Scratch');
      const created = await call('POST', '/portfolios', { body: { name } });
      expect(created.status).toBe(201);
      const id = created.body.portfolioId as string;
      expect((await call('POST', '/portfolios', { body: { name: name.toLowerCase() } })).status).toBe(409);
      const renamed = await call('PATCH', `/portfolios/${id}`, { body: { name: `${name} 2` } });
      expect(renamed.body.name).toBe(`${name} 2`);
      const txn = await call('POST', '/transactions', { body: { portfolioId: id, ...BUY } });
      expect(txn.status).toBe(201);
      expect((await call('DELETE', `/portfolios/${id}`)).body.error.code).toBe('PORTFOLIO_NOT_EMPTY');
      expect((await call('DELETE', `/portfolios/${id}`, { query: { force: 'true' } })).status).toBe(204);
      expect((await call('DELETE', `/transactions/${txn.body.id}`)).status).toBe(404);
      expect((await call('GET', '/portfolios')).body.portfolios).toHaveLength(before);
    });

    it('validates input before storing anything', async () => {
      const id = await createPortfolio();
      expect((await call('POST', '/portfolios', { body: {} })).status).toBe(400);
      expect((await call('POST', '/transactions', { body: { portfolioId: id, ...BUY, quantity: -1 } })).status).toBe(400);
      expect((await call('POST', '/transactions', { body: { portfolioId: 'does-not-exist', ...BUY } })).status).toBe(404);
      expect((await call('GET', '/transactions', { query: { portfolioId: id } })).body.transactions).toEqual([]);
    });

    it('creates and deletes a transaction, and refuses to oversell', async () => {
      const id = await createPortfolio();
      const created = await call('POST', '/transactions', { body: { portfolioId: id, ...BUY } });
      expect(created.status).toBe(201);
      const oversell = await call('POST', '/transactions', { body: { portfolioId: id, ...BUY, date: '2026-01-06', type: 'SELL', quantity: 11 } });
      expect(oversell.status).toBe(422);
      expect((await call('DELETE', `/transactions/${created.body.id}`)).status).toBe(204);
      expect((await call('DELETE', `/transactions/${created.body.id}`)).status).toBe(404);
    });

    it('derives holdings, allocation, history, dividends and analytics from the transactions it stored', async () => {
      const id = await createPortfolio();
      await call('POST', '/transactions', { body: { portfolioId: id, ...BUY } });
      await call('POST', '/transactions', { body: { portfolioId: id, date: '2026-02-10', type: 'DIVIDEND', symbol: 'SAP.DE', quantity: 10, price: 2.5, currency: 'EUR' } });
      const scope = { portfolioId: id };

      const listed = await call('GET', '/transactions', { query: scope });
      expect(listed.body.transactions.map((t: { type: string }) => t.type)).toEqual(['DIVIDEND', 'BUY']);
      const holdings = await call('GET', '/holdings', { query: scope });
      expect(holdings.status).toBe(200);
      expect(holdings.body.holdings.map((h: { symbol: string; quantity: number }) => [h.symbol, h.quantity])).toEqual([['SAP.DE', 10]]);
      const summary = await call('GET', '/portfolio', { query: scope });
      expect(summary.body).toMatchObject({ baseCurrency: 'EUR', holdingsCount: 1 });
      const allocation = await call('GET', '/allocation', { query: { ...scope, by: 'currency' } });
      expect(allocation.status).toBe(200);
      expect(allocation.body.slices.map((s: { key: string }) => s.key)).toEqual(['EUR']);
      const history = await call('GET', '/history', { query: { ...scope, range: 'ALL' } });
      expect(history.status).toBe(200);
      expect(Array.isArray(history.body.points)).toBe(true);
      const dividends = await call('GET', '/dividends', { query: scope });
      expect(dividends.status).toBe(200);
      expect(dividends.body.received.length).toBeGreaterThan(0);
      expect((await call('GET', '/analytics/summary', { query: scope })).status).toBe(200);
      expect((await call('GET', '/calendar', { query: scope })).status).toBe(200);
    });

    it('overrides the classification of a held symbol and previews an import of a classification file', async () => {
      const id = await createPortfolio();
      expect((await call('POST', '/transactions', { body: { portfolioId: id, ...BUY } })).status).toBe(201);
      const symbol = BUY.symbol;
      const put = await call('PUT', `/classification/${symbol}`, { body: { name: 'Scenario name', sector: 'Scenario sector' } });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ symbol, held: true, effective: { name: 'Scenario name', sector: 'Scenario sector' }, override: { name: 'Scenario name', sector: 'Scenario sector' } });
      const holding = (await call('GET', '/holdings', { query: { portfolioId: id } })).body.holdings[0];
      expect(holding).toMatchObject({ symbol, sector: 'Scenario sector' });
      const list = await call('GET', '/classification');
      expect(list.body.instruments.find((i: { symbol: string }) => i.symbol === symbol)).toMatchObject({ held: true, override: { name: 'Scenario name' } });
      const preview = await call('POST', '/classification/import', { body: { dryRun: true, rows: [{ ticker: 'SAP', country: 'Germany' }, { ticker: 'NOPE-NOT-HELD', sector: 'x' }] } });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ dryRun: true, applied: 0, matched: [{ symbol }], unmatched: [{ ticker: 'NOPE-NOT-HELD', reason: 'not-held' }] });
      expect((await call('POST', '/classification/import', { body: { rows: [] } })).status).toBe(400);
      expect((await call('DELETE', `/classification/${symbol}`)).status).toBe(204);
      const after = await call('GET', '/classification');
      expect(after.body.instruments.find((i: { symbol: string }) => i.symbol === symbol)).toMatchObject({ override: null });
      expect((await call('DELETE', `/portfolios/${id}`, { query: { force: 'true' } })).status).toBe(204);
    });

    it('manages dividend notifications: settings, devices and a test push, or reports the feature unavailable', async () => {
      const state = await call('GET', '/notifications');
      expect(state.status).toBe(200);
      if (!state.body.available) {
        // A deployment without a push sender (the AWS demo): the web app hides the feature.
        expect(state.body).toMatchObject({ available: false, configured: false, devices: [] });
        expect((await call('PUT', '/notifications/settings', { body: {} })).status).toBe(404);
        expect((await call('POST', '/notifications/test')).status).toBe(404);
        return;
      }
      expect(state.body.settings).toMatchObject({ types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 });
      expect(state.body.maxDevices).toBe(MAX_PUSH_DEVICES);
      if (!state.body.configured) {
        const unsigned = await call('POST', '/notifications/subscriptions', { body: {} });
        expect(unsigned.status).toBe(503);
        expect(unsigned.body.error.code).toBe('PUSH_NOT_CONFIGURED');
        return;
      }
      expect(state.body.publicKey).toMatch(/^[\w-]{87}$/);

      // Settings: partial updates, validated.
      const updated = await call('PUT', '/notifications/settings', { body: { types: { received: false }, exDividendDaysBefore: 4 } });
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ types: { exDividend: true, declared: true, received: false }, exDividendDaysBefore: 4 });
      expect((await call('GET', '/notifications')).body.settings).toEqual(updated.body);
      const invalidSettings = [{ exDividendDaysBefore: 9 }, { types: { other: true } }, { quietHours: false }];
      expect(await Promise.all(invalidSettings.map(async (bad) => (await call('PUT', '/notifications/settings', { body: bad })).status))).toEqual([400, 400, 400]);

      // Devices: the endpoint must be a real push service, the keys real keys.
      const subscriber = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/scenario-${crypto.randomUUID()}`);
      const { endpoint, keys } = subscriber.subscription;
      const refusedEndpoints = [['http', 'fcm.googleapis.com/fcm/send/x'].join('://'), 'https://example.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com@example.com/x'];
      const refusals = await Promise.all(refusedEndpoints.map(async (refused) => (await call('POST', '/notifications/subscriptions', { body: { endpoint: refused, keys } })).status));
      expect(refusals).toEqual([400, 400, 400, 400]);
      expect((await call('POST', '/notifications/subscriptions', { body: { endpoint, keys: { p256dh: 'x', auth: 'y' } } })).status).toBe(400);
      const created = await call('POST', '/notifications/subscriptions', { body: { endpoint, keys, label: ' Scenario phone ' } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ created: true, device: { label: 'Scenario phone', service: 'fcm.googleapis.com', failures: 0 } });
      const deviceId = created.body.device.id as string;
      expect(JSON.stringify(created.body)).not.toContain(keys.auth);
      const again = await call('POST', '/notifications/subscriptions', { body: { endpoint, keys, label: 'Scenario phone' } });
      expect([again.status, again.body.created, again.body.device.id]).toEqual([200, false, deviceId]);
      const listed = (await call('GET', '/notifications')).body.devices as { id: string }[];
      expect(listed.filter((device) => device.id === deviceId)).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain('scenario-');

      // A test push reaches the device (the platform's push service answers 201).
      const test = await call('POST', '/notifications/test', { body: { subscriptionId: deviceId } });
      expect(test.status).toBe(200);
      expect(test.body.results).toEqual([{ id: deviceId, label: 'Scenario phone', result: 'ok', removed: false }]);
      expect((await call('POST', '/notifications/test', { body: { subscriptionId: 'f'.repeat(32) } })).status).toBe(404);
      expect((await call('POST', '/notifications/test', { body: { subscriptionId: 'nope' } })).status).toBe(400);

      // At most ten devices.
      const extra: string[] = [];
      await drain(
        sequentially(Array.from({ length: MAX_PUSH_DEVICES }, (_unused, index) => index), async (index) => {
          const other = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/scenario-extra-${index}-${crypto.randomUUID()}`);
          const response = await call('POST', '/notifications/subscriptions', { body: other.subscription });
          if (response.status === 201) extra.push(response.body.device.id as string);
          else expect(response.body.error.code).toBe('TOO_MANY_DEVICES');
        }),
      );
      expect(extra.length).toBeLessThanOrEqual(MAX_PUSH_DEVICES - 1);
      expect((await call('GET', '/notifications')).body.devices).toHaveLength(MAX_PUSH_DEVICES);
      const overflow = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/scenario-over-${crypto.randomUUID()}`);
      expect((await call('POST', '/notifications/subscriptions', { body: overflow.subscription })).status).toBe(409);

      // Clean up: remove every device, then the removal is not repeatable.
      await drain(sequentially([deviceId, ...extra], async (id) => expect((await call('DELETE', `/notifications/subscriptions/${id}`)).status).toBe(204)));
      expect((await call('DELETE', `/notifications/subscriptions/${deviceId}`)).status).toBe(404);
      expect((await call('DELETE', '/notifications/subscriptions/not-an-id')).status).toBe(400);
      expect((await call('GET', '/notifications')).body.devices).toEqual([]);
      expect((await call('POST', '/notifications/test')).status).toBe(409);
      expect((await call('PUT', '/notifications/settings', { body: { types: { received: true }, exDividendDaysBefore: 2 } })).status).toBe(200);
    });

    it.skipIf(target.importCsv === undefined)('imports a CSV: upload target, processing, status and transactions', async () => {
      const id = await createPortfolio();
      const created = await call('POST', '/imports', { body: { fileName: 'trades.csv', portfolioId: id } });
      expect(created.status).toBe(201);
      expect(await call('GET', `/imports/${created.body.importId}`)).toMatchObject({ status: 200, body: { status: 'PENDING', portfolioId: id } });
      const csv = 'date,type,symbol,quantity,price,fee,currency\n2026-01-02,BUY,SAP.DE,2,200,1,EUR\n2026-01-03,BUY,SAP.DE,1,210,0,EUR\n';
      await target.importCsv!(created.body as { importId: string; uploadUrl: string }, csv);
      const status = await call('GET', `/imports/${created.body.importId}`);
      expect(status.body).toMatchObject({ status: 'COMPLETED', rowCount: 2, importedCount: 2 });
      const transactions = await call('GET', '/transactions', { query: { portfolioId: id } });
      expect(transactions.body.transactions).toHaveLength(2);
      const holdings = await call('GET', '/holdings', { query: { portfolioId: id } });
      expect(holdings.body.holdings.map((h: { quantity: number }) => h.quantity)).toEqual([3]);
    });
  });
}
