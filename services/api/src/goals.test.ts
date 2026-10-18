import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GOALS_ROUTES, defaultGoalSettings, type GoalResponse } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { matchRoute } from './router.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const NOW = '2026-06-15T12:00:00.000Z';
const TODAY = '2026-06-15';

/** `default`: EUR ETF + USD AAPL (= € 1.200 + € 1.000); `broker`: a USD MSFT (€ 800). Latest USD rate 1,1. */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [
    portfolio({ portfolioId: 'default', name: 'Main portfolio' }),
    portfolio({ portfolioId: 'broker', name: 'Broker', createdAt: '2025-02-01T00:00:00.000Z' }),
    portfolio({ portfolioId: 'default', userId: 'someone-else', name: 'Other main' }),
  ];
  repo.transactions = [
    txn({ id: 't1', date: '2025-01-10', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-03-03', type: 'BUY', symbol: 'AAPL', quantity: 5, price: 150, currency: 'USD' }),
    txn({ id: 'b1', portfolioId: 'broker', date: '2025-05-02', type: 'BUY', symbol: 'MSFT', quantity: 2, price: 400, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 120, previousClose: 118, currency: 'EUR', asOf: NOW, source: 'test' },
    AAPL: { symbol: 'AAPL', price: 220, previousClose: 215, currency: 'USD', asOf: NOW, source: 'test' },
    MSFT: { symbol: 'MSFT', price: 440, previousClose: 440, currency: 'USD', asOf: NOW, source: 'test' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: NOW };
  const handler = createHandler(() => ctx.deps);
  const call = async (method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; sub?: string } = {}) => {
    const res = await handler(apiEvent(method, path, opts));
    return { status: res.statusCode, body: json(res), res };
  };
  return { ...ctx, call };
}

const valueGoal = { goalType: 'value', targetAmount: 100_000, targetYear: 2036, monthlyContribution: 0, priceReturnPct: 5, reinvestDividends: false, adjustForInflation: false };

describe('routing', () => {
  it('matches every goals route', () => {
    for (const [name, spec] of Object.entries(GOALS_ROUTES)) {
      const [method, path] = spec.split(' ') as [string, string];
      expect(matchRoute(method, path).name).toBe(name);
    }
  });
});

describe('GET /goals', () => {
  it('returns the defaults and a projection from the combined portfolios when nothing is saved', async () => {
    const s = setup();
    const { status, body } = await s.call('GET', '/goals');
    const goal = body as GoalResponse;
    expect(status).toBe(200);
    expect(goal).toMatchObject({ saved: false, updatedAt: null, settings: defaultGoalSettings(TODAY) });
    expect(goal.projection).toMatchObject({ baseCurrency: 'EUR', asOf: TODAY, goalType: 'income', startYear: 2026, targetYear: 2056 });
    expect(goal.projection.start.value).toBe(3000);
    expect(goal.projection.rows[0]).toMatchObject({ yearOffset: 0, year: 2026 });
    expect(goal.projection.scenarios.map((x) => x.id)).toEqual(['plan', 'safe', 'alternative']);
  });

  it('scopes the starting value to one portfolio and treats all as combined', async () => {
    const s = setup();
    expect(((await s.call('GET', '/goals', { query: { portfolioId: 'default' } })).body as GoalResponse).projection.start.value).toBe(2200);
    expect(((await s.call('GET', '/goals', { query: { portfolioId: 'broker' } })).body as GoalResponse).projection.start.value).toBe(800);
    expect(((await s.call('GET', '/goals', { query: { portfolioId: 'all' } })).body as GoalResponse).projection.start.value).toBe(3000);
  });

  it('rejects unknown and malformed portfolios', async () => {
    const s = setup();
    expect((await s.call('GET', '/goals', { query: { portfolioId: 'nope' } })).status).toBe(404);
    const bad = await s.call('GET', '/goals', { query: { portfolioId: 'Bad Id' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('moves a saved target year that has passed into the selectable window and ignores unreadable items', async () => {
    const s = setup();
    s.mgmt.goals = [
      { ...defaultGoalSettings(TODAY), goalType: 'value', targetYear: 2020, userId: 'demo', portfolioId: 'default', createdAt: 'a', updatedAt: 'b' },
      { userId: 'demo', portfolioId: 'broker', createdAt: 'a', updatedAt: 'b', goalType: 'broken' } as never,
    ];
    const stale = (await s.call('GET', '/goals', { query: { portfolioId: 'default' } })).body as GoalResponse;
    expect(stale.saved).toBe(true);
    expect(stale.settings.targetYear).toBe(2027);
    expect(stale.projection.targetYear).toBe(2027);
    const broken = (await s.call('GET', '/goals', { query: { portfolioId: 'broker' } })).body as GoalResponse;
    expect(broken.saved).toBe(true);
    expect(broken.settings).toEqual(defaultGoalSettings(TODAY));
  });
});

describe('PUT /goals', () => {
  it('saves the settings and returns the projection; GET then returns them as saved', async () => {
    const s = setup();
    const put = await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, body: valueGoal });
    const goal = put.body as GoalResponse;
    expect(put.status).toBe(200);
    expect(goal).toMatchObject({ saved: true, updatedAt: NOW });
    expect(goal.settings).toMatchObject({ goalType: 'value', targetAmount: 100_000, startYieldPct: null, inflationPct: 2 });
    // € 2.200 compounding at 5 % for ten years, no contributions
    expect(goal.projection.rows[10]).toMatchObject({ year: 2036, plan: 3583.57 });
    expect(goal.projection.requiredContribution.status).toBe('required');

    expect(s.mgmt.goals).toEqual([expect.objectContaining({ userId: 'demo', portfolioId: 'default', createdAt: NOW, updatedAt: NOW, goalType: 'value' })]);
    const get = (await s.call('GET', '/goals', { query: { portfolioId: 'default' } })).body as GoalResponse;
    expect(get).toMatchObject({ saved: true, updatedAt: NOW, settings: goal.settings });
    expect(get.projection).toEqual(goal.projection);
  });

  it('keeps createdAt when overwriting', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { body: valueGoal });
    s.deps.now = () => new Date('2026-07-01T00:00:00.000Z');
    await s.call('PUT', '/goals', { body: { ...valueGoal, targetAmount: 200_000 } });
    expect(s.mgmt.goals).toHaveLength(1);
    expect(s.mgmt.goals[0]).toMatchObject({ createdAt: NOW, updatedAt: '2026-07-01T00:00:00.000Z', targetAmount: 200_000, portfolioId: 'all' });
  });

  it('keeps one goal per scope', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { body: valueGoal });
    await s.call('PUT', '/goals', { query: { portfolioId: 'broker' }, body: { ...valueGoal, targetAmount: 5000 } });
    expect(s.mgmt.goals.map((g) => [g.portfolioId, g.targetAmount]).sort((a, b) => a[0]!.toString().localeCompare(b[0]!.toString()))).toEqual([
      ['all', 100_000],
      ['broker', 5000],
    ]);
    expect(((await s.call('GET', '/goals', { query: { portfolioId: 'all' } })).body as GoalResponse).settings.targetAmount).toBe(100_000);
    expect(((await s.call('GET', '/goals', { query: { portfolioId: 'default' } })).body as GoalResponse).saved).toBe(false);
  });

  it('never takes identity from the body', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { query: { portfolioId: 'broker' }, body: { ...valueGoal, userId: 'victim', portfolioId: 'default', createdAt: '1999', updatedAt: '1999' } });
    expect(s.mgmt.goals).toHaveLength(1);
    expect(s.mgmt.goals[0]).toMatchObject({ userId: 'demo', portfolioId: 'broker', createdAt: NOW });
  });

  it('answers 400 with field details and writes nothing for invalid settings', async () => {
    const s = setup();
    const res = await s.call('PUT', '/goals', { body: { ...valueGoal, targetAmount: -1, targetYear: 2026, inflationPct: 99 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = (res.body.error.details as { path: string[] }[]).map((d) => d.path[0]).sort((a, b) => String(a).localeCompare(String(b)));
    expect(fields).toEqual(['inflationPct', 'targetAmount', 'targetYear']);
    expect(s.mgmt.goals).toEqual([]);
  });

  it('rejects a missing or malformed body and unknown portfolios', async () => {
    const s = setup();
    expect((await s.call('PUT', '/goals')).status).toBe(400);
    expect((await s.call('PUT', '/goals', { body: '{nope' })).status).toBe(400);
    expect((await s.call('PUT', '/goals', { query: { portfolioId: 'nope' }, body: valueGoal })).status).toBe(404);
    expect(s.mgmt.goals).toEqual([]);
  });

  it('isolates users', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, body: valueGoal });
    const other = (await s.call('GET', '/goals', { query: { portfolioId: 'default' }, sub: 'someone-else' })).body as GoalResponse;
    expect(other.saved).toBe(false);
    expect(other.projection.start.value).toBe(0);
    await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, sub: 'someone-else', body: { ...valueGoal, targetAmount: 7 } });
    expect(s.mgmt.goals.map((g) => [g.userId, g.targetAmount])).toEqual([
      ['demo', 100_000],
      ['someone-else', 7],
    ]);
    expect(((await s.call('GET', '/goals', { query: { portfolioId: 'default' } })).body as GoalResponse).settings.targetAmount).toBe(100_000);
  });
});

