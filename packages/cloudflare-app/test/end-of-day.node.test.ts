import { METRIC_LIMITS } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { OWNER_ID, SAP_PRICE, T212_KEY, T212_SECRET } from './fakes.js';
import { createNodeStack } from './node-stack.js';

// The calendar rules of the end-of-day rows need a clock that moves: only the Node stack has one (the pinned clock starts on Monday 5 Jan 2026, 13:00 Amsterdam).
const DAY_MS = 86_400_000;
const userId = `github-${OWNER_ID}`;

async function connected() {
  const stack = await createNodeStack({ limits: METRIC_LIMITS });
  const owner = new Browser(stack);
  await owner.signIn();
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const portfolio = (await call('POST', '/portfolios', { name: 'Calendar' })).body.portfolioId as string;
  expect((await call('PUT', '/brokers/trading212', { portfolioId: portfolio, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' })).status).toBe(204);
  const buy = { portfolioId: portfolio, date: '2026-01-02', type: 'BUY', symbol: 'SAP.DE', quantity: 5, price: 200, currency: 'EUR' };
  expect((await call('POST', '/transactions', buy)).status).toBe(201);
  await stack.drain();
  const rows = async (): Promise<string[]> => {
    // a new sign-in: the session of the first one may be older than its lifetime on this clock
    const fresh = new Browser(stack);
    await fresh.signIn();
    const history = (await (await fresh.request('/api/prices/status')).json()).history;
    const sap = history.symbols.find((row: { symbol: string }) => row.symbol === 'SAP.DE');
    return sap.eodRows === 0 ? [] : [sap.firstEod, sap.lastEod, String(sap.eodRows)];
  };
  const closeRun = async () => {
    stack.advance?.(60_000);
    await stack.enqueue('refreshT212Quotes', { trigger: 'close', userId });
    await stack.drain();
  };
  return { stack, rows, closeRun };
}

describe('end-of-day rows on a moving clock (Node)', () => {
  it('skips Saturday and Sunday, and writes the first weekday after them', async () => {
    const { stack, rows, closeRun } = await connected();
    stack.advance?.(5 * DAY_MS);
    await closeRun();
    stack.advance?.(DAY_MS);
    await closeRun();
    expect(await rows()).toEqual([]);
    expect(stack.trading212.positionCalls()).toBeGreaterThan(0);

    stack.advance?.(DAY_MS);
    await closeRun();
    expect(await rows()).toEqual(['2026-01-12', '2026-01-12', '1']);
  });

  it('adds one row per weekday and keeps the earlier ones', async () => {
    const { stack, rows, closeRun } = await connected();
    await closeRun();
    stack.advance?.(DAY_MS);
    await closeRun();
    expect(await rows()).toEqual(['2026-01-05', '2026-01-06', '2']);
    expect(stack.trading212.positionCalls()).toBeGreaterThanOrEqual(2);
  });

  it('values the stored close like any other: the chart carries it forward to the next day', async () => {
    const { stack, closeRun } = await connected();
    await closeRun();
    expect(SAP_PRICE).toBeGreaterThan(0);
    stack.advance?.(DAY_MS);
    const owner = new Browser(stack);
    await owner.signIn();
    const history = await (await owner.request('/api/history', { query: { range: 'ALL' } })).json();
    expect(history.points.at(-1).date).toBe('2026-01-06');
    expect(history.points.at(-1).value).toBeCloseTo(5 * SAP_PRICE, 2);
  });
});
