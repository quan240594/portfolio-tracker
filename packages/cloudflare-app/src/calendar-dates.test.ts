import { JOBS, MemoryItemStore, type JobMessage, type JobQueue } from '@portfolio/platform';
import { parsePricesConfig } from '@portfolio/prices';
import { describe, expect, it } from 'vitest';
import { REFRESH_ASK_KEY, createCalendarDatesApi } from './calendar-dates.js';

const NOW = new Date('2026-10-28T09:00:00.000Z');

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
  const config = parsePricesConfig({ ALPHAVANTAGE_API_KEY: 'av-key', ...options.env });
  const day = options.day ?? '2026-10-28';
  items.load([
    { PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day, used: options.used ?? 4 },
    { PK: 'CALENDAR', SK: 'BUDGET#alphavantage', entityType: 'CALENDAR_BUDGET', day, used: options.calendarUsed ?? 1 },
  ]);
  const api = createCalendarDatesApi({ items, config, queue, now: () => at });
  return { items, queue, api, advance: (ms: number) => (at = new Date(at.getTime() + ms)) };
}

describe('createCalendarDatesApi', () => {
  it('reports the Alpha Vantage allowance of the day and that a refresh is possible', async () => {
    const { api } = setup();
    expect(await api.status()).toEqual({
      budget: { provider: 'Alpha Vantage', day: '2026-10-28', used: 4, limit: 25, remaining: 21, calendarUsed: 1, calendarLimit: 1 },
      refresh: { available: true, reason: null, nextAllowedAt: null },
    });
  });

  it('counts a call of another day as unused and never reports a negative allowance', async () => {
    expect((await setup({ day: '2026-10-27' }).api.status()).budget).toMatchObject({ used: 0, calendarUsed: 0, remaining: 25 });
    expect((await setup({ used: 40, env: { ALPHAVANTAGE_DAILY_LIMIT: '25' } }).api.status()).budget).toMatchObject({ used: 40, remaining: 0 });
  });

  it('queues the calendar job once as a manual run, and refuses a second ask within the hour with the time to ask again', async () => {
    const { api, queue, items, advance } = setup();
    expect(await api.refresh()).toEqual({ accepted: true });
    expect(queue.messages).toEqual([{ job: JOBS.refreshCalendar, payload: { trigger: 'manual' } }]);
    expect(await items.get(REFRESH_ASK_KEY)).toMatchObject({ askedAt: NOW.toISOString() });

    advance(20 * 60_000);
    const refused = await api.refresh();
    expect(refused).toEqual({ accepted: false, reason: 'rate-limited', message: 'Earnings dates were refreshed on request at 09:00 UTC; you can ask again after 10:00 UTC (once an hour).', retryAfterSeconds: 2400 });
    expect(queue.messages).toHaveLength(1);
    expect(await api.status()).toMatchObject({ refresh: { available: false, nextAllowedAt: '2026-10-28T10:00:00.000Z', reason: expect.stringContaining('once an hour') } });

    advance(41 * 60_000);
    expect(await api.refresh()).toEqual({ accepted: true });
    expect(queue.messages).toHaveLength(2);
  });

  it('refuses while the allowance is nearly used and says why, with the reset time', async () => {
    const { api, queue } = setup({ used: 23 });
    const refused = await api.refresh();
    expect(refused).toMatchObject({ accepted: false, reason: 'budget-low', retryAfterSeconds: 15 * 3600, message: expect.stringContaining('23 of 25 calls today (UTC)') });
    expect(queue.messages).toEqual([]);
    expect(await api.status()).toMatchObject({ refresh: { available: false, nextAllowedAt: '2026-10-29T00:00:00.000Z' } });
  });

  it('still allows a refresh with exactly three calls left', async () => {
    expect(await setup({ used: 22 }).api.refresh()).toEqual({ accepted: true });
  });

  it('refuses without an Alpha Vantage key', async () => {
    const { api, queue } = setup({ env: { ALPHAVANTAGE_API_KEY: '' } });
    expect(await api.refresh()).toMatchObject({ accepted: false, reason: 'not-configured', message: expect.stringContaining('ALPHAVANTAGE_API_KEY') });
    expect(queue.messages).toEqual([]);
    expect((await api.status()).refresh.available).toBe(false);
  });

  it('ignores a damaged ask record', async () => {
    const { api, items } = setup();
    await items.put({ ...REFRESH_ASK_KEY, entityType: 'EARNINGS_REFRESH_ASK', askedAt: 42 });
    expect(await api.refresh()).toEqual({ accepted: true });
  });
});
