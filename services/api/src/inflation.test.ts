import { MemoryItemStore } from '@portfolio/platform';
import { INFLATION_ROUTES, type InflationResponse } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { createHandler } from './lambda/handler.js';
import { matchRoute } from './router.js';
import { apiEvent, fakeDeps } from './testing/fakes.js';
import { fakeEcb, fakeInflationPoints } from './testing/inflation-fakes.js';

const ALICE = '11111111-1111-4111-8111-111111111111';

function setup(authMode: 'cognito' | 'demo' = 'demo') {
  const ecb = fakeEcb();
  const items = new MemoryItemStore();
  const ctx = fakeDeps({ inflation: { items, fetch: ecb.fetch } });
  const deps = { ...ctx.deps, config: { ...ctx.deps.config, authMode } };
  const handler = createHandler(() => deps);
  const call = async (query: Record<string, string> = {}, sub?: string) => {
    const res = await handler(apiEvent('GET', '/inflation', { query, sub }));
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };
  return { ecb, items, call, handler };
}

describe('GET /inflation', () => {
  it('is a route of the contract', () => {
    expect(INFLATION_ROUTES.inflationGet).toBe('GET /inflation');
    expect(matchRoute('GET', '/inflation').route).toBe('GET /inflation');
  });

  it('serves the euro-area series by default and the Netherlands on request, both cached', async () => {
    const { call, ecb } = setup();
    const euro = await call();
    expect(euro.status).toBe(200);
    const body = euro.body as InflationResponse;
    expect(body).toMatchObject({ area: 'U2', series: 'HICP.M.U2.N.000000.4D0.ANR', latestMonth: '2026-09', stale: false, fetchedAt: '2026-06-15T12:00:00.000Z' });
    expect(body.points).toEqual(fakeInflationPoints('U2'));
    const dutch = await call({ area: 'NL' });
    expect(dutch.body).toMatchObject({ area: 'NL', series: 'HICP.M.NL.N.000000.4D0.ANR' });
    await call();
    await call({ area: 'NL' });
    expect(ecb.requests).toHaveLength(2);
  });

  it('refuses an unknown area before asking the ECB', async () => {
    const { call, ecb } = setup();
    const res = await call({ area: 'DE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(ecb.requests).toEqual([]);
  });

  it('answers 502 INFLATION_UNAVAILABLE when the ECB is down and nothing is cached, and serves the copy afterwards', async () => {
    const { call, ecb } = setup();
    ecb.failWith = 500;
    const down = await call();
    expect(down.status).toBe(502);
    expect(down.body.error).toMatchObject({ code: 'INFLATION_UNAVAILABLE' });
    ecb.failWith = null;
    expect((await call()).status).toBe(200);
    ecb.failWith = 500;
    expect((await call()).body.stale).toBe(false);
  });

  it('answers 503 INFLATION_NOT_CONFIGURED in a deployment without the feature', async () => {
    const { deps } = fakeDeps();
    const handler = createHandler(() => deps);
    const res = await handler(apiEvent('GET', '/inflation'));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!).error.code).toBe('INFLATION_NOT_CONFIGURED');
  });

  it('answers 500 when the cache itself cannot be read (only the ECB failing is a 502)', async () => {
    const broken = { get: () => Promise.reject(new Error('table unavailable')) } as unknown as MemoryItemStore;
    const { deps } = fakeDeps({ inflation: { items: broken, fetch: fakeEcb().fetch } });
    const res = await createHandler(() => deps)(apiEvent('GET', '/inflation'));
    expect(res.statusCode).toBe(500);
  });

  it('needs a signed-in user and fetches nothing for an anonymous caller', async () => {
    const { handler, ecb } = setup('cognito');
    const anonymous = await handler(apiEvent('GET', '/inflation'));
    expect(anonymous.statusCode).toBe(401);
    expect(ecb.requests).toEqual([]);
    const signedIn = await handler(apiEvent('GET', '/inflation', { sub: ALICE }));
    expect(signedIn.statusCode).toBe(200);
    expect(ecb.requests).toHaveLength(1);
  });
});
