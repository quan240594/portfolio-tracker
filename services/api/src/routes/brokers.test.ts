import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MemoryJobQueue } from '@portfolio/platform';
import { BrokerError, MemoryBrokerStore, type CredentialStore } from '@portfolio/broker-sync';
import type { BrokerSyncState, Trading212Credentials } from '@portfolio/shared';
import { createHandler } from '../lambda/handler.js';
import type { BrokerDeps } from '../broker-deps.js';
import { apiEvent, fakeDeps, portfolio } from '../testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const SECRET = 'super-secret-value';
const credentials = (over: Partial<Trading212Credentials> = {}) => ({ apiKey: 'key-123', apiSecret: SECRET, environment: 'live', ...over });

class FakeCredentials implements Pick<CredentialStore, 'put' | 'delete'> {
  readonly stored = new Map<string, Trading212Credentials>();
  put(userId: string, c: Trading212Credentials) {
    this.stored.set(userId, c);
    return Promise.resolve();
  }
  delete(userId: string) {
    this.stored.delete(userId);
    return Promise.resolve();
  }
}

function setup(opts: { verify?: BrokerDeps['verify'] } = {}) {
  const store = new MemoryBrokerStore();
  const secrets = new FakeCredentials();
  const jobs = new MemoryJobQueue();
  const verify = vi.fn(opts.verify ?? (() => Promise.resolve({ accountCurrency: 'EUR' })));
  const broker: BrokerDeps = { store, credentials: secrets, verify, jobs };
  const ctx = fakeDeps({ broker });
  ctx.repo.portfolios = [
    portfolio({ portfolioId: 'trading-212', name: 'Trading 212' }),
    portfolio({ portfolioId: 'other', name: 'Other' }),
  ];
  return { ...ctx, store, secrets, jobs, verify, handler: createHandler(() => ctx.deps) };
}

const connectBody = (over: Record<string, unknown> = {}) => ({ portfolioId: 'trading-212', ...credentials(), ...over });

describe('PUT /brokers/trading212', () => {
  it('verifies the key, stores it for the caller and records the connection (204, empty body)', async () => {
    const { handler, store, secrets, verify } = setup();
    const res = await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody({ environment: 'demo' }) }));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(verify).toHaveBeenCalledWith({ apiKey: 'key-123', apiSecret: SECRET, environment: 'demo' });
    expect(secrets.stored.get('demo')).toEqual({ apiKey: 'key-123', apiSecret: SECRET, environment: 'demo' });
    expect(await store.getState('demo', 'trading-212')).toMatchObject({
      userId: 'demo',
      portfolioId: 'trading-212',
      broker: 'trading212',
      environment: 'demo',
      status: 'CONNECTED',
      accountCurrency: 'EUR',
      connectedAt: '2026-06-15T12:00:00.000Z',
    });
  });

  it('keys the secret and state by the authenticated user, never by the body', async () => {
    const { handler, store, secrets, repo } = setup();
    repo.portfolios.push(portfolio({ portfolioId: 'trading-212', userId: 'alice', name: 'Trading 212' }));
    const res = await handler(apiEvent('PUT', '/brokers/trading212', { sub: 'alice', body: connectBody({ userId: 'mallory' }) }));
    expect(res.statusCode).toBe(204);
    expect([...secrets.stored.keys()]).toEqual(['alice']);
    expect(await store.getState('alice', 'trading-212')).not.toBeNull();
    expect(await store.getState('mallory', 'trading-212')).toBeNull();
  });

  it('never echoes the secret, also not in errors', async () => {
    const { handler } = setup();
    const ok = await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    const bad = await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody({ portfolioId: '' }) }));
    expect(JSON.stringify([ok, bad])).not.toContain(SECRET);
  });

  it('maps Trading 212 auth rejection to 422 T212_AUTH_REJECTED and stores nothing', async () => {
    const { handler, store, secrets } = setup({
      verify: () => Promise.reject(new BrokerError('T212_AUTH_REJECTED', 'Trading 212 rejected the credentials.', 401)),
    });
    const res = await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toEqual({ code: 'T212_AUTH_REJECTED', message: 'Trading 212 rejected the credentials.' });
    expect(secrets.stored.size).toBe(0);
    expect(await store.getState('demo', 'trading-212')).toBeNull();
  });

  it.each([
    ['T212_RATE_LIMITED', 429],
    ['T212_NETWORK', 502],
  ] as const)('maps %s to %i', async (code, status) => {
    const { handler } = setup({ verify: () => Promise.reject(new BrokerError(code, 'x')) });
    expect((await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }))).statusCode).toBe(status);
  });

  it('lets unexpected verification failures surface as 500', async () => {
    const { handler } = setup({ verify: () => Promise.reject(new Error('boom')) });
    expect((await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }))).statusCode).toBe(500);
  });

  it('validates the body', async () => {
    const { handler } = setup();
    for (const body of [{}, connectBody({ apiKey: '' }), connectBody({ environment: 'moon' }), 'not json']) {
      expect((await handler(apiEvent('PUT', '/brokers/trading212', { body }))).statusCode).toBe(400);
    }
  });

  it('404s for an unknown portfolio', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody({ portfolioId: 'nope' }) }))).statusCode).toBe(404);
  });

  it('refuses a second portfolio while another one is connected (one credential set per user)', async () => {
    const { handler } = setup();
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    const res = await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody({ portfolioId: 'other' }) }));
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('BROKER_ALREADY_CONNECTED');
  });

  it('reconnecting keeps the sync history, clears the error and re-arms a FAILED state', async () => {
    const { handler, store } = setup();
    const previous: BrokerSyncState = {
      userId: 'demo',
      portfolioId: 'trading-212',
      broker: 'trading212',
      environment: 'live',
      status: 'FAILED',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastSuccessAt: '2026-01-02T00:00:00.000Z',
      cursors: { orders: '2026-01-02T00:00:00.000Z' },
      lastError: 'T212_AUTH_REJECTED: nope',
    };
    await store.createState(previous);
    expect((await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }))).statusCode).toBe(204);
    const state = await store.getState('demo', 'trading-212');
    expect(state).toMatchObject({ status: 'CONNECTED', connectedAt: previous.connectedAt, cursors: previous.cursors, lastSuccessAt: previous.lastSuccessAt });
    expect(state).not.toHaveProperty('lastError');
  });

  it('keeps a healthy status when reconnecting', async () => {
    const { handler, store } = setup();
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    const connected = (await store.getState('demo', 'trading-212'))!;
    await store.saveState({ ...connected, status: 'SUCCEEDED' });
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    expect((await store.getState('demo', 'trading-212'))!.status).toBe('SUCCEEDED');
  });

  it('answers 503 when the sync is not configured', async () => {
    const ctx = fakeDeps();
    const res = await createHandler(() => ctx.deps)(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.code).toBe('BROKER_UNAVAILABLE');
  });
});

