import type { AlphaVantageProbeStatus, RunAlphaVantageProbeResponse } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import type { AlphaVantageProbeDeps } from './deps.js';
import { createHandler } from './lambda/handler.js';
import { apiEvent, fakeDeps } from './testing/fakes.js';

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

const budget = { provider: 'Alpha Vantage', day: '2026-06-15', used: 2, limit: 25, remaining: 23, calendarUsed: 1, calendarLimit: 1 } as const;
const result: RunAlphaVantageProbeResponse = {
  at: '2026-06-15T12:00:00.000Z',
  symbol: 'IBM',
  call: 'EARNINGS_ESTIMATES',
  outcome: 'rate-limited',
  summary: 'rate limit (unspecified): the provider asked to slow down',
  message: 'Please contact premium@alphavantage.co if you are targeting a higher API call volume.',
  budget,
};
const status: AlphaVantageProbeStatus = { available: true, reason: null, nextAllowedAt: null, budget, last: null };

const handlerWith = (probe?: Partial<AlphaVantageProbeDeps>) => {
  const made = fakeDeps(probe === undefined ? {} : { alphaVantageProbe: { status: () => Promise.resolve(status), run: () => Promise.reject(new Error('unused')), ...probe } });
  return createHandler(() => made.deps);
};

describe('GET /diagnostics/alphavantage-probe', () => {
  const get = (handler: ReturnType<typeof createHandler>) => handler(apiEvent('GET', '/diagnostics/alphavantage-probe'));

  it('says the test is not available where the deployment has none (AWS)', async () => {
    const res = await get(handlerWith());
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ available: false, nextAllowedAt: null, budget: null, last: null });
    expect(json(res).reason).toContain('Cloudflare');
  });

  it('returns what the deployment reports: whether it may run, the allowance and the last result', async () => {
    const res = await get(handlerWith({ status: () => Promise.resolve({ ...status, last: result }) }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ available: true, budget: { used: 2, limit: 25 }, last: { outcome: 'rate-limited' } });
  });
});

describe('POST /diagnostics/alphavantage-probe', () => {
  const post = (handler: ReturnType<typeof createHandler>) => handler(apiEvent('POST', '/diagnostics/alphavantage-probe'));

  it('answers 404 where the deployment has no such test', async () => {
    const res = await post(handlerWith());
    expect(res.statusCode).toBe(404);
    expect(json(res).error.code).toBe('NOT_AVAILABLE');
  });

  it('answers 200 with the outcome and the sanitised words of the provider', async () => {
    const res = await post(handlerWith({ run: () => Promise.resolve({ accepted: true, result }) }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual(result);
  });

  it('answers 429 with the reason and Retry-After when it ran less than ten minutes ago', async () => {
    const res = await post(handlerWith({ run: () => Promise.resolve({ accepted: false, reason: 'rate-limited', message: 'Ask again after 12:10 UTC.', retryAfterSeconds: 600 }) }));
    expect(res.statusCode).toBe(429);
    expect(res.headers?.['retry-after']).toBe('600');
    expect(json(res)).toEqual({ error: { code: 'RATE_LIMITED', message: 'Ask again after 12:10 UTC.', details: { reason: 'rate-limited', retryAfterSeconds: 600 } } });
  });

  it('answers 429 without Retry-After when the allowance is low and 503 when there is no key', async () => {
    const refusal = (reason: 'budget-low' | 'not-configured') => handlerWith({ run: () => Promise.resolve({ accepted: false, reason, message: 'Because.' }) });
    const low = await post(refusal('budget-low'));
    expect(low.statusCode).toBe(429);
    expect(low.headers?.['retry-after']).toBeUndefined();
    const missing = await post(refusal('not-configured'));
    expect(missing.statusCode).toBe(503);
    expect(json(missing).error).toMatchObject({ code: 'NOT_CONFIGURED', message: 'Because.' });
  });
});
