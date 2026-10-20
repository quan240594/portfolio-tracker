import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitError } from './errors.js';
import { HttpClient } from './http.js';
import {
  BlockBook,
  DailyQuota,
  MemoryQuotaLedger,
  MinuteQuota,
  PLAN_RECHECK_MS,
  ProviderGate,
  RESET_MARGIN_MS,
  StorePlanMemory,
  StoreQuotaLedger,
  TokenBucket,
  endOfUtcDay,
  resetOf,
  spendCredits,
} from './limits.js';
import { EodhdProvider } from './providers/eodhd.js';
import { TwelveDataProvider } from './providers/twelvedata.js';
import { FakeFetch } from './testing/fake-fetch.js';

const NOW = new Date('2026-10-13T16:30:20.000Z');
const noSleep = (): Promise<void> => Promise.resolve();
const clock = (): Date => NOW;
const http = (fake: FakeFetch, name: string) => new HttpClient({ provider: name, fetch: fake.fetch, sleep: noSleep, maxRetries: 0, random: () => 0 });
const bucket = () => new TokenBucket(100, 100, () => 0, noSleep);
const MIDNIGHT = Date.parse('2026-10-14T00:00:00Z');

describe('reset times', () => {
  it('ends the UTC day and the minute', () => {
    expect(endOfUtcDay('2026-10-13')).toBe(MIDNIGHT);
    expect(resetOf('day', NOW.getTime())).toBe(MIDNIGHT + RESET_MARGIN_MS);
    expect(resetOf('minute', NOW.getTime())).toBe(Date.parse('2026-10-13T16:31:01.000Z'));
  });
});

describe('DailyQuota', () => {
  it('names the reset of the day it ran out in', async () => {
    const quota = new DailyQuota(new MemoryQuotaLedger(), 'eodhd', 1, () => '2026-10-13');
    await quota.consume();
    await expect(quota.consume()).rejects.toMatchObject({ name: 'RateLimitError', provider: 'eodhd', scope: 'day', resetAtMs: MIDNIGHT + RESET_MARGIN_MS });
  });
});

describe('MinuteQuota', () => {
  it('remembers the credits of the minute in the store, so a new step does not start with a full minute', async () => {
    const store = new MemoryItemStore();
    const make = () => new MinuteQuota(new StoreQuotaLedger(store), 'twelvedata', 8, () => NOW.getTime());
    await make().consume(5);
    await make().consume(3);
    await expect(make().consume(1)).rejects.toMatchObject({ name: 'RateLimitError', provider: 'twelvedata', scope: 'minute', resetAtMs: Date.parse('2026-10-13T16:31:01.000Z') });
    expect(await store.get({ PK: 'USAGE', SK: 'twelvedata#minute' })).toMatchObject({ day: '2026-10-13T16:30', used: 8 });
    // The next minute starts again.
    await expect(new MinuteQuota(new StoreQuotaLedger(store), 'twelvedata', 8, () => NOW.getTime() + 60_000).consume(8)).resolves.toBeUndefined();
  });
});

describe('BlockBook and ProviderGate', () => {
  it('stores the longest block, ignores expired ones and opens again after the reset', async () => {
    const store = new MemoryItemStore();
    const book = new BlockBook(store, clock);
    const until = NOW.getTime() + 60_000;
    await book.block('eodhd', until, 'day', 'daily limit');
    await book.block('eodhd', until - 1000, 'minute', 'shorter');
    expect(await book.active(['eodhd', 'twelvedata'])).toEqual(new Map([['eodhd', { until, scope: 'day' }]]));
    expect(await store.get({ PK: 'USAGE', SK: 'BLOCK#eodhd' })).toMatchObject({ entityType: 'PROVIDER_BLOCK', provider: 'eodhd', reason: 'daily limit', setAt: NOW.toISOString() });
    await book.block('eodhd', until + 1000, undefined, 'x'.repeat(500));
    expect(((await store.get({ PK: 'USAGE', SK: 'BLOCK#eodhd' }))!.reason as string).length).toBe(200);
    expect((await book.active(['eodhd'])).get('eodhd')).toEqual({ until: until + 1000 });
    expect(await new BlockBook(store, () => new Date(until + 2000)).active(['eodhd'])).toEqual(new Map());
    expect(await new BlockBook(new MemoryItemStore().load([{ PK: 'USAGE', SK: 'BLOCK#x', until: 'soon' }]), clock).active(['x'])).toEqual(new Map());
  });

  it('refuses at once while blocked, with the reset, and reads the store only once', async () => {
    const store = new MemoryItemStore();
    const spy = vi.spyOn(store, 'getMany');
    const gate = new ProviderGate(new BlockBook(store, clock), 'eodhd', clock);
    await gate.assertOpen();
    await gate.assertOpen();
    expect(spy).toHaveBeenCalledTimes(1);
    await gate.block(NOW.getTime() + 5000, 'day', 'limit');
    await expect(gate.assertOpen()).rejects.toMatchObject({ name: 'RateLimitError', provider: 'eodhd', scope: 'day', resetAtMs: NOW.getTime() + 5000 });
    // Another instance (the next step) sees the stored block.
    const next = new ProviderGate(new BlockBook(store, clock), 'eodhd', clock);
    await expect(next.assertOpen()).rejects.toBeInstanceOf(RateLimitError);
    const later = new ProviderGate(new BlockBook(store, () => new Date(NOW.getTime() + 6000)), 'eodhd', () => new Date(NOW.getTime() + 6000));
    await expect(later.assertOpen()).resolves.toBeUndefined();
  });
});

