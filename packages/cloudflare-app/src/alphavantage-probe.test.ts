import { MemoryItemStore } from '@portfolio/platform';
import { parsePricesConfig, type EstimatesAnswer } from '@portfolio/prices';
import { describe, expect, it, vi } from 'vitest';
import { PROBE_KEY, createAlphaVantageProbeApi, resultOf } from './alphavantage-probe.js';

const NOW = new Date('2026-10-29T09:00:00.000Z');

const ESTIMATES = {
  symbol: 'IBM',
  estimates: [
    { date: '2026-12-31', horizon: 'fiscal quarter', eps_estimate_average: '4.6', revenue_estimate_average: '20000000000' },
    { date: '2026-09-30', horizon: 'fiscal quarter', eps_estimate_average: '2.6' },
    { date: '2026-12-31', horizon: 'fiscal year', eps_estimate_average: '9' },
  ],
};

function setup(options: { env?: Record<string, string>; used?: number; reply?: unknown | Error; day?: string; store?: MemoryItemStore } = {}) {
  const items = options.store ?? new MemoryItemStore();
  let at = NOW;
  items.load([{ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: options.day ?? '2026-10-29', used: options.used ?? 2 }]);
  const urls: string[] = [];
  const events: string[] = [];
  const fetch = vi.fn((url: string) => {
    urls.push(url);
    events.push('fetch');
    return options.reply instanceof Error ? Promise.reject(options.reply) : Promise.resolve(Response.json(options.reply ?? ESTIMATES));
  });
  const pacer = {
    wait: (provider: string) => {
      events.push(`pace ${provider}`);
      return Promise.resolve(0);
    },
  };
  const config = parsePricesConfig({ ALPHAVANTAGE_API_KEY: 'av-secret', ...options.env });
  const api = createAlphaVantageProbeApi({ items, config, now: () => at, fetch, pacer });
  return { items, api, urls, events, advance: (ms: number) => (at = new Date(at.getTime() + ms)) };
}