describe('GET /brokers/trading212', () => {
  it('reports not connected', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/brokers/trading212', { query: { portfolioId: 'trading-212' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ broker: 'trading212', portfolioId: 'trading-212', connected: false });
  });

  it('returns the status without internal fields or secrets', async () => {
    const { handler } = setup();
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    const res = await handler(apiEvent('GET', '/brokers/trading212', { query: { portfolioId: 'trading-212' } }));
    const body = json(res);
    expect(body).toMatchObject({ connected: true, status: 'CONNECTED', environment: 'live', accountCurrency: 'EUR' });
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('cursors');
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('key-123');
  });

  it("does not expose another user's connection", async () => {
    const { handler } = setup();
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    const res = await handler(apiEvent('GET', '/brokers/trading212', { sub: 'alice', query: { portfolioId: 'trading-212' } }));
    expect(json(res).connected).toBe(false);
  });

  it('requires a valid portfolioId', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('GET', '/brokers/trading212'))).statusCode).toBe(400);
  });
});

describe('POST /brokers/trading212/sync', () => {
  it('starts an asynchronous sync for the caller (202)', async () => {
    const { handler, jobs } = setup();
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    const res = await handler(apiEvent('POST', '/brokers/trading212/sync', { body: { portfolioId: 'trading-212', userId: 'mallory' } }));
    expect(res.statusCode).toBe(202);
    expect(json(res)).toEqual({ accepted: true });
    expect(jobs.enqueued).toEqual([{ job: 'syncBroker', payload: { userId: 'demo', portfolioId: 'trading-212' } }]);
  });

  it('404s when not connected and does not invoke', async () => {
    const { handler, jobs } = setup();
    const res = await handler(apiEvent('POST', '/brokers/trading212/sync', { body: { portfolioId: 'trading-212' } }));
    expect(res.statusCode).toBe(404);
    expect(json(res).error.code).toBe('NOT_CONNECTED');
    expect(jobs.enqueued).toEqual([]);
  });

  it('validates the body', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('POST', '/brokers/trading212/sync', { body: {} }))).statusCode).toBe(400);
  });
});

describe('DELETE /brokers/trading212', () => {
  it('removes the secret and the state of the caller only', async () => {
    const { handler, store, secrets } = setup();
    await handler(apiEvent('PUT', '/brokers/trading212', { body: connectBody() }));
    secrets.stored.set('alice', credentials() as Trading212Credentials);
    const res = await handler(apiEvent('DELETE', '/brokers/trading212'));
    expect(res.statusCode).toBe(204);
    expect(secrets.stored.has('demo')).toBe(false);
    expect(secrets.stored.has('alice')).toBe(true);
    expect(await store.getState('demo', 'trading-212')).toBeNull();
  });

  it('is idempotent', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('DELETE', '/brokers/trading212'))).statusCode).toBe(204);
  });
});
