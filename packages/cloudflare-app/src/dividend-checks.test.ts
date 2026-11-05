import { JOBS, MemoryItemStore, type JobMessage, type JobQueue } from '@portfolio/platform';
import { parsePricesConfig } from '@portfolio/prices';
import { describe, expect, it } from 'vitest';
import { DIVIDEND_ASK_KEY, createDividendChecksApi } from './dividend-checks.js';

const NOW = new Date('2026-11-05T09:00:00.000Z');

class RecordingQueue implements JobQueue {
  readonly messages: JobMessage[] = [];
  enqueue<N extends keyof typeof JOBS>(message: JobMessage<N>): Promise<void> {
    this.messages.push(message as JobMessage);
    return Promise.resolve();
  }
}

function setup(options: { env?: Record<string, string>; used?: number; calendarUsed?: number; day?: string } = {}) {
  const items = new MemoryItemStore();
  const queue = new RecordingQueue();
  let at = NOW;
  const config = parsePricesConfig({ EODHD_API_KEY: 'eod-key', ...options.env });
  const day = options.day ?? '2026-11-05';
  items.load([
    { PK: 'USAGE', SK: 'eodhd', entityType: 'PROVIDER_USAGE', day, used: options.used ?? 6 },
    { PK: 'CALENDAR', SK: 'BUDGET#eodhd', entityType: 'CALENDAR_BUDGET', day, used: options.calendarUsed ?? 2 },
  ]);
  const api = createDividendChecksApi({ items, config, queue, now: () => at });
  return { items, queue, api, advance: (ms: number) => (at = new Date(at.getTime() + ms)) };
}

describe('createDividendChecksApi', () => {
  it('reports the EODHD allowance of the day, the sources with a key and that a check is possible', async () => {
    expect(await setup().api.status()).toEqual({
      budget: { provider: 'EODHD', day: '2026-11-05', used: 6, limit: 20, remaining: 14, calendarUsed: 2, calendarLimit: 8 },
      refresh: { available: true, reason: null, nextAllowedAt: null },
      configured: { eodhd: true, alphavantage: false },
    });
  });

  it('counts a call of another day as unused and never reports a negative allowance', async () => {
    expect((await setup({ day: '2026-11-04' }).api.status()).budget).toMatchObject({ used: 0, calendarUsed: 0, remaining: 20 });
    expect((await setup({ used: 40 }).api.status()).budget).toMatchObject({ used: 40, remaining: 0 });
  });

  it('queues a dividends-only calendar run once, and refuses a second ask within the hour with the time to ask again', async () => {
    const { api, queue, items, advance } = setup();
    expect(await api.refresh()).toEqual({ accepted: true });
    expect(queue.messages).toEqual([{ job: JOBS.refreshCalendar, payload: { trigger: 'manual', part: 'dividends' } }]);
    expect(await items.get(DIVIDEND_ASK_KEY)).toMatchObject({ askedAt: NOW.toISOString() });

    advance(20 * 60_000);
    expect(await api.refresh()).toEqual({ accepted: false, reason: 'rate-limited', message: 'Dividends were checked on request at 09:00 UTC; you can ask again after 10:00 UTC (once an hour).', retryAfterSeconds: 2400 });
    expect(queue.messages).toHaveLength(1);
    expect(await api.status()).toMatchObject({ refresh: { available: false, nextAllowedAt: '2026-11-05T10:00:00.000Z', reason: expect.stringContaining('once an hour') } });

    advance(41 * 60_000);
    expect(await api.refresh()).toEqual({ accepted: true });
    expect(queue.messages).toHaveLength(2);
  });

  it('refuses while the allowance is spent and says why, with the reset time', async () => {
    const { api, queue } = setup({ used: 18 });
    expect(await api.refresh()).toMatchObject({ accepted: false, reason: 'budget-low', retryAfterSeconds: 15 * 3600, message: expect.stringContaining('18 of 20 calls today (UTC)') });
    expect(queue.messages).toEqual([]);
    expect(await api.status()).toMatchObject({ refresh: { available: false, nextAllowedAt: '2026-11-06T00:00:00.000Z' } });
  });

  it('still allows a check with exactly three calls left', async () => {
    const { api, queue } = setup({ used: 17 });
    expect(await api.refresh()).toEqual({ accepted: true });
    expect(queue.messages).toHaveLength(1);
  });

  it('refuses without an EODHD key', async () => {
    const { api, queue } = setup({ env: { EODHD_API_KEY: '' } });
    expect(await api.refresh()).toMatchObject({ accepted: false, reason: 'not-configured', message: expect.stringContaining('EODHD_API_KEY') });
    expect(queue.messages).toEqual([]);
    expect(await api.status()).toMatchObject({ refresh: { available: false, nextAllowedAt: null }, configured: { eodhd: false } });
  });
});