describe('createAlphaVantageProbeApi', () => {
  it('reports the allowance and that the test may run, without a last result before the first run', async () => {
    const { api } = setup();
    expect(await api.status()).toEqual({
      available: true,
      reason: null,
      nextAllowedAt: null,
      budget: { provider: 'Alpha Vantage', day: '2026-10-29', used: 2, limit: 25, remaining: 23, calendarUsed: 0, calendarLimit: 1 },
      last: null,
    });
  });

  it('makes one paced call for IBM with the real key, counts it, and answers with the quarters', async () => {
    const { api, urls, events, items } = setup();
    const outcome = await api.run();
    expect(urls).toEqual(['https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=IBM&apikey=av-secret']);
    expect(events).toEqual(['pace alphavantage', 'fetch']);
    expect(outcome).toMatchObject({
      accepted: true,
      result: { at: NOW.toISOString(), symbol: 'IBM', call: 'EARNINGS_ESTIMATES', outcome: 'ok', summary: 'ok: 2 quarters', quarters: 2, budget: { used: 3, remaining: 22 } },
    });
    expect(await items.get({ PK: 'USAGE', SK: 'alphavantage' })).toMatchObject({ used: 3 });
    expect(JSON.stringify(outcome)).not.toContain('av-secret');
  });

  it('keeps the result for the next status and refuses a second run within ten minutes, with the time to ask again', async () => {
    const { api, advance, urls } = setup();
    await api.run();
    advance(4 * 60_000);
    const refused = await api.run();
    expect(refused).toEqual({ accepted: false, reason: 'rate-limited', message: 'The test ran at 09:00 UTC; you can run it again after 09:10 UTC (once every 10 minutes).', retryAfterSeconds: 360 });
    expect(urls).toHaveLength(1);
    expect(await api.status()).toMatchObject({ available: false, nextAllowedAt: '2026-10-29T09:10:00.000Z', last: { outcome: 'ok', quarters: 2 } });
    advance(7 * 60_000);
    expect(await api.run()).toMatchObject({ accepted: true });
    expect(urls).toHaveLength(2);
  });

  it('is refused when fewer than three of the 25 calls are left, without a call', async () => {
    const { api, urls } = setup({ used: 23 });
    const refused = await api.run();
    expect(refused).toMatchObject({ accepted: false, reason: 'budget-low', retryAfterSeconds: 54_000 });
    expect(refused.accepted === false && refused.message).toContain('23 of 25');
    expect(urls).toEqual([]);
    expect(await api.status()).toMatchObject({ available: false, nextAllowedAt: '2026-10-30T00:00:00.000Z' });
    expect(await setup({ used: 22 }).api.run()).toMatchObject({ accepted: true });
  });

  it('counts a call of another day as unused', async () => {
    const { api } = setup({ used: 25, day: '2026-10-28' });
    expect(await api.run()).toMatchObject({ accepted: true, result: { budget: { used: 1 } } });
  });

  it('is refused without a key, and says so in the status', async () => {
    const { api, urls } = setup({ env: { ALPHAVANTAGE_API_KEY: '' } });
    expect(await api.run()).toMatchObject({ accepted: false, reason: 'not-configured' });
    expect(await api.status()).toMatchObject({ available: false, reason: expect.stringContaining('ALPHAVANTAGE_API_KEY') });
    expect(urls).toEqual([]);
  });

  it('is refused, without a call, when another request spent the allowance between the check and the spend', async () => {
    class StaleReads extends MemoryItemStore {
      override async getMany(keys: Parameters<MemoryItemStore['getMany']>[0]) {
        const found = await super.getMany(keys);
        return found.map((item) => (item.SK === 'alphavantage' ? { ...item, used: 22 } : item));
      }
    }
    const { api, urls } = setup({ used: 25, store: new StaleReads() });
    const refused = await api.run();
    expect(refused).toMatchObject({ accepted: false, reason: 'budget-low' });
    expect(refused.accepted === false && refused.message).toContain('22 of 25');
    expect(urls).toEqual([]);
  });

  it('shows the exact words of each provider answer', async () => {
    const volume = 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.';
    const run = async (reply: unknown) => (await setup({ reply }).api.run()) as { accepted: true; result: { outcome: string; summary: string; message?: string } };
    expect((await run({ Information: volume })).result).toMatchObject({ outcome: 'rate-limited', message: volume, summary: 'rate limit (unspecified): the provider asked to slow down' });
    expect((await run({ Information: 'Our standard API rate limit is 25 requests per day. See https://www.alphavantage.co/premium/ now.' })).result).toMatchObject({ outcome: 'daily-limit', message: 'Our standard API rate limit is 25 requests per day. See (link) now.' });
    expect((await run({ Note: 'Burst pattern detected. Please consider spreading out your free API requests more sparingly (1 request per second).' })).result.outcome).toBe('burst-limit');
    expect((await run({ Information: 'This is a premium endpoint.' })).result).toMatchObject({ outcome: 'premium', summary: 'premium endpoint: the free key cannot use it' });
    expect((await run({ Information: 'the parameter apikey is invalid or missing.' })).result.outcome).toBe('invalid-key');
    expect((await run({})).result).toMatchObject({ outcome: 'no-coverage' });
    expect((await run({ estimates: 'soon', symbol: 'IBM' })).result).toMatchObject({ outcome: 'error', message: 'the answer has no list of estimates' });
    expect((await setup({ reply: new Error('network') }).api.run()) as { result: { outcome: string } }).toMatchObject({ result: { outcome: 'error' } });
  });
});

describe('resultOf', () => {
  const at = NOW.toISOString();
  const cases: [EstimatesAnswer, string][] = [
    [{ status: 'ok', quarters: [] }, 'ok'],
    [{ status: 'premium' }, 'premium'],
    [{ status: 'rate-limited' }, 'rate-limited'],
    [{ status: 'rate-limited', scope: 'burst' }, 'burst-limit'],
    [{ status: 'rate-limited', scope: 'daily' }, 'daily-limit'],
    [{ status: 'no-coverage' }, 'no-coverage'],
    [{ status: 'error', reason: 'x', invalidKey: true }, 'invalid-key'],
    [{ status: 'error', reason: 'x' }, 'error'],
  ];
  it.each(cases)('maps %j to %s', (answer, outcome) => {
    expect(resultOf(answer, at)).toMatchObject({ at, symbol: 'IBM', outcome });
  });

  it('keeps the stored last result readable while the call is out (the ask is recorded first)', async () => {
    const { api, items } = setup();
    await items.put({ ...PROBE_KEY, entityType: 'ALPHAVANTAGE_PROBE', askedAt: NOW.toISOString() });
    expect(await api.status()).toMatchObject({ available: false, last: null });
  });
});