describe('spendCredits', () => {
  it('asks the gate, then the minute and the day, and blocks the provider when the day is used up', async () => {
    const store = new MemoryItemStore();
    const gate = new ProviderGate(new BlockBook(store, clock), 'eodhd', clock);
    const limits = { quota: new DailyQuota(new MemoryQuotaLedger(), 'eodhd', 2, () => '2026-10-13'), gate };
    await spendCredits(limits, 2);
    await expect(spendCredits(limits, 1)).rejects.toMatchObject({ scope: 'day' });
    expect(await store.get({ PK: 'USAGE', SK: 'BLOCK#eodhd' })).toMatchObject({ scope: 'day', until: MIDNIGHT + RESET_MARGIN_MS });
    await expect(spendCredits(limits, 1)).rejects.toThrow('is limited until');
  });

  it('works without a gate or a minute quota and rethrows other errors', async () => {
    const quota = new DailyQuota(new MemoryQuotaLedger(), 'x', 1, () => '2026-10-13');
    await spendCredits({ quota }, 1);
    await expect(spendCredits({ quota }, 1)).rejects.toBeInstanceOf(RateLimitError);
    const broken = new DailyQuota({ consume: () => Promise.reject(new Error('store down')) }, 'x', 1, () => '2026-10-13');
    await expect(spendCredits({ quota: broken, gate: new ProviderGate(new BlockBook(new MemoryItemStore(), clock), 'x', clock) }, 1)).rejects.toThrow('store down');
  });
});

describe('StorePlanMemory', () => {
  it('remembers a missing endpoint for a week', async () => {
    const store = new MemoryItemStore();
    const plan = new StorePlanMemory(store, 'twelvedata', clock);
    expect(await plan.profileUnsupported()).toBe(false);
    await plan.markProfileUnsupported();
    expect(await plan.profileUnsupported()).toBe(true);
    expect(await store.get({ PK: 'USAGE', SK: 'PLAN#twelvedata' })).toMatchObject({ entityType: 'PROVIDER_PLAN', profileUnsupportedUntil: NOW.getTime() + PLAN_RECHECK_MS });
    expect(await new StorePlanMemory(store, 'twelvedata', () => new Date(NOW.getTime() + PLAN_RECHECK_MS + 1)).profileUnsupported()).toBe(false);
  });
});

