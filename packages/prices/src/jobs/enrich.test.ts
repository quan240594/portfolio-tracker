import type { TransactionsChangedDetail } from '@portfolio/shared';
import type { Item } from '@portfolio/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeFetch } from '../testing/fake-fetch.js';
import { NOW, NOW_SECONDS, drive, harness, tdQuote, type Harness } from '../testing/harness.js';
import { RateLimitError } from '../errors.js';
import type { PriceSource } from '../providers/base.js';
import { MAX_ATTEMPTS_PER_DAY, MAX_ENRICH_DAYS, createEnrichTransactionsJob, enrichmentSymbols, quoteFromHistory } from './enrich.js';

afterEach(() => vi.restoreAllMocks());

const event = (symbols: unknown[]): TransactionsChangedDetail => ({ userId: 'u1', portfolioId: 'p1', reason: 'CREATED', symbols: symbols as string[] });
const stored = (store: Harness['store'], pk: string, sk: string): Item | undefined => store.snapshot().find((item) => item.PK === pk && item.SK === sk);
const items = (store: Harness['store'], pk: string, prefix: string): Item[] => store.snapshot().filter((item) => item.PK === pk && item.SK.startsWith(prefix));
const MINUTE = 60_000;
/** NOW is 16:30:00 UTC: the next UTC midnight (plus the one-minute margin) is 7 h 31 min away. */
const TO_RESET = 7.5 * 3_600_000 + MINUTE;

const days = (count: number): { datetime: string; close: string }[] =>
  Array.from({ length: count }, (_, i) => ({ datetime: new Date(Date.UTC(2026, 9, 13 - (count - 1 - i))).toISOString().slice(0, 10), close: String(100 + i) }));

/** Typical answers for AAPL (Alpha Vantage, Twelve Data, EODHD dividends) and BTC-EUR (CoinGecko). */
function enrichFake(): FakeFetch {
  return new FakeFetch()
    .add('alphavantage.co', { Symbol: 'AAPL', AssetType: 'Common Stock', Name: 'Apple Inc.', Exchange: 'NASDAQ', Currency: 'USD', Country: 'USA', Sector: 'TECHNOLOGY', PERatio: '34.2' })
    .add('twelvedata.com/time_series', { meta: { currency: 'USD' }, values: days(5) })
    .add('twelvedata.com/quote', tdQuote('AAPL', '230.12', '228.5'))
    .add('eodhd.com/api/div/AAPL.US', [
      { date: '2024-11-10', paymentDate: '2024-11-14', value: 0.26, currency: 'USD' },
      { date: '2027-01-10', paymentDate: '2027-01-14', value: 0.27, currency: 'USD' },
      { date: '2020-01-10', value: 0.2 },
    ])
    .add('coingecko.com/api/v3/coins/bitcoin/market_chart', { prices: [[Date.UTC(2026, 9, 12), 60000], [Date.UTC(2026, 9, 13), 61000]] })
    .add('coingecko.com/api/v3/simple/price', { bitcoin: { eur: 61000, eur_24h_change: 0, last_updated_at: NOW_SECONDS } });
}

/** An exchange-listed symbol: EODHD search, history, dividends and quote. */
function listedFake(code = 'ASML', exchange = 'AS', base: FakeFetch = new FakeFetch()): FakeFetch {
  return base
    .add(`eodhd.com/api/search/${code}`, [{ Code: code, Exchange: exchange, Name: 'ASML Holding', Type: 'Common Stock', Country: 'Netherlands', Currency: 'EUR', ISIN: 'NL0010273215' }])
    .add(`eodhd.com/api/eod/${code}.${exchange}`, [{ date: '2026-10-12', close: 10 }, { date: '2026-10-13', close: 11 }])
    .add(`eodhd.com/api/div/${code}.${exchange}`, [])
    .add(`eodhd.com/api/real-time/${code}.${exchange}`, { code: `${code}.${exchange}`, close: 11, previousClose: 10, timestamp: NOW_SECONDS });
}

const baseline = (symbol: string, extra: Record<string, unknown> = {}): Item => ({
  PK: `TICKER#${symbol}`,
  SK: 'PROFILE',
  entityType: 'PROFILE',
  symbol,
  name: 'ASML Holding N.V.',
  assetClass: 'STOCK',
  currency: 'EUR',
  isin: 'NL0010273215',
  country: 'Netherlands',
  profileSource: 'trading212',
  ...extra,
});