describe('DELETE /goals', () => {
  it('removes the saved goal (and is idempotent)', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { body: valueGoal });
    const del = await s.call('DELETE', '/goals');
    expect(del.status).toBe(204);
    expect(del.res.body).toBe('');
    expect(s.mgmt.goals).toEqual([]);
    expect((await s.call('DELETE', '/goals')).status).toBe(204);
    expect(((await s.call('GET', '/goals')).body as GoalResponse).saved).toBe(false);
  });

  it('only removes the requested scope of the requesting user', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { body: valueGoal });
    await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, body: valueGoal });
    await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, sub: 'someone-else', body: valueGoal });
    await s.call('DELETE', '/goals', { query: { portfolioId: 'default' } });
    expect(s.mgmt.goals.map((g) => [g.userId, g.portfolioId])).toEqual([
      ['demo', 'all'],
      ['someone-else', 'default'],
    ]);
  });

  it('answers 404 for an unknown portfolio', async () => {
    const s = setup();
    expect((await s.call('DELETE', '/goals', { query: { portfolioId: 'nope' } })).status).toBe(404);
  });
});

describe('POST /goals/calculate', () => {
  it('returns a projection without saving anything', async () => {
    const s = setup();
    const res = await s.call('POST', '/goals/calculate', { query: { portfolioId: 'broker' }, body: valueGoal });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBeUndefined();
    expect(res.body.settings).toMatchObject({ goalType: 'value', targetAmount: 100_000 });
    expect(res.body.projection).toMatchObject({ goalType: 'value', start: { value: 800 } });
    expect(s.mgmt.goals).toEqual([]);
  });

  it('validates like PUT and reports unknown portfolios', async () => {
    const s = setup();
    expect((await s.call('POST', '/goals/calculate', { body: { ...valueGoal, targetYear: 1990 } })).status).toBe(400);
    expect((await s.call('POST', '/goals/calculate', { query: { portfolioId: 'nope' }, body: valueGoal })).status).toBe(404);
  });
});

describe('deleting a portfolio', () => {
  it('removes its goal with the rest of its data and leaves the other scopes alone', async () => {
    const s = setup();
    await s.call('PUT', '/goals', { query: { portfolioId: 'broker' }, body: valueGoal });
    await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, body: valueGoal });
    await s.call('PUT', '/goals', { body: valueGoal });
    await s.call('PUT', '/goals', { query: { portfolioId: 'default' }, sub: 'someone-else', body: valueGoal });
    expect((await s.call('DELETE', '/portfolios/broker', { query: { force: 'true' } })).status).toBe(204);
    expect(s.mgmt.goals.map((g) => [g.userId, g.portfolioId]).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([
      ['demo', 'all'],
      ['demo', 'default'],
      ['someone-else', 'default'],
    ]);
  });
});
