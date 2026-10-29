import type { Item } from '@portfolio/platform';
import { parseEarningsRun, type StoredEarningsEvent } from '@portfolio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors.js';
import { createMarketData } from '../market.js';
import { PriceRepository } from '../repository.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { drive, harness, track, type Harness } from '../testing/harness.js';
import { createRefreshCalendarJob } from './refresh-calendar.js';

afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-10-28T04:30:00.000Z');
const STAMP = '2026-10-28T04:30:00.000Z';
const DAY = 86_400_000;

const CSV = [
  'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
  'GOOG,Alphabet Inc - Class C,2026-10-28,2026-09-30,2.31,USD,post-market',
  'AAPL,Apple Inc,2026-10-29,2026-09-30,1.85,USD,post-market',
  'ASML,ASML HOLDING NV,2027-01-28,2026-12-31,6.9,EUR,pre-market',
  'MSFT,Microsoft Corp,2026-10-20,2026-09-30,3.1,USD,post-market',
  '',
].join('\n');

const live = (...replies: unknown[]): Harness => harness({ start: NOW, fake: new FakeFetch().add('alphavantage.co', ...replies) });
const run = (h: Harness, trigger: 'scheduled' | 'manual' = 'scheduled') => drive(h, createRefreshCalendarJob(h.deps), { trigger });
const item = (h: Harness, sk: string): Item | undefined => h.store.snapshot().find((candidate) => candidate.PK === 'CALENDAR' && candidate.SK === sk);
const lastRun = (h: Harness) => parseEarningsRun(item(h, 'EARNINGS#LASTRUN'));
const lastOk = (h: Harness) => parseEarningsRun(item(h, 'EARNINGS#LASTOK'));