describe('enrichTransactions', () => {
  it('enriches only symbols that are not enriched, writes the PROFILE item last and is idempotent', async () => {
    const h = harness({ fake: enrichFake() });
    h.store.load([{ PK: 'TICKER#ASML.AS', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'ASML.AS', name: 'ASML', assetClass: 'STOCK', currency: 'EUR' }]);
    const job = createEnrichTransactionsJob(h.deps);
    const { result } = await drive(h, job, event(['AAPL', 'asml.as', 'BTC-EUR', 'AAPL']));
    expect(result).toEqual({ symbols: 3, alreadyEnriched: 1, enriched: ['AAPL', 'BTC-EUR'], retry: [] });

    expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toEqual({
      PK: 'TICKER#AAPL',
      SK: 'PROFILE',
      entityType: 'PROFILE',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      assetClass: 'STOCK',
      currency: 'USD',
      sector: 'Technology',
      country: 'United States',
      exchange: 'NASDAQ',
      peRatio: 34.2,
      fundamentalsAsOf: '2026-10-13',
      detailsAsOf: '2026-10-13',
      enrichedAt: '2026-10-13',
      profileSource: 'provider',
    });
    expect(stored(h.store, 'TICKER#BTC-EUR', 'PROFILE')).toMatchObject({ name: 'Bitcoin', assetClass: 'CRYPTO', currency: 'EUR', detailsAsOf: '2026-10-13', profileSource: 'provider' });
    expect(stored(h.store, 'TICKER#BTC-EUR', 'PROFILE')).not.toHaveProperty('peRatio');
    expect(items(h.store, 'TICKER#AAPL', 'EOD#')).toHaveLength(5);
    expect(items(h.store, 'TICKER#AAPL', 'DIV#')).toEqual([
      { PK: 'TICKER#AAPL', SK: 'DIV#2024-11-10', entityType: 'DIVIDEND_EVENT', symbol: 'AAPL', exDate: '2024-11-10', payDate: '2024-11-14', amount: 0.26, currency: 'USD' },
      { PK: 'TICKER#AAPL', SK: 'DIV#2027-01-10', entityType: 'DIVIDEND_EVENT', symbol: 'AAPL', exDate: '2027-01-10', payDate: '2027-01-14', amount: 0.27, currency: 'USD' },
    ]);
    expect(stored(h.store, 'TICKER#AAPL', 'QUOTE#LATEST')).toMatchObject({ price: 230.12, source: 'twelvedata' });
    expect(stored(h.store, 'TRACKED', 'TICKER#BTC-EUR')).toEqual({ PK: 'TRACKED', SK: 'TICKER#BTC-EUR', entityType: 'TRACKED_TICKER', symbol: 'BTC-EUR', createdAt: '2026-10-13T16:30:00.000Z', updatedAt: '2026-10-13T16:30:00.000Z' });
    expect(stored(h.store, 'TICKER#ASML.AS', 'QUOTE#LATEST')).toBeUndefined();

    // Redelivery: nothing is fetched or changed.
    const before = h.store.snapshot();
    const calls = h.fake.urls.length;
    const again = await drive(h, job, event(['AAPL', 'BTC-EUR']));
    expect(again.result).toEqual({ symbols: 2, alreadyEnriched: 2, enriched: [], retry: [] });
    expect(h.fake.urls).toHaveLength(calls);
    expect(h.store.snapshot().filter((item) => item.PK !== 'USAGE')).toEqual(before.filter((item) => item.PK !== 'USAGE'));
  });

  it('stores a London history that the broker quote shows is a hundred times too small, in the unit and currency of the quote', async () => {
    // a USD line on the London exchange: EODHD returns US dollars, the app takes every London price for pence
    const fake = new FakeFetch()
      .add('eodhd.com/api/search/IITU', [])
      .add('eodhd.com/api/eod/IITU.LSE', [{ date: '2026-10-12', close: 51 }, { date: '2026-10-13', close: 52 }])
      .add('eodhd.com/api/div/IITU.LSE', []);
    const h = harness({ fake });
    h.store.load([
      { ...baseline('IITU.L'), currency: 'USD', isin: undefined },
      { PK: 'TICKER#IITU.L', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'IITU.L', price: 52.5, previousClose: 52, currency: 'USD', asOf: '2026-10-13T16:25:00.000Z', source: 'trading212' },
    ]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['IITU.L']));
    expect(items(h.store, 'TICKER#IITU.L', 'EOD#').map((item) => [item.SK, item.close, item.currency])).toEqual([
      ['EOD#2026-10-12', 51, 'USD'],
      ['EOD#2026-10-13', 52, 'USD'],
    ]);
  });

  it('keeps an existing TRACKED item untouched', async () => {
    const h = harness({ fake: enrichFake() });
    h.store.load([{ PK: 'TRACKED', SK: 'TICKER#BTC-EUR', entityType: 'TRACKED_TICKER', symbol: 'BTC-EUR' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['BTC-EUR']));
    expect(stored(h.store, 'TRACKED', 'TICKER#BTC-EUR')).not.toHaveProperty('createdAt');
  });

  it('treats a Trading 212 baseline as not enriched yet, keeps it as the floor and does not ask EODHD for a profile it already has', async () => {
    const fake = listedFake();
    const h = harness({ fake });
    h.store.load([baseline('ASML.AS')]);
    const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['ASML.AS']));
    expect(result).toMatchObject({ alreadyEnriched: 0, enriched: ['ASML.AS'] });
    expect(fake.urls.some((url) => url.includes('/api/search/'))).toBe(false);
    // What the baseline lacks (the exchange) is filled from the symbol; nothing it has is replaced.
    expect(stored(h.store, 'TICKER#ASML.AS', 'PROFILE')).toEqual(baseline('ASML.AS', { enrichedAt: '2026-10-13', exchange: 'Euronext Amsterdam' }));
    expect(items(h.store, 'TICKER#ASML.AS', 'EOD#').length).toBeGreaterThan(0);
  });

  it('lets a provider profile override the baseline field by field (and never the reverse)', async () => {
    const h = harness({ fake: enrichFake() });
    h.store.load([{ PK: 'TICKER#AAPL', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'AAPL', name: 'Apple Inc. (broker)', assetClass: 'STOCK', currency: 'USD', isin: 'US0378331005', country: 'United States', profileSource: 'trading212' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL']));
    expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toMatchObject({ name: 'Apple Inc.', sector: 'Technology', isin: 'US0378331005', profileSource: 'provider', enrichedAt: '2026-10-13' });
  });

  it('keeps an existing quote (the Trading 212 refresh stores one) and does not ask the provider for another', async () => {
    const fake = enrichFake();
    const h = harness({ fake });
    h.store.load([{ PK: 'TICKER#AAPL', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'AAPL', price: 231, previousClose: 230, currency: 'USD', asOf: '2026-10-13T16:25:00.000Z', source: 'trading212' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL']));
    expect(fake.urls.some((url) => url.includes('twelvedata.com/quote'))).toBe(false);
    expect(stored(h.store, 'TICKER#AAPL', 'QUOTE#LATEST')).toMatchObject({ price: 231, source: 'trading212' });
  });

  describe('transient failures', () => {
    it('tries a failing symbol at most three times a day, with a growing pause, and then waits for the next day', async () => {
      const fake = enrichFake().add('twelvedata.com/time_series', { status: 503 });
      const h = harness({ fake });
      const job = createEnrichTransactionsJob(h.deps);
      const calls = (): number => fake.urls.filter((url) => url.includes('twelvedata.com/time_series')).length;
      let step = await job({ payload: event(['AAPL']) });
      expect(step).toMatchObject({ done: false, delayMs: MINUTE });
      expect(calls()).toBe(4);
      h.clock.advance(MINUTE);
      step = await job({ payload: event(['AAPL']), cursor: step.done ? undefined : step.next });
      expect(step).toMatchObject({ done: false, delayMs: 2 * MINUTE });
      h.clock.advance(2 * MINUTE);
      step = await job({ payload: event(['AAPL']), cursor: step.done ? undefined : step.next });
      expect(calls()).toBe(12);
      // The third failure used the day's tries: the next start is the next UTC day.
      expect(step).toMatchObject({ done: false, delayMs: TO_RESET - 3 * MINUTE });
      expect(stored(h.store, 'TICKER#AAPL', 'ENRICH#core')).toMatchObject({ day: '2026-10-13', attempts: MAX_ATTEMPTS_PER_DAY, symbol: 'AAPL', outcome: 'retry' });
    });

    it('gives a symbol up after MAX_ENRICH_DAYS days and reports it, with at most three tries a day', async () => {
      const fake = enrichFake().add('twelvedata.com/time_series', { status: 503 });
      const h = harness({ fake });
      const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL', 'BTC-EUR']));
      expect(result).toEqual({ symbols: 2, alreadyEnriched: 0, enriched: ['BTC-EUR'], retry: ['AAPL'] });
      const tries = fake.urls.filter((url) => url.includes('twelvedata.com/time_series')).length / 4;
      expect(tries).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_DAY * (MAX_ENRICH_DAYS + 1));
      expect(tries).toBeGreaterThan(MAX_ATTEMPTS_PER_DAY);
      expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toBeUndefined();
    });

    it('counts the tries across jobs: a second job on the same day does not touch the provider', async () => {
      const fake = enrichFake().add('twelvedata.com/time_series', { status: 503 });
      const h = harness({ fake });
      h.store.load([{ PK: 'TICKER#AAPL', SK: 'ENRICH#core', entityType: 'ENRICH_STATE', symbol: 'AAPL', day: '2026-10-13', attempts: 3 }]);
      const step = await createEnrichTransactionsJob(h.deps)({ payload: event(['AAPL']) });
      expect(step).toMatchObject({ done: false, delayMs: TO_RESET });
      expect(fake.requests).toEqual([]);
    });

    it('drops a symbol that was skipped all day instead of sleeping until tomorrow for it', async () => {
      const h = harness({ fake: enrichFake(), env: { TWELVEDATA_API_KEY: '', ALPHAVANTAGE_API_KEY: '' } });
      h.store.load([{ PK: 'TICKER#AAPL', SK: 'ENRICH#core', entityType: 'ENRICH_STATE', symbol: 'AAPL', day: '2026-10-13', attempts: 3, outcome: 'skipped' }]);
      expect(await createEnrichTransactionsJob(h.deps)({ payload: event(['AAPL']) })).toMatchObject({ done: true, result: { symbols: 1, enriched: [], retry: [] } });
      expect(h.fake.requests).toEqual([]);
    });

    it('starts the tries of a new day from zero', async () => {
      const fake = enrichFake();
      const h = harness({ fake });
      h.store.load([{ PK: 'TICKER#AAPL', SK: 'ENRICH#core', entityType: 'ENRICH_STATE', symbol: 'AAPL', day: '2026-10-12', attempts: 3 }]);
      expect((await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL']))).result.enriched).toEqual(['AAPL']);
    });

    it('succeeds in a later try once the provider recovers', async () => {
      const fake = enrichFake().add('twelvedata.com/time_series', { status: 503 });
      const h = harness({ fake });
      const job = createEnrichTransactionsJob(h.deps);
      const first = await job({ payload: event(['AAPL']) });
      expect(first).toMatchObject({ done: false, delayMs: MINUTE });
      fake.add('twelvedata.com/time_series', { meta: { currency: 'USD' }, values: days(5) });
      h.clock.advance(MINUTE);
      const second = await job({ payload: event(['AAPL']), cursor: first.done ? undefined : first.next });
      expect(second).toMatchObject({ done: true, result: { enriched: ['AAPL'], retry: [] } });
    });

    it('retries a storage failure like any other transient failure', async () => {
      const storage = harness({ fake: enrichFake() });
      vi.spyOn(storage.store, 'batchWrite').mockRejectedValue(new Error('throttled'));
      expect((await drive(storage, createEnrichTransactionsJob(storage.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: ['AAPL'] });
    });
  });

  describe('provider limits', () => {
    it('waits for the next minute when Twelve Data runs out of credits, without spending a try, and lets other symbols go on', async () => {
      const limit = { status: 'error', code: 429, message: 'You have run out of API credits for the current minute.' };
      const fake = enrichFake().add('twelvedata.com/time_series', limit, { meta: { currency: 'USD' }, values: days(5) });
      const h = harness({ fake });
      const job = createEnrichTransactionsJob(h.deps);
      const first = await job({ payload: event(['AAPL', 'BTC-EUR']) });
      // BTC-EUR (CoinGecko) was enriched in the same step; AAPL waits for the minute to turn over.
      expect(first).toMatchObject({ done: false, delayMs: 61_000 });
      expect(stored(h.store, 'TICKER#BTC-EUR', 'PROFILE')).toBeDefined();
      expect(stored(h.store, 'TICKER#AAPL', 'ENRICH#core')).toBeUndefined();
      expect(stored(h.store, 'USAGE', 'BLOCK#twelvedata')).toMatchObject({ provider: 'twelvedata', scope: 'minute', until: NOW.getTime() + 61_000 });
      h.clock.advance(61_000);
      const second = await job({ payload: event(['AAPL']), cursor: first.done ? undefined : first.next });
      expect(second).toMatchObject({ done: true, result: { enriched: ['AAPL', 'BTC-EUR'] } });
    });

    it('does not ask a provider that said its daily limit is reached, in this job or in any later one, until the reset', async () => {
      const fake = listedFake().add('eodhd.com/api/eod/ASML.AS', { status: 402 });
      const h = harness({ fake });
      const job = createEnrichTransactionsJob(h.deps);
      const first = await job({ payload: event(['ASML.AS']) });
      expect(first).toMatchObject({ done: false, delayMs: TO_RESET });
      expect(stored(h.store, 'USAGE', 'BLOCK#eodhd')).toMatchObject({ scope: 'day', until: NOW.getTime() + TO_RESET });
      expect(stored(h.store, 'TICKER#ASML.AS', 'ENRICH#core')).toBeUndefined();
      const requests = fake.requests.length;

      // A new job (the next sync) finds the block and makes no request at all.
      const later = await createEnrichTransactionsJob(h.deps)({ payload: event(['ASML.AS']) });
      expect(later).toMatchObject({ done: false, delayMs: TO_RESET });
      expect(fake.requests).toHaveLength(requests);

      // After the reset the same job finishes.
      fake.add('eodhd.com/api/eod/ASML.AS', [{ date: '2026-10-14', close: 12 }]);
      h.clock.advance(TO_RESET);
      const done = await job({ payload: event(['ASML.AS']), cursor: first.done ? undefined : first.next });
      expect(done).toMatchObject({ done: true, result: { enriched: ['ASML.AS'], retry: [] } });
    });

    it('sleeps without a request when the provider quota of the day is used up (client-side ledger)', async () => {
      const fake = listedFake();
      const h = harness({ fake, env: { EODHD_DAILY_LIMIT: '1' } });
      const first = await createEnrichTransactionsJob(h.deps)({ payload: event(['ASML.AS']) });
      // history used the single call of the day; the profile (search) call is refused and left to the details refresh.
      expect(first).toMatchObject({ done: true });
      expect(fake.urls.filter((url) => url.includes('eodhd.com'))).toHaveLength(1);
      expect(stored(h.store, 'USAGE', 'BLOCK#eodhd')).toMatchObject({ scope: 'day' });
      expect(stored(h.store, 'TICKER#ASML.AS', 'PROFILE')).toMatchObject({ profileSource: 'minimal', enrichedAt: '2026-10-13' });
    });

    it('leaves dividends to the calendar refresh when EODHD is limited, without retrying the symbol', async () => {
      const fake = enrichFake().add('eodhd.com/api/div/AAPL.US', { status: 402 });
      const h = harness({ fake });
      const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL']));
      expect(result).toMatchObject({ enriched: ['AAPL'], retry: [] });
      expect(items(h.store, 'TICKER#AAPL', 'DIV#')).toEqual([]);
      expect(stored(h.store, 'USAGE', 'BLOCK#eodhd')).toBeDefined();
    });

    it('stores the history of every symbol before it spends the quota on dividends', async () => {
      const fake = listedFake('ASML', 'AS', enrichFake());
      const h = harness({ fake });
      await drive(h, createEnrichTransactionsJob(h.deps), event(['ASML.AS', 'AAPL']));
      const order = fake.urls.map((url) => /(time_series|\/eod\/|\/div\/)/.exec(url)?.[1]).filter((kind) => kind !== undefined);
      expect(order.indexOf('/div/')).toBeGreaterThan(order.lastIndexOf('time_series'));
      expect(order.indexOf('/div/')).toBeGreaterThan(order.lastIndexOf('/eod/'));
    });

    it('waits as long as a client-side rate limit names, and a minute for a limit that names nothing', async () => {
      const source = (error: RateLimitError): PriceSource => ({
        name: 'live',
        getQuotes: vi.fn(),
        getEodHistory: vi.fn().mockRejectedValue(error),
        getProfile: vi.fn(),
        getDividends: vi.fn(),
      });
      const run = (error: RateLimitError) => {
        const h = harness({ fake: enrichFake(), marketData: () => ({ provider: source(error), fx: {} as never }) });
        return createEnrichTransactionsJob(h.deps)({ payload: event(['AAPL']) });
      };
      expect(await run(new RateLimitError('client-side rate limit', { retryAfterMs: 5000 }))).toMatchObject({ done: false, delayMs: 5000 });
      expect(await run(new RateLimitError('too many requests'))).toMatchObject({ done: false, delayMs: MINUTE });
      expect(await run(new RateLimitError('too fast', { provider: 'twelvedata', retryAfterMs: 10 }))).toMatchObject({ done: false, delayMs: 1000 });
    });
  });

  it('skips unknown symbols and symbols without a provider, storing nothing but the try', async () => {
    const unknown = harness({ fake: enrichFake().add('twelvedata.com/time_series', { code: 404, status: 'error' }) });
    expect((await drive(unknown, createEnrichTransactionsJob(unknown.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: [] });
    expect(unknown.store.snapshot().filter((item) => item.PK !== 'USAGE' && item.SK !== 'ENRICH#core')).toEqual([]);
    expect(stored(unknown.store, 'TICKER#AAPL', 'ENRICH#core')).toMatchObject({ attempts: 1, day: '2026-10-13', outcome: 'skipped' });

    const nokey = harness({ fake: enrichFake(), env: { TWELVEDATA_API_KEY: '', ALPHAVANTAGE_API_KEY: '' } });
    expect((await drive(nokey, createEnrichTransactionsJob(nokey.deps), event(['AAPL', 'BTC-EUR']))).result).toMatchObject({ enriched: ['BTC-EUR'], retry: [] });
    expect(stored(nokey.store, 'TICKER#AAPL', 'PROFILE')).toBeUndefined();
  });

  it('skips a symbol with a permanent provider error and tolerates permanent dividend errors', async () => {
    const permanent = harness({ fake: enrichFake().add('twelvedata.com/time_series', { status: 400 }) });
    expect((await drive(permanent, createEnrichTransactionsJob(permanent.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: [] });

    const noDividends = harness({ fake: enrichFake().add('eodhd.com/api/div/AAPL.US', { status: 403 }) });
    expect((await drive(noDividends, createEnrichTransactionsJob(noDividends.deps), event(['AAPL']))).result).toMatchObject({ enriched: ['AAPL'] });
    expect(items(noDividends.store, 'TICKER#AAPL', 'DIV#')).toEqual([]);
  });

  it('does not fail the enrichment of a symbol whose profile lookup fails: the details refresh gets it later', async () => {
    const h = harness({ fake: enrichFake().add('alphavantage.co', { status: 500 }).add('twelvedata.com/stocks', { status: 500 }), env: { ALPHAVANTAGE_API_KEY: '' } });
    const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL']));
    expect(result).toMatchObject({ enriched: ['AAPL'], retry: [] });
    expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toMatchObject({ name: 'AAPL', assetClass: 'OTHER', profileSource: 'minimal', enrichedAt: '2026-10-13' });
    expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).not.toHaveProperty('detailsAsOf');
  });

  it('falls back to the minimal profile and to a quote derived from the history', async () => {
    const fake = new FakeFetch()
      .add('eodhd.com/api/search/NOPROF', [])
      .add('eodhd.com/api/eod/NOPROF.AS', [{ date: '2026-10-12', close: 10 }, { date: '2026-10-13', close: 11 }])
      .add('eodhd.com/api/div/NOPROF.AS', [])
      .add('eodhd.com/api/real-time/NOPROF.AS', { status: 404 });
    const h = harness({ fake });
    const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['NOPROF.AS']));
    expect(result.enriched).toEqual(['NOPROF.AS']);
    expect(stored(h.store, 'TICKER#NOPROF.AS', 'PROFILE')).toEqual({
      PK: 'TICKER#NOPROF.AS',
      SK: 'PROFILE',
      entityType: 'PROFILE',
      symbol: 'NOPROF.AS',
      name: 'NOPROF.AS',
      assetClass: 'OTHER',
      currency: 'EUR',
      country: 'Netherlands',
      exchange: 'Euronext Amsterdam',
      profileSource: 'minimal',
      enrichedAt: '2026-10-13',
    });
    expect(stored(h.store, 'TICKER#NOPROF.AS', 'QUOTE#LATEST')).toMatchObject({ price: 11, previousClose: 10, source: 'live-eod', asOf: '2026-10-13T00:00:00.000Z' });
  });

  it('stores no quote when neither the provider nor the history has one', async () => {
    const fake = new FakeFetch().add('eodhd.com/api/search/EMPTY', []).add('eodhd.com/api/eod/EMPTY.AS', []).add('eodhd.com/api/div/EMPTY.AS', []).add('eodhd.com/api/real-time/EMPTY.AS', { status: 404 });
    const h = harness({ fake });
    expect((await drive(h, createEnrichTransactionsJob(h.deps), event(['EMPTY.AS']))).result.enriched).toEqual(['EMPTY.AS']);
    expect(stored(h.store, 'TICKER#EMPTY.AS', 'QUOTE#LATEST')).toBeUndefined();
  });

  it('continues in the next step when the budget runs out, and refuses a budget that can never be enough', async () => {
    const h = harness({ fake: enrichFake(), stepSubrequests: 4 });
    const { result, steps } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL', 'BTC-EUR']));
    expect(result.enriched).toEqual(['AAPL', 'BTC-EUR']);
    expect(steps.length).toBeGreaterThan(1);

    const tiny = harness({ fake: enrichFake(), stepSubrequests: 1 });
    await expect(createEnrichTransactionsJob(tiny.deps)({ payload: event(['AAPL']) })).rejects.toThrow('too small');
  });

  it('continues a job whose cursor was written by the first version of the state', async () => {
    const h = harness({ fake: enrichFake() });
    const cursor = JSON.stringify({ v: 1, now: NOW.toISOString(), total: 2, already: 0, pending: ['BTC-EUR'], enriched: [], failedNow: ['AAPL'], round: 2, notBefore: 0 });
    const step = await createEnrichTransactionsJob(h.deps)({ payload: event([]), cursor });
    expect(step).toMatchObject({ done: true, result: { symbols: 2, enriched: ['AAPL', 'BTC-EUR'], retry: [] } });
  });

  it('finishes at once without symbols and fails the step (for redelivery) when the profile lookup fails', async () => {
    const h = harness({ fake: enrichFake() });
    expect((await drive(h, createEnrichTransactionsJob(h.deps), event([]))).result).toEqual({ symbols: 0, alreadyEnriched: 0, enriched: [], retry: [] });
    expect(h.fake.requests).toEqual([]);
    vi.spyOn(h.store, 'getMany').mockRejectedValue(new Error('throttled'));
    await expect(createEnrichTransactionsJob(h.deps)({ payload: event(['AAPL']) })).rejects.toThrow('throttled');
  });

  it('only ever sees market symbols', () => {
    expect(enrichmentSymbols([' aapl ', '', 3, 'sap.de', 'CASH.EUR', 'CUSTOM:abc', 'AAPL', null])).toEqual(['AAPL', 'SAP.DE']);
    expect(NOW.getTime()).toBe(NOW_SECONDS * 1000);
  });

  it('derives a quote from the newest two EOD rows', () => {
    expect(quoteFromHistory('X', [], 'p')).toBeNull();
    expect(quoteFromHistory('X', [{ symbol: 'X', date: '2026-10-13', close: 5, currency: 'EUR' }], 'p')).toMatchObject({ price: 5, previousClose: 5, source: 'p-eod' });
  });
});
