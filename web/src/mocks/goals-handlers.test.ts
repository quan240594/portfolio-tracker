import type { GoalResponse } from '@portfolio/shared';
import { apiUrl } from '../api/client';
import { resetDb } from './db';

const call = (method: string, path: string, body?: unknown) =>
  fetch(apiUrl(path), {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
const year = new Date().getFullYear();
const goal = { goalType: 'value', targetAmount: 50_000, targetYear: year + 20, monthlyContribution: 100 };

describe('mock goals API (mirrors services/api)', () => {
  it('returns defaults first, then the saved goal per scope', async () => {
    const initial = (await (await call('GET', '/goals')).json()) as GoalResponse;
    expect(initial).toMatchObject({ saved: false, updatedAt: null, settings: { goalType: 'income' } });
    expect(initial.projection.start.value).toBeGreaterThan(0);

    const put = await call('PUT', '/goals?portfolioId=default', goal);
    expect(put.status).toBe(200);
    expect(((await put.json()) as GoalResponse).saved).toBe(true);
    expect(((await (await call('GET', '/goals?portfolioId=default')).json()) as GoalResponse).settings).toMatchObject(goal);
    expect(((await (await call('GET', '/goals')).json()) as GoalResponse).saved).toBe(false);
    expect(((await (await call('GET', '/goals?portfolioId=all')).json()) as GoalResponse).saved).toBe(false);

    expect((await call('DELETE', '/goals?portfolioId=default')).status).toBe(204);
    expect(((await (await call('GET', '/goals?portfolioId=default')).json()) as GoalResponse).saved).toBe(false);
  });

  it('keeps createdAt on overwrite and calculates statelessly', async () => {
    await call('PUT', '/goals', goal);
    await call('PUT', '/goals', { ...goal, targetAmount: 60_000 });
    expect(((await (await call('GET', '/goals')).json()) as GoalResponse).settings.targetAmount).toBe(60_000);
    const calc = await call('POST', '/goals/calculate?portfolioId=trading-212', goal);
    expect(calc.status).toBe(200);
    const body = (await calc.json()) as { saved?: boolean; projection: { rows: unknown[] } };
    expect(body.saved).toBeUndefined();
    expect(body.projection.rows.length).toBeGreaterThan(20);
    expect(((await (await call('GET', '/goals?portfolioId=trading-212')).json()) as GoalResponse).saved).toBe(false);
  });

  it('validates the body and the scope', async () => {
    expect((await call('PUT', '/goals', { ...goal, targetAmount: -1 })).status).toBe(400);
    expect((await call('PUT', '/goals', null)).status).toBe(400);
    expect((await call('POST', '/goals/calculate', { ...goal, targetYear: 1990 })).status).toBe(400);
    expect((await call('GET', '/goals?portfolioId=nope')).status).toBe(404);
    expect((await call('PUT', '/goals?portfolioId=nope', goal)).status).toBe(404);
    expect((await call('DELETE', '/goals?portfolioId=nope')).status).toBe(404);
    expect((await call('GET', '/goals?portfolioId=Bad%20Id')).status).toBe(400);
  });

  it('removes the goal of a deleted portfolio and forgets everything when the demo data is reset', async () => {
    await call('PUT', '/goals?portfolioId=trading-212', goal);
    await call('PUT', '/goals', goal);
    expect((await call('DELETE', '/portfolios/trading-212?force=true')).status).toBe(204);
    const recreated = (await (await call('POST', '/portfolios', { name: 'Trading 212' })).json()) as { portfolioId: string };
    expect(((await (await call('GET', `/goals?portfolioId=${recreated.portfolioId}`)).json()) as GoalResponse).saved).toBe(false);
    expect(((await (await call('GET', '/goals')).json()) as GoalResponse).saved).toBe(true);

    resetDb();
    expect(((await (await call('GET', '/goals')).json()) as GoalResponse).saved).toBe(false);
  });
});