describe('the calendar job records what it did to the earnings dates', () => {
  it('records the rows the provider returned, the symbols it stored and the tickers it listed without a date', async () => {
    const h = live({ text: CSV });
    track(h.store, 'GOOGL', 'GOOG', 'AAPL', 'MSFT', 'ASML.AS');
    h.store.load([{ PK: 'TICKER#ASML.AS', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'ASML.AS', name: 'Some Other Company' }]);
    await run(h);
    expect(lastRun(h)).toEqual({
      at: STAMP,
      trigger: 'scheduled',
      status: 'ok',
      reason: '',
      tracked: 5,
      rows: 4,
      events: 2,
      matchedSymbols: ['AAPL', 'GOOG'],
      listed: ['AAPL', 'ASML.AS', 'GOOG', 'MSFT'],
      unvouched: ['ASML.AS'],
    });
    expect(lastOk(h)).toEqual(lastRun(h));
    expect(item(h, 'EARNINGS#LASTRUN')).toMatchObject({ entityType: 'EARNINGS_RUN' });
  });

  it('records a provider failure with its reason and keeps the last successful run', async () => {
    const h = live({ text: CSV }, { text: 'Thank you for using Alpha Vantage! Please subscribe.' });
    track(h.store, 'GOOGL');
    await run(h);
    h.clock.advance(DAY);
    await run(h);
    expect(lastRun(h)).toMatchObject({ at: expect.stringContaining('2026-10-29T04:30'), status: 'failed', reason: 'alphavantage: unexpected response for EARNINGS_CALENDAR', tracked: 1 });
    expect(lastOk(h)).toMatchObject({ at: STAMP, status: 'ok', rows: 4 });
  });

  it('records the Alpha Vantage rate limit as its own outcome', async () => {
    const h = live({ text: JSON.stringify({ Information: 'Our standard API rate limit is 25 requests per day.' }) });
    track(h.store, 'GOOGL');
    await run(h);
    expect(lastRun(h)).toMatchObject({ status: 'rate-limited', reason: 'alphavantage: daily limit: Our standard API rate limit is 25 requests per day.' });
    expect(lastOk(h)).toBeNull();
  });

  it('records an HTTP error without the URL or the key', async () => {
    const h = live({ status: 500 });
    track(h.store, 'GOOGL');
    await run(h);
    const record = lastRun(h);
    expect(record?.status).toBe('failed');
    expect(record?.reason).toContain('500');
    expect(JSON.stringify(h.store.snapshot())).not.toContain('av-secret-key');
  });

  it('records a run the daily calendar budget refused, and a manual run goes past that budget', async () => {
    const h = live({ text: CSV }, { text: CSV });
    track(h.store, 'GOOGL');
    await run(h);
    h.clock.advance(60_000);
    expect((await run(h)).result.earnings.status).toBe('budget-exhausted');
    expect(lastRun(h)).toMatchObject({ status: 'budget-exhausted', reason: '', trigger: 'scheduled' });
    expect(h.fake.urls.filter((url) => url.includes('alphavantage.co'))).toHaveLength(1);

    h.clock.advance(60_000);
    expect((await run(h, 'manual')).result.earnings.status).toBe('ok');
    expect(lastRun(h)).toMatchObject({ status: 'ok', trigger: 'manual', at: expect.stringContaining('2026-10-28T04:32') });
    expect(h.fake.urls.filter((url) => url.includes('alphavantage.co'))).toHaveLength(2);
  });

  it('a manual run still stops at the provider quota', async () => {
    const h = live({ text: CSV });
    track(h.store, 'GOOGL');
    h.store.load([{ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-28', used: 25 }]);
    expect((await run(h, 'manual')).result.earnings).toEqual({ status: 'rate-limited', error: 'RateLimitError' });
    expect(lastRun(h)?.reason).toContain('daily quota of 25 exhausted');
    expect(h.fake.urls.filter((url) => url.includes('alphavantage.co'))).toEqual([]);
  });

  it('records a deployment without a key and one without anything to look up', async () => {
    const noKey = harness({ start: NOW, env: { ALPHAVANTAGE_API_KEY: '' } });
    track(noKey.store, 'GOOGL');
    await run(noKey);
    expect(lastRun(noKey)).toMatchObject({ status: 'no-provider', reason: '', tracked: 1 });

    const none = live({ text: CSV });
    track(none.store, 'BTC-EUR');
    await run(none);
    expect(lastRun(none)).toMatchObject({ status: 'no-symbols' });
    expect(lastOk(none)).toBeNull();
  });

  it('records the dates of a source that does not count its rows (the counts are absent, not zero)', async () => {
    const events: StoredEarningsEvent[] = [{ symbol: 'GOOGL', date: '2026-10-28', source: 'alphavantage', timeOfDay: 'AMC' }];
    const h = harness({
      start: NOW,
      marketData: (deps, fetch) => ({ ...createMarketData(deps, fetch), earnings: { name: 'alphavantage', budgeted: true, fetch: () => Promise.resolve(events) } }),
    });
    track(h.store, 'GOOGL');
    await run(h);
    expect(lastRun(h)).toEqual({ at: STAMP, trigger: 'scheduled', status: 'ok', reason: '', tracked: 1, events: 1, matchedSymbols: ['GOOGL'] });
  });

  it('does not fail the job when the record cannot be written', async () => {
    vi.spyOn(PriceRepository.prototype, 'putEarningsRun').mockRejectedValue(new Error('store down'));
    const h = live({ text: CSV });
    track(h.store, 'AAPL');
    expect((await run(h)).result.earnings).toMatchObject({ status: 'ok', events: 1 });
  });

  it('reads a failure message that is not an Error as the error name', async () => {
    const h = harness({
      start: NOW,
      marketData: (deps, fetch) => ({ ...createMarketData(deps, fetch), earnings: { name: 'alphavantage', budgeted: false, fetch: () => Promise.reject(new ProviderError('')) } }),
    });
    track(h.store, 'AAPL');
    await run(h);
    expect(lastRun(h)).toMatchObject({ status: 'failed', reason: 'ProviderError' });
  });
});

describe('PriceRepository.callsUsedOn', () => {
  it('reads the calls of the day and ignores a counter of another day', async () => {
    const h = harness({ start: NOW });
    h.store.load([
      { PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-28', used: 7 },
      { PK: 'CALENDAR', SK: 'BUDGET#alphavantage', entityType: 'CALENDAR_BUDGET', day: '2026-10-27', used: 1 },
    ]);
    const repo = new PriceRepository(h.store);
    expect(await repo.callsUsedOn('alphavantage', '2026-10-28')).toEqual({ used: 7, calendarUsed: 0 });
    expect(await repo.callsUsedOn('eodhd', '2026-10-28')).toEqual({ used: 0, calendarUsed: 0 });
  });
});