describe('providers on the free plans', () => {
  const twelve = (fake: FakeFetch, store = new MemoryItemStore()) => {
    const ledger = new StoreQuotaLedger(store);
    return new TwelveDataProvider({
      apiKey: 'k',
      http: http(fake, 'twelvedata'),
      bucket: bucket(),
      quota: new DailyQuota(ledger, 'twelvedata', 800, () => '2026-10-13'),
      minuteQuota: new MinuteQuota(ledger, 'twelvedata', 8, () => NOW.getTime()),
      gate: new ProviderGate(new BlockBook(store, clock), 'twelvedata', clock),
      plan: new StorePlanMemory(store, 'twelvedata', clock),
      now: clock,
    });
  };

  it('asks for /profile once per plan check: a plan without it is remembered between steps', async () => {
    const fake = new FakeFetch().add('/profile', { status: 'error', code: 403, message: 'Grow plan required' }).add('/stocks', { data: [{ name: 'Acme', currency: 'USD', country: 'USA', exchange: 'NYSE', type: 'Common Stock' }] });
    const store = new MemoryItemStore();
    await twelve(fake, store).getProfile('ACME');
    await twelve(fake, store).getProfile('ACME');
    expect(fake.urls.filter((url) => url.includes('/profile'))).toHaveLength(1);
    expect(fake.urls.filter((url) => url.includes('/stocks'))).toHaveLength(2);
  });

  it('answers a minute limit with the next minute and a day limit with the next UTC day, and blocks until then', async () => {
    const minute = new FakeFetch().add('/time_series', { status: 'error', code: 429, message: 'You have run out of API credits for the current minute.' });
    const store = new MemoryItemStore();
    await expect(twelve(minute, store).getEodHistory('AAPL', '2026-10-01', '2026-10-13')).rejects.toMatchObject({ scope: 'minute', resetAtMs: Date.parse('2026-10-13T16:31:01.000Z') });
    expect(await store.get({ PK: 'USAGE', SK: 'BLOCK#twelvedata' })).toMatchObject({ scope: 'minute' });
    // Blocked: the next call makes no request.
    const requests = minute.requests.length;
    await expect(twelve(minute, store).getEodHistory('AAPL', '2026-10-01', '2026-10-13')).rejects.toBeInstanceOf(RateLimitError);
    expect(minute.requests).toHaveLength(requests);

    const day = new FakeFetch().add('/time_series', { status: 'error', code: 429, message: 'You have run out of API credits for the day.' });
    await expect(twelve(day).getEodHistory('AAPL', '2026-10-01', '2026-10-13')).rejects.toMatchObject({ scope: 'day', resetAtMs: MIDNIGHT + RESET_MARGIN_MS });
  });

  it('blocks the provider when a batch quote answers a 429 for one symbol', async () => {
    const fake = new FakeFetch().add('/quote', { A: { status: 'error', code: 429, message: 'out of credits for the current minute' }, B: { close: '1', previous_close: '1', currency: 'USD', timestamp: NOW.getTime() / 1000 } });
    const store = new MemoryItemStore();
    const batch = await twelve(fake, store).getQuotes(['A', 'B']);
    expect(batch.failed.map((f) => [f.symbol, f.kind])).toEqual([['A', 'rate-limited'], ['B', 'rate-limited']]);
    expect(await store.get({ PK: 'USAGE', SK: 'BLOCK#twelvedata' })).toMatchObject({ scope: 'minute' });
  });

  it('turns EODHD HTTP 402 into a day limit with the reset and blocks until then', async () => {
    const fake = new FakeFetch().add('/eod/', { status: 402 });
    const store = new MemoryItemStore();
    const eodhd = (): EodhdProvider => {
      const ledger = new StoreQuotaLedger(store);
      return new EodhdProvider({ apiKey: 'k', http: http(fake, 'eodhd'), bucket: bucket(), quota: new DailyQuota(ledger, 'eodhd', 20, () => '2026-10-13'), gate: new ProviderGate(new BlockBook(store, clock), 'eodhd', clock), now: clock });
    };
    await expect(eodhd().getEodHistory('ASML.AS', '2026-10-01', '2026-10-13')).rejects.toMatchObject({ scope: 'day', resetAtMs: MIDNIGHT + RESET_MARGIN_MS, provider: 'eodhd' });
    const requests = fake.requests.length;
    await expect(eodhd().getEodHistory('ASML.AS', '2026-10-01', '2026-10-13')).rejects.toBeInstanceOf(RateLimitError);
    expect(fake.requests).toHaveLength(requests);
    expect(await store.get({ PK: 'USAGE', SK: 'BLOCK#eodhd' })).toMatchObject({ until: MIDNIGHT + RESET_MARGIN_MS });
  });

  it('works without the gate (a provider built by hand)', async () => {
    const fake = new FakeFetch().add('/eod/', { status: 402 });
    const eodhd = new EodhdProvider({ apiKey: 'k', http: http(fake, 'eodhd'), bucket: bucket(), quota: new DailyQuota(new MemoryQuotaLedger(), 'eodhd', 20, () => '2026-10-13'), now: clock });
    await expect(eodhd.getEodHistory('ASML.AS', '2026-10-01', '2026-10-13')).rejects.toMatchObject({ scope: 'day' });
  });
});
