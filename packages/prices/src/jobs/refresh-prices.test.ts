import { cond, MemoryItemStore, type Item } from '@portfolio/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePricesConfig } from '../config.js';
import { SubrequestBudgetError } from '../errors.js';
import { RoutingProvider } from '../providers/routing.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { ALL_KEYS, NOW, collect, drive, driveTwice, harness, liveFake, tdQuote, track } from '../testing/harness.js';
import { createRefreshPricesJob } from './refresh-prices.js';

afterEach(() => vi.restoreAllMocks());

const OFF_WINDOW = new Date('2026-10-13T10:00:00.000Z'); // 12:00 in Amsterdam
const stored = (store: MemoryItemStore, pk: string, sk: string): Item | undefined => store.snapshot().find((item) => item.PK === pk && item.SK === sk);
const fxDays = (store: MemoryItemStore): string[] => store.snapshot().filter((item) => item.PK === 'FX#EUR' && item.SK.startsWith('DAY#')).map((item) => String(item.date));

describe('refreshPrices', () => {
  it('writes the quotes, today\'s EOD rows, the latest FX and the daily fixings', async () => {
    const h = harness({ fake: liveFake() });
    track(h.store, 'AAPL', 'ASML.AS', 'BTC-EUR');
    const { result, steps } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });

    expect(steps.filter((step) => !step.done)).toHaveLength(0);
    expect(result).toEqual({
      refreshed: 3,
      skipped: 0,
      failed: 0,
      fxUpdated: true,
      fxDaysWritten: 3,
      fxHistoryOk: true,
      profileDetailsRefreshed: 0,
      eventPublished: false,
      euWindow: true,
      failedSymbols: [],
      skippedSymbols: [],
    });
    expect(stored(h.store, 'TICKER#AAPL', 'QUOTE#LATEST')).toEqual({
      PK: 'TICKER#AAPL',
      SK: 'QUOTE#LATEST',
      entityType: 'QUOTE',
      symbol: 'AAPL',
      price: 230.12,
      previousClose: 228.5,
      currency: 'USD',
      asOf: '2026-10-13T16:30:00.000Z',
      source: 'twelvedata',
    });
    expect(stored(h.store, 'TICKER#ASML.AS', 'EOD#2026-10-13')).toEqual({ PK: 'TICKER#ASML.AS', SK: 'EOD#2026-10-13', entityType: 'EOD', symbol: 'ASML.AS', date: '2026-10-13', close: 701.2, currency: 'EUR' });
    expect(stored(h.store, 'TICKER#BTC-EUR', 'QUOTE#LATEST')).toMatchObject({ price: 60600, previousClose: 60000, currency: 'EUR', source: 'coingecko' });
    expect(stored(h.store, 'FX#EUR', 'LATEST')).toEqual({ PK: 'FX#EUR', SK: 'LATEST', entityType: 'FX', base: 'EUR', asOf: '2026-10-13T14:00:00.000Z', rates: { USD: 1.16, GBP: 0.87 } });
    expect(fxDays(h.store)).toEqual(['2026-10-01', '2026-10-02', '2026-10-13']);
    expect(stored(h.store, 'FX#EUR', 'DAY#2026-10-13')).toEqual({ PK: 'FX#EUR', SK: 'DAY#2026-10-13', entityType: 'FX_DAY', base: 'EUR', date: '2026-10-13', rates: { GBP: 0.87, USD: 1.16 } });
  });

  it('never sends an API key anywhere but the documented header or query parameter', async () => {
    const h = harness({ fake: liveFake() });
    track(h.store, 'AAPL', 'ASML.AS', 'BTC-EUR');
    await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
    const byHost = (host: string) => h.fake.requests.filter((request) => request.url.includes(host));
    expect(byHost('twelvedata')[0]!.headers.authorization).toBe('apikey td-secret-key');
    expect(byHost('twelvedata')[0]!.url).not.toContain('td-secret-key');
    expect(byHost('eodhd')[0]!.url).toContain('api_token=eod-secret-key');
    expect(byHost('coingecko')[0]!.headers['x-cg-demo-api-key']).toBe('cg-secret-key');
    expect(byHost('frankfurter').every((request) => request.headers.authorization === undefined)).toBe(true);
    expect(h.fake.requests.every((request) => request.signal !== undefined)).toBe(true);
  });

  it('refreshes exchange-listed symbols outside the EU window only when their quote is missing or stale', async () => {
    const h = harness({ fake: liveFake().add('eodhd.com/api/real-time/MC.PA', [
        { code: 'SAP.XETRA', close: 200, previousClose: 199, timestamp: OFF_WINDOW.getTime() / 1000 },
        { code: 'MC.PA', close: 600, previousClose: 590, timestamp: OFF_WINDOW.getTime() / 1000 },
      ]), start: OFF_WINDOW });
    track(h.store, 'AAPL', 'ASML.AS', 'SAP.DE', 'MC.PA', 'BTC-EUR');
    const quote = (symbol: string, asOf: string) => ({ PK: `TICKER#${symbol}`, SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol, price: 700, previousClose: 690, currency: 'EUR', asOf, source: 'x' });
    h.store.load([quote('ASML.AS', '2026-10-12T16:00:00.000Z'), quote('SAP.DE', '2026-10-12T09:00:00.000Z')]); // 18 h and 25 h old
    const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
    expect(result.euWindow).toBe(false);
    expect(result.skippedSymbols).toEqual(['ASML.AS']);
    expect(result.refreshed).toBe(4);
    expect(stored(h.store, 'TICKER#ASML.AS', 'QUOTE#LATEST')!.price).toBe(700);
    expect(stored(h.store, 'TICKER#SAP.DE', 'QUOTE#LATEST')!.asOf).toBe('2026-10-13T10:00:00.000Z');
  });

  it('treats a corrupt stored quote as missing and honours EU_REFRESH_HOURS', async () => {
    const h = harness({ fake: liveFake(), start: OFF_WINDOW, env: { EU_REFRESH_HOURS: '9, 12' } });
    track(h.store, 'ASML.AS');
    h.store.load([{ PK: 'TICKER#ASML.AS', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'ASML.AS', price: 'oops' }]);
    expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result).toMatchObject({ euWindow: true, refreshed: 1 });

    const stale = harness({ fake: liveFake(), start: new Date('2026-10-13T08:00:00Z') });
    track(stale.store, 'ASML.AS');
    stale.store.load([{ PK: 'TICKER#ASML.AS', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'ASML.AS', price: 1, previousClose: 1, currency: 'EUR', asOf: 'not a date', source: 'x' }]);
    expect((await drive(stale, createRefreshPricesJob(stale.deps), { trigger: 'scheduled' })).result).toMatchObject({ euWindow: false, refreshed: 1 });
  });

  it('counts failures per symbol without throwing', async () => {
    const fake = liveFake().add('twelvedata.com/quote', { code: 404, status: 'error' });
    const h = harness({ fake });
    track(h.store, 'GONE', 'ASML.AS', 'BTC-EUR');
    const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
    expect(result).toMatchObject({ refreshed: 2, failed: 1, failedSymbols: ['GONE'] });
  });

  it('reports a crashing provider as failed symbols', async () => {
    vi.spyOn(RoutingProvider.prototype, 'getQuotes').mockRejectedValue(new Error('bug'));
    const h = harness({ fake: liveFake() });
    track(h.store, 'AAPL');
    const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
    expect(result).toMatchObject({ refreshed: 0, failed: 1, failedSymbols: ['AAPL'], eventPublished: false });
  });

  it('counts a failed quote write and an empty tracked list', async () => {
    const h = harness({ fake: liveFake() });
    track(h.store, 'AAPL');
    const original = h.store.batchWrite.bind(h.store);
    vi.spyOn(h.store, 'batchWrite').mockImplementation((ops) => (ops.some((op) => op.type === 'put' && op.item.PK === 'TICKER#AAPL') ? Promise.reject(new Error('disk full')) : original(ops)));
    expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result).toMatchObject({ refreshed: 0, failed: 1 });

    const empty = harness({ fake: liveFake() });
    expect((await drive(empty, createRefreshPricesJob(empty.deps), { trigger: 'scheduled' })).result).toMatchObject({ refreshed: 0, skipped: 0, failed: 0, fxUpdated: true });
  });

  it('skips symbols whose provider has no API key', async () => {
    const h = harness({ fake: liveFake(), env: { TWELVEDATA_API_KEY: '', COINGECKO_API_KEY: '' } });
    track(h.store, 'AAPL', 'BTC-EUR');
    const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
    expect(result).toMatchObject({ skippedSymbols: ['AAPL', 'BTC-EUR'], failed: 0, refreshed: 0 });
  });

  describe('FX', () => {
    const noQuotes = () => harness({ fake: liveFake() });

    it('backfills from the day after the newest stored fixing and is a no-op once up to date', async () => {
      const h = noQuotes();
      h.store.load([{ PK: 'FX#EUR', SK: 'DAY#2026-10-07', entityType: 'FX_DAY', base: 'EUR', date: '2026-10-07', rates: { USD: 1.1 } }]);
      h.fake.add('frankfurter.dev/v1/2026-10-08..2026-10-13', { base: 'EUR', rates: { '2026-10-08': { USD: 1.1 }, '2026-10-09': { USD: 1.1 }, '2026-10-12': { USD: 1.1 } } });
      const first = (await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result;
      expect(first).toMatchObject({ fxDaysWritten: 4, fxHistoryOk: true });
      expect(fxDays(h.store)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13']);
      const calls = h.fake.urls.length;
      const second = (await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result;
      expect(second).toMatchObject({ fxDaysWritten: 0, fxHistoryOk: true });
      expect(h.fake.urls.slice(calls).filter((url) => url.includes('..'))).toEqual([]);
    });

    it('fills the gap before the oldest stored fixing once a day, from FX_HISTORY_START, without refetching what is stored', async () => {
      const day = (date: string) => ({ PK: 'FX#EUR', SK: `DAY#${date}`, entityType: 'FX_DAY', base: 'EUR', date, rates: { USD: 1.1 } });
      const h = harness({ fake: liveFake(), env: { FX_HISTORY_START: '2026-09-01' } });
      h.store.load([day('2026-10-05'), day('2026-10-12')]);
      h.fake.add('frankfurter.dev/v1/2026-09-01..2026-10-04', { base: 'EUR', rates: { '2026-09-01': { USD: 1.2 }, '2026-09-02': { USD: 1.2 } } });
      h.fake.add('frankfurter.dev/v1/2026-10-13..2026-10-13', { base: 'EUR', rates: {} });
      const first = (await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result;
      expect(first).toMatchObject({ fxHistoryOk: true });
      expect(fxDays(h.store)).toEqual(expect.arrayContaining(['2026-09-01', '2026-09-02', '2026-10-05', '2026-10-12', '2026-10-13']));
      expect(h.fake.urls.filter((url) => url.includes('..') && url.includes('2026-09-01'))).toHaveLength(1);
      // the gap is filled: the next run asks for nothing before the oldest fixing
      const calls = h.fake.urls.length;
      await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(h.fake.urls.slice(calls).filter((url) => url.includes('2026-09-01'))).toEqual([]);
    });

    it('looks for that gap once a UTC day even when the provider has nothing for it', async () => {
      const day = { PK: 'FX#EUR', SK: 'DAY#2026-10-12', entityType: 'FX_DAY', base: 'EUR', date: '2026-10-12', rates: { USD: 1.1 } };
      const h = harness({ fake: liveFake().add('frankfurter.dev/v1/2026-09-01..2026-10-11', { base: 'EUR', rates: {} }).add('frankfurter.dev/v1/2026-10-13..2026-10-13', { base: 'EUR', rates: {} }), env: { FX_HISTORY_START: '2026-09-01' } });
      h.store.load([day]);
      const asked = () => h.fake.urls.filter((url) => url.includes('2026-09-01..')).length;
      await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(asked()).toBe(1);
      h.clock.advance(24 * 3_600_000);
      h.fake.add('frankfurter.dev/v1/2026-10-13..2026-10-14', { base: 'EUR', rates: {} });
      await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(asked()).toBe(2);
    });

    it('starts at FX_HISTORY_START and never stores weekend fixings', async () => {
      const h = noQuotes();
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result.fxDaysWritten).toBe(3);
      expect(fxDays(h.store)).not.toContain('2026-10-03');
    });

    it('still backfills when the latest rates are unavailable, and stores no fixing for today', async () => {
      const fake = new FakeFetch().add('frankfurter.dev/v1/latest', { status: 503 }).add('frankfurter.dev/v1/2026-10-01..2026-10-13', { base: 'EUR', rates: { '2026-10-01': { USD: 1.15 } } });
      const h = harness({ fake });
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result).toMatchObject({ fxUpdated: false, fxHistoryOk: true, fxDaysWritten: 1 });
      expect(stored(h.store, 'FX#EUR', 'LATEST')).toBeUndefined();
    });

    it('isolates a failing history: quotes are refreshed, today is not written, the gap stays detectable', async () => {
      const fake = liveFake().add('frankfurter.dev/v1/2026-10-08..2026-10-13', { status: 503 });
      const h = harness({ fake });
      track(h.store, 'AAPL');
      h.store.load([{ PK: 'FX#EUR', SK: 'DAY#2026-10-07', entityType: 'FX_DAY', base: 'EUR', date: '2026-10-07', rates: { USD: 1.1 } }]);
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result).toMatchObject({ refreshed: 1, fxUpdated: true, fxHistoryOk: false, fxDaysWritten: 0 });
      expect(fxDays(h.store)).toEqual(['2026-10-07']);
      expect(stored(h.store, 'FX#EUR', 'LATEST')).toBeDefined();
    });

    it('writes the latest fixing when the history is not published yet', async () => {
      const fake = liveFake().add('frankfurter.dev/v1/2026-10-13..2026-10-13', { base: 'EUR', rates: {} });
      const h = harness({ fake });
      h.store.load(['2026-10-02', '2026-10-12'].map((date) => ({ PK: 'FX#EUR', SK: `DAY#${date}`, entityType: 'FX_DAY', base: 'EUR', date, rates: { USD: 1.1 } })));
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result.fxDaysWritten).toBe(1);
      expect(fxDays(h.store)).toEqual(['2026-10-02', '2026-10-12', '2026-10-13']);
    });

    it('isolates a failing write of today\'s fixing', async () => {
      const fake = liveFake().add('frankfurter.dev/v1/2026-10-01..2026-10-13', { base: 'EUR', rates: {} });
      const h = harness({ fake });
      const original = h.store.batchWrite.bind(h.store);
      vi.spyOn(h.store, 'batchWrite').mockImplementation((ops) => (ops.some((op) => op.type === 'put' && op.item.entityType === 'FX_DAY') ? Promise.reject(new Error('throttled')) : original(ops)));
      expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result).toMatchObject({ fxHistoryOk: false, fxDaysWritten: 0 });
    });

    it('isolates storage failures of the fixings', async () => {
      const h = harness({ fake: liveFake() });
      track(h.store, 'AAPL');
      const original = h.store.batchWrite.bind(h.store);
      vi.spyOn(h.store, 'batchWrite').mockImplementation((ops) => (ops.some((op) => op.type === 'put' && op.item.entityType === 'FX_DAY') ? Promise.reject(new Error('throttled')) : original(ops)));
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result).toMatchObject({ refreshed: 1, fxHistoryOk: false, fxDaysWritten: 0 });
    });

    it('survives a failing lookup of the newest stored fixing', async () => {
      const h = noQuotes();
      const query = h.store.query.bind(h.store);
      vi.spyOn(h.store, 'query').mockImplementation((q) => (q.pk.startsWith('FX#') ? Promise.reject(new Error('unavailable')) : query(q)));
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result).toMatchObject({ fxHistoryOk: false, fxUpdated: true, fxDaysWritten: 0 });
    });

    it('does not store today\'s fixing when it is stored already or when the base differs', async () => {
      const h = harness({ fake: liveFake(), env: { BASE_CURRENCY: 'USD', FX_HISTORY_START: '2026-10-13' } });
      h.fake.add('frankfurter.dev/v1/latest', { base: 'EUR', date: '2026-10-13', rates: { USD: 1.1 } });
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result).toMatchObject({ fxUpdated: true, fxDaysWritten: 0 });
    });

    it('fails the FX store write without failing the job', async () => {
      const h = noQuotes();
      vi.spyOn(h.store, 'put').mockRejectedValue(new Error('no'));
      expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result).toMatchObject({ fxUpdated: false });
    });
  });

  describe('profile details', () => {
    const profile = (symbol: string, extra: Record<string, unknown> = {}): Item => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name: symbol, assetClass: 'STOCK', currency: 'USD', ...extra });
    const overview = { Symbol: 'AAPL', Name: 'Changed', AssetType: 'ETF', Currency: 'EUR', Description: 'Designs phones.', EPS: '6.42', Beta: '1.24', PERatio: '34.9' };

    it('refreshes one stale symbol per run with a 30 day TTL and only touches the details', async () => {
      const h = harness({ fake: liveFake().add('alphavantage.co', overview) });
      track(h.store, 'AAPL');
      h.store.load([profile('AAPL', { sector: 'Technology' })]);
      const { result } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result.profileDetailsRefreshed).toBe(1);
      const item = stored(h.store, 'TICKER#AAPL', 'PROFILE')!;
      expect(item).toMatchObject({ name: 'AAPL', assetClass: 'STOCK', currency: 'USD', sector: 'Technology', description: 'Designs phones.', eps: 6.42, beta: 1.24, peRatio: 34.9, detailsAsOf: '2026-10-13' });
      expect(item).not.toHaveProperty('fundamentalsAsOf');
      expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result.profileDetailsRefreshed).toBe(0);
    });

    it('marks unknown and permanently failing symbols as fetched, retries throttled ones later', async () => {
      await collect([{}, { status: 400 }], async (reply) => {
        const h = harness({ fake: liveFake().add('alphavantage.co', reply), env: { TWELVEDATA_API_KEY: '' } });
        track(h.store, 'ZZZ');
        h.store.load([profile('ZZZ')]);
        expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result.profileDetailsRefreshed).toBe(1);
        expect(stored(h.store, 'TICKER#ZZZ', 'PROFILE')).toMatchObject({ detailsAsOf: '2026-10-13' });
      });
      const throttled = harness({ fake: liveFake().add('alphavantage.co', { Information: 'rate limit is 25 requests per day' }), env: { TWELVEDATA_API_KEY: '' } });
      track(throttled.store, 'ZZZ');
      throttled.store.load([profile('ZZZ')]);
      expect((await drive(throttled, createRefreshPricesJob(throttled.deps), { trigger: 'scheduled' })).result.profileDetailsRefreshed).toBe(0);
      expect(stored(throttled.store, 'TICKER#ZZZ', 'PROFILE')).not.toHaveProperty('detailsAsOf');
    });

    it('survives storage errors of the lookup and of the write', async () => {
      const lookup = harness({ fake: liveFake() });
      track(lookup.store, 'AAPL');
      vi.spyOn(lookup.store, 'getMany').mockRejectedValue(new Error('throttled'));
      expect((await drive(lookup, createRefreshPricesJob(lookup.deps), { trigger: 'scheduled' })).result).toMatchObject({ profileDetailsRefreshed: 0 });

      const write = harness({ fake: liveFake().add('alphavantage.co', overview) });
      track(write.store, 'AAPL');
      write.store.load([profile('AAPL')]);
      vi.spyOn(write.store, 'update').mockRejectedValue(new Error('throttled'));
      expect((await drive(write, createRefreshPricesJob(write.deps), { trigger: 'scheduled' })).result.profileDetailsRefreshed).toBe(0);
    });

    it('fails to store the details of a profile that vanished', async () => {
      const h = harness({ fake: liveFake().add('alphavantage.co', overview) });
      track(h.store, 'AAPL');
      h.store.load([profile('AAPL')]);
      vi.spyOn(h.store, 'update').mockResolvedValue(undefined);
      expect((await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' })).result.profileDetailsRefreshed).toBe(0);
    });
  });

  describe('profile details and classification', () => {
    const profile = (symbol: string, extra: Record<string, unknown> = {}): Item => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name: symbol, assetClass: 'OTHER', currency: 'USD', ...extra });
    const apple = { Symbol: 'AAPL', Name: 'Apple Inc.', AssetType: 'Common Stock', Currency: 'USD', Country: 'USA', Sector: 'TECHNOLOGY', Description: 'Designs phones.' };
    const run = (h: ReturnType<typeof harness>) => drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });

    it('upgrades a Trading 212 baseline with the provider profile: sector and country override, the ISIN stays', async () => {
      const h = harness({ fake: liveFake().add('alphavantage.co', apple) });
      track(h.store, 'AAPL');
      h.store.load([profile('AAPL', { name: 'Apple', assetClass: 'STOCK', isin: 'US0378331005', country: 'Ireland', profileSource: 'trading212' })]);
      expect((await run(h)).result.profileDetailsRefreshed).toBe(1);
      expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toMatchObject({ name: 'Apple Inc.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', isin: 'US0378331005', description: 'Designs phones.', profileSource: 'provider', detailsAsOf: '2026-10-13' });
      expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).not.toHaveProperty('enrichedAt');
    });

    it('does not ask EODHD for the profile of a listed symbol that has a Trading 212 baseline, and marks it fetched', async () => {
      const h = harness({ fake: liveFake() });
      track(h.store, 'ASML.AS');
      h.store.load([profile('ASML.AS', { name: 'ASML Holding', assetClass: 'STOCK', currency: 'EUR', profileSource: 'trading212' })]);
      expect((await run(h)).result.profileDetailsRefreshed).toBe(1);
      expect(h.fake.urls.some((url) => url.includes('/api/search/'))).toBe(false);
      expect(stored(h.store, 'TICKER#ASML.AS', 'PROFILE')).toMatchObject({ name: 'ASML Holding', profileSource: 'trading212', detailsAsOf: '2026-10-13' });
    });

    it('asks EODHD for the profile of a listed symbol that only has a minimal one', async () => {
      const h = harness({ fake: liveFake().add('eodhd.com/api/search/ASML', [{ Code: 'ASML', Exchange: 'AS', Name: 'ASML Holding', Type: 'Common Stock', Country: 'Netherlands', Currency: 'EUR' }]) });
      track(h.store, 'ASML.AS');
      h.store.load([profile('ASML.AS', { currency: 'EUR', profileSource: 'minimal' })]);
      await run(h);
      expect(stored(h.store, 'TICKER#ASML.AS', 'PROFILE')).toMatchObject({ name: 'ASML Holding', assetClass: 'STOCK', profileSource: 'provider' });
    });

    it('skips a provider that is limited and a symbol that failed twice today, so one stuck symbol never blocks the others', async () => {
      const h = harness({ fake: liveFake().add('symbol=BBB', { ...apple, Symbol: 'BBB' }).add('symbol=AAA', { status: 500 }), env: { TWELVEDATA_API_KEY: '' } });
      track(h.store, 'AAA', 'BBB');
      h.store.load([profile('AAA', { profileSource: 'minimal' }), profile('BBB', { profileSource: 'minimal' }), { PK: 'TICKER#AAA', SK: 'ENRICH#profile', entityType: 'ENRICH_STATE', symbol: 'AAA', day: '2026-10-13', attempts: 2 }]);
      expect((await run(h)).result.profileDetailsRefreshed).toBe(1);
      expect(h.fake.urls.some((url) => url.includes('symbol=AAA'))).toBe(false);
      expect(stored(h.store, 'TICKER#BBB', 'PROFILE')).toMatchObject({ profileSource: 'provider' });

      const limited = harness({ fake: liveFake().add('alphavantage.co', apple) });
      track(limited.store, 'AAPL');
      limited.store.load([profile('AAPL'), { PK: 'USAGE', SK: 'BLOCK#twelvedata', entityType: 'PROVIDER_BLOCK', provider: 'twelvedata', until: NOW.getTime() + 3_600_000, scope: 'day' }]);
      expect((await run(limited)).result.profileDetailsRefreshed).toBe(0);
      expect(limited.fake.urls.some((url) => url.includes('alphavantage.co'))).toBe(false);
    });

    it('counts a failed lookup as a try of today, but not a provider limit', async () => {
      const failing = harness({ fake: liveFake().add('alphavantage.co', { status: 500 }), env: { TWELVEDATA_API_KEY: '' } });
      track(failing.store, 'AAPL');
      failing.store.load([profile('AAPL')]);
      await run(failing);
      expect(stored(failing.store, 'TICKER#AAPL', 'ENRICH#profile')).toMatchObject({ day: '2026-10-13', attempts: 1 });
      await run(failing);
      expect(stored(failing.store, 'TICKER#AAPL', 'ENRICH#profile')).toMatchObject({ attempts: 2 });
      await run(failing);
      expect(stored(failing.store, 'TICKER#AAPL', 'ENRICH#profile')).toMatchObject({ attempts: 2 });

      const limited = harness({ fake: liveFake().add('alphavantage.co', { Information: 'rate limit is 25 requests per day' }), env: { TWELVEDATA_API_KEY: '' } });
      track(limited.store, 'AAPL');
      limited.store.load([profile('AAPL')]);
      await run(limited);
      expect(stored(limited.store, 'TICKER#AAPL', 'ENRICH#profile')).toBeUndefined();
    });

    it('keeps a fresh listed quote inside the EU window (the Trading 212 refresh stores one every 15 minutes)', async () => {
      const h = harness({ fake: liveFake() });
      track(h.store, 'ASML.AS', 'SAP.DE');
      const quote = (symbol: string, asOf: string): Item => ({ PK: `TICKER#${symbol}`, SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol, price: 1, previousClose: 1, currency: 'EUR', asOf, source: 'trading212' });
      h.store.load([quote('ASML.AS', '2026-10-13T16:20:00.000Z'), quote('SAP.DE', '2026-10-13T11:00:00.000Z')]);
      h.fake.add('eodhd.com/api/real-time/SAP.XETRA', { code: 'SAP.XETRA', close: 2, previousClose: 2, timestamp: Date.parse('2026-10-13T16:30:00Z') / 1000 });
      const { result } = await run(h);
      expect(result).toMatchObject({ euWindow: true, refreshed: 1, skippedSymbols: ['ASML.AS'] });
      expect(h.fake.urls.some((url) => url.includes('real-time/ASML.AS'))).toBe(false);
    });
  });

  describe('healing enrichment', () => {
    const profile = (symbol: string, extra: Record<string, unknown> = {}): Item => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name: symbol, assetClass: 'STOCK', currency: 'USD', ...extra });
    const withEnqueue = (h: ReturnType<typeof harness>, enqueue: (symbols: readonly string[]) => Promise<void>) => createRefreshPricesJob({ ...h.deps, enqueueEnrichment: enqueue });
    const run = (h: ReturnType<typeof harness>, enqueue: (symbols: readonly string[]) => Promise<void>) => drive(h, withEnqueue(h, enqueue), { trigger: 'scheduled' });

    it('hands the tracked symbols that were never enriched to an enrichment job, once a day', async () => {
      const h = harness({ fake: liveFake() });
      track(h.store, 'AAPL', 'ASML.AS', 'BTC-EUR', 'NEW.DE');
      h.store.load([profile('AAPL', { profileSource: 'trading212' }), profile('ASML.AS'), profile('BTC-EUR', { profileSource: 'trading212', enrichedAt: '2026-10-12' })]);
      const enqueue = vi.fn(() => Promise.resolve());
      await run(h, enqueue);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(['AAPL', 'NEW.DE']);
      expect(stored(h.store, 'USAGE', 'ENRICH#HEAL')).toMatchObject({ day: '2026-10-13' });
      await run(h, enqueue);
      expect(enqueue).toHaveBeenCalledTimes(1);
      h.clock.advance(24 * 3_600_000);
      await run(h, enqueue);
      expect(enqueue).toHaveBeenCalledTimes(2);
    });

    it('also hands over an enriched symbol whose history symbol was never fetched, but not one that was', async () => {
      const h = harness({ fake: liveFake() });
      track(h.store, 'AAPL', 'ASML.AS', 'FWRA.MI');
      const record = (symbol: string, status: string): Item => ({ PK: `TICKER#${symbol}`, SK: 'HISTSYM', entityType: 'HISTORY_SYMBOL', historySymbol: 'X.DE', status, setAt: '2026-10-12T10:00:00.000Z' });
      h.store.load([profile('AAPL'), profile('ASML.AS'), profile('FWRA.MI'), record('FWRA.MI', 'pending'), record('ASML.AS', 'applied'), record('AAPL', 'refused')]);
      const enqueue = vi.fn(() => Promise.resolve());
      await run(h, enqueue);
      expect(enqueue).toHaveBeenCalledWith(['FWRA.MI']);
    });

    it('starts nothing when every tracked symbol is enriched, and keeps going when the job cannot be started', async () => {
      const done = harness({ fake: liveFake() });
      track(done.store, 'AAPL');
      done.store.load([profile('AAPL')]);
      const enqueue = vi.fn(() => Promise.resolve());
      await run(done, enqueue);
      expect(enqueue).not.toHaveBeenCalled();
      expect(stored(done.store, 'USAGE', 'ENRICH#HEAL')).toBeUndefined();

      const broken = harness({ fake: liveFake() });
      track(broken.store, 'NEW');
      const failing = vi.fn(() => Promise.reject(new Error('queue down')));
      expect((await run(broken, failing)).result).toMatchObject({ failed: 0 });
      expect(stored(broken.store, 'USAGE', 'ENRICH#HEAL')).toBeUndefined();
    });
  });

  describe('resumable steps', () => {
    it('spreads Twelve Data batches over steps at 8 credits a minute', async () => {
      const symbols = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, '0')}`);
      const fake = liveFake();
      const answer = (batch: string[]) => Object.fromEntries(batch.map((s) => [s, tdQuote(s, '10', '9')]));
      fake.add('twelvedata.com/quote?symbol=T00', answer(symbols.slice(0, 8)));
      fake.add('twelvedata.com/quote?symbol=T08', answer(symbols.slice(8, 16)));
      fake.add('twelvedata.com/quote?symbol=T16', answer(symbols.slice(16)));
      const h = harness({ fake });
      track(h.store, ...symbols);
      const { result, steps } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result.refreshed).toBe(20);
      const waits = steps.flatMap((step) => (step.done ? [] : [step.delayMs]));
      expect(waits).toEqual([60_000, 60_000]);
    });

    it('keeps a step inside its subrequest budget and gives the same result in more steps', async () => {
      const whole = harness({ fake: liveFake() });
      track(whole.store, 'AAPL', 'ASML.AS', 'BTC-EUR');
      const expected = await drive(whole, createRefreshPricesJob(whole.deps), { trigger: 'scheduled' });

      const small = harness({ fake: liveFake(), stepSubrequests: 4 });
      track(small.store, 'AAPL', 'ASML.AS', 'BTC-EUR');
      let used = 0;
      const calls = vi.fn(small.deps.fetch);
      small.deps.fetch = (url, init) => {
        used += 1;
        return calls(url, init);
      };
      const stepsRun = await drive(small, createRefreshPricesJob(small.deps), { trigger: 'scheduled' });
      expect(stepsRun.steps.length).toBeGreaterThan(expected.steps.length);
      expect(stepsRun.result).toEqual(expected.result);
      expect(small.store.snapshot()).toEqual(whole.store.snapshot());
      expect(used).toBe(whole.fake.requests.length);
    });

    it('is idempotent: delivering every step twice changes nothing', async () => {
      const reference = harness({ fake: liveFake(), stepSubrequests: 4 });
      track(reference.store, 'AAPL', 'ASML.AS', 'BTC-EUR');
      const expected = (await drive(reference, createRefreshPricesJob(reference.deps), { trigger: 'scheduled' })).result;

      const h = harness({ fake: liveFake(), stepSubrequests: 4 });
      track(h.store, 'AAPL', 'ASML.AS', 'BTC-EUR');
      const result = await driveTwice(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
      expect(result).toEqual(expected);
      // A repeated step spends its provider quota again (never less), everything else is identical.
      const data = (store: MemoryItemStore) => store.snapshot().filter((item) => item.PK !== 'USAGE').toSorted((x, y) => `${x.PK}${x.SK}`.localeCompare(`${y.PK}${y.SK}`));
      expect(data(h.store)).toEqual(data(reference.store));
    });

    it('continues in the next step when the platform cuts a step off, and lets other errors fail the step', async () => {
      const h = harness({ fake: liveFake() });
      track(h.store, 'AAPL');
      let calls = 0;
      const inner = h.deps.fetch;
      h.deps.fetch = (url, init) => (++calls > 2 ? Promise.reject(new SubrequestBudgetError(2)) : inner(url, init));
      const handler = createRefreshPricesJob(h.deps);
      const first = await handler({ payload: { trigger: 'scheduled' } });
      expect(first.done).toBe(false);

      const broken = harness({ fake: liveFake(), start: OFF_WINDOW });
      track(broken.store, 'ASML.AS');
      vi.spyOn(broken.store, 'getMany').mockImplementation(() => Promise.reject(new Error('unavailable')));
      await expect(createRefreshPricesJob(broken.deps)({ payload: { trigger: 'scheduled' } })).rejects.toThrow('unavailable');
    });

    it('ends a step without progress when the budget runs out inside a unit, and rejects a corrupt cursor', async () => {
      const h = harness({ fake: liveFake(), stepSubrequests: 1 });
      track(h.store, 'AAPL');
      const handler = createRefreshPricesJob(h.deps);
      const first = await handler({ payload: { trigger: 'scheduled' } });
      expect(first.done).toBe(false);
      await expect(handler({ payload: { trigger: 'scheduled' }, cursor: '{"v":2}' })).rejects.toThrow();
    });
  });

  it('uses only the injected configuration', () => {
    expect(parsePricesConfig(ALL_KEYS).keys.twelvedata).toBe('td-secret-key');
    expect(NOW.toISOString()).toBe('2026-10-13T16:30:00.000Z');
    expect(cond.exists.kind).toBe('exists');
  });
});
