import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError, ProviderUnavailableError, RateLimitError, RetryableProviderError, SymbolNotFoundError } from '../errors.js';
import { HttpClient } from '../http.js';
import { DailyQuota, MemoryQuotaLedger, TokenBucket } from '../limits.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { AlphaVantageProvider } from './alphavantage.js';
import { failureOf, notFound, quotesToBatch, type PriceBatch, type PriceSource } from './base.js';
import { CoinGeckoProvider, coinIds } from './coingecko.js';
import { EodhdProvider } from './eodhd.js';
import { RoutingProvider } from './routing.js';
import { TwelveDataProvider } from './twelvedata.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const noSleep = (): Promise<void> => Promise.resolve();
const http = (fake: FakeFetch, name: string) => new HttpClient({ provider: name, fetch: fake.fetch, sleep: noSleep, maxRetries: 0, random: () => 0 });
const bucket = (maxWaitMs?: number, capacity = 100) => new TokenBucket(capacity, capacity, () => 0, noSleep, maxWaitMs);
const quota = (name: string, limit: number) => new DailyQuota(new MemoryQuotaLedger(), name, limit, () => '2026-10-13');

describe('quota and pacing', () => {
  it('fails the batch of a provider whose daily quota is used up, without a request', async () => {
    const fake = new FakeFetch();
    const eodhd = new EodhdProvider({ apiKey: 'k', http: http(fake, 'eodhd'), bucket: bucket(), quota: quota('eodhd', 1), now: () => NOW });
    const batch = await eodhd.getQuotes(['ASML.AS', 'SAP.DE']);
    expect(batch.failed.map((f) => [f.symbol, f.kind, f.retryable])).toEqual([['ASML.AS', 'rate-limited', true], ['SAP.DE', 'rate-limited', true]]);
    expect(fake.requests).toEqual([]);
    const twelve = new TwelveDataProvider({ apiKey: 'k', http: http(fake, 'twelvedata'), bucket: bucket(), quota: quota('twelvedata', 1), now: () => NOW });
    expect((await twelve.getQuotes(['A', 'B'])).failed.every((f) => f.kind === 'rate-limited')).toBe(true);
  });

  it('turns a too long client-side wait into a rate limit instead of sleeping', async () => {
    const fake = new FakeFetch().add('twelvedata', {});
    const twelve = new TwelveDataProvider({ apiKey: 'k', http: http(fake, 'twelvedata'), bucket: new TokenBucket(1, 1 / 60, () => 0, noSleep, 1000), quota: quota('twelvedata', 100), now: () => NOW });
    await expect(twelve.getEodHistory('AAPL', '2026-01-01', '2026-10-13')).resolves.toEqual([]);
    await expect(twelve.getEodHistory('AAPL', '2026-01-01', '2026-10-13')).rejects.toMatchObject({ name: 'RateLimitError', retryAfterMs: 60_000 });
  });

  it('takes a unit that is not a symbol batch through without quota use for Twelve Data reference lookups', async () => {
    const fake = new FakeFetch().add('/profile', { code: 403, status: 'error' }).add('/stocks', { data: [] }).add('/etfs', { data: [{ name: 'Fund', currency: 'usd', country: 'Ireland', exchange: 'NYSE' }] });
    const used = quota('twelvedata', 100);
    const spy = vi.spyOn(used, 'consume');
    const twelve = new TwelveDataProvider({ apiKey: 'k', http: http(fake, 'twelvedata'), bucket: bucket(), quota: used, now: () => NOW });
    expect(await twelve.getProfile('FND')).toEqual({ symbol: 'FND', name: 'Fund', assetClass: 'ETF', currency: 'USD', country: 'Ireland', exchange: 'NYSE' });
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('Twelve Data', () => {
  it('rethrows a retryable profile failure and survives an unexpected body', async () => {
    const down = new FakeFetch().add('/profile', { status: 503 });
    const twelve = new TwelveDataProvider({ apiKey: 'k', http: http(down, 'twelvedata'), bucket: bucket(), quota: quota('twelvedata', 100), now: () => NOW });
    await expect(twelve.getProfile('AAPL')).rejects.toBeInstanceOf(RetryableProviderError);
    const odd = new FakeFetch().add('/quote', 'garbage').add('/time_series', ['x']);
    const other = new TwelveDataProvider({ apiKey: 'k', http: http(odd, 'twelvedata'), bucket: bucket(), quota: quota('twelvedata', 100), now: () => NOW });
    expect((await other.getQuotes(['A', 'B'])).failed).toHaveLength(2);
    expect(await other.getEodHistory('A', '2026-01-01', '2026-02-01')).toEqual([]);
  });
});

describe('Alpha Vantage', () => {
  it('serves profiles only', async () => {
    const av = new AlphaVantageProvider({ apiKey: 'k', http: http(new FakeFetch(), 'alphavantage'), bucket: bucket(), quota: quota('alphavantage', 25), now: () => NOW });
    await expect(av.getEodHistory('AAPL')).rejects.toBeInstanceOf(ProviderError);
    await expect(av.getDividends('AAPL')).rejects.toThrow('profiles only');
  });

  it('reads a body that is not an object as "unknown symbol"', async () => {
    const av = new AlphaVantageProvider({ apiKey: 'k', http: http(new FakeFetch().add('OVERVIEW', ['x']), 'alphavantage'), bucket: bucket(), quota: quota('alphavantage', 25), now: () => NOW });
    expect(await av.getProfile('AAPL')).toBeNull();
  });
});

describe('CoinGecko', () => {
  it('asks for at most 50 coins per request', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `C${i}=coin-${i}`).join(',');
    const symbols = Array.from({ length: 51 }, (_, i) => `C${i}-EUR`);
    const fake = new FakeFetch().add('simple/price', Object.fromEntries(symbols.map((_, i) => [`coin-${i}`, { eur: i + 1 }])));
    const cg = new CoinGeckoProvider({ apiKey: 'k', http: http(fake, 'coingecko'), bucket: bucket(), now: () => NOW, extraCoinIds: ids });
    const batch = await cg.getQuotes(symbols);
    expect(Object.keys(batch.quotes)).toHaveLength(51);
    expect(fake.requests).toHaveLength(2);
  });

  it('extends the coin map from the configuration', () => {
    expect(coinIds('AVAX=avalanche-2, link = ChainLink ,bad')).toMatchObject({ BTC: 'bitcoin', AVAX: 'avalanche-2', LINK: 'chainlink' });
    expect(coinIds()).not.toHaveProperty('AVAX');
  });

  it('reads an unexpected answer as no quote', async () => {
    const cg = new CoinGeckoProvider({ apiKey: 'k', http: http(new FakeFetch().add('simple/price', [1]).add('market_chart', null), 'coingecko'), bucket: bucket(), now: () => NOW });
    expect((await cg.getQuotes(['BTC-EUR'])).failed).toHaveLength(1);
    expect(await cg.getEodHistory('BTC-EUR', '2026-10-01', '2026-10-13')).toEqual([]);
  });
});

describe('quote batches', () => {
  it('builds failures from errors and lets bugs propagate', async () => {
    expect(failureOf('X', new RateLimitError('q'))).toMatchObject({ kind: 'rate-limited', retryable: true });
    expect(failureOf('X', new ProviderError('q'))).toMatchObject({ kind: 'error', retryable: false });
    expect(notFound('p', 'X')).toMatchObject({ kind: 'not-found', error: 'p: no quote for X' });
    await expect(quotesToBatch('p', ['A'], () => Promise.reject(new TypeError('bug')))).rejects.toThrow('bug');
  });
});

describe('routing provider', () => {
  const quote = (symbol: string, source: string): Quote => ({ symbol, price: 1, previousClose: 1, currency: 'USD', asOf: '2026-10-13T00:00:00.000Z', source });
  const profile = (symbol: string, name: string): InstrumentProfile => ({ symbol, name, assetClass: 'STOCK', currency: 'USD' });

  interface FakeOptions {
    error?: Error;
    profile?: InstrumentProfile | null;
    quoteError?: Error;
  }
  const NO_OPTIONS: FakeOptions = {};

  class FakeSource implements PriceSource {
    readonly calls: [string, unknown][] = [];

    constructor(
      readonly name: string,
      private readonly options: FakeOptions = NO_OPTIONS,
    ) {}

    getQuotes(symbols: readonly string[]): Promise<PriceBatch> {
      this.calls.push(['quotes', [...symbols]]);
      if (this.options.quoteError) return Promise.reject(this.options.quoteError);
      const found = symbols.filter((s) => s !== 'GONE');
      return Promise.resolve({ quotes: Object.fromEntries(found.map((s) => [s, quote(s, this.name)])), failed: [], unavailable: [] });
    }

    getEodHistory(symbol: string): Promise<EodPrice[]> {
      this.calls.push(['eod', symbol]);
      return Promise.resolve([{ symbol, date: '2026-10-13', close: 1, currency: 'USD' }]);
    }

    getProfile(symbol: string): Promise<InstrumentProfile | null> {
      this.calls.push(['profile', symbol]);
      if (this.options.error) return Promise.reject(this.options.error);
      return Promise.resolve(this.options.profile ?? null);
    }

    getDividends(symbol: string): Promise<DividendEvent[]> {
      this.calls.push(['div', symbol]);
      return Promise.resolve([{ symbol, exDate: '2026-10-13', amount: 0.1, currency: 'USD' }]);
    }
  }

  it('dispatches by symbol type', async () => {
    const td = new FakeSource('twelvedata');
    const eod = new FakeSource('eodhd');
    const cg = new FakeSource('coingecko');
    const av = new FakeSource('alphavantage', { profile: profile('AAPL', 'Apple') });
    const router = new RoutingProvider({ twelvedata: td, eodhd: eod, coingecko: cg, alphavantage: av });
    const batch = await router.getQuotes(['AAPL', 'ASML.AS', 'BTC-EUR', 'MSFT', 'GONE']);
    expect(Object.keys(batch.quotes).toSorted()).toEqual(['AAPL', 'ASML.AS', 'BTC-EUR', 'MSFT']);
    expect(batch.failed).toEqual([expect.objectContaining({ symbol: 'GONE', kind: 'not-found' })]);
    expect(td.calls).toEqual([['quotes', ['AAPL', 'MSFT', 'GONE']]]);
    expect(eod.calls).toEqual([['quotes', ['ASML.AS']]]);
    expect(cg.calls).toEqual([['quotes', ['BTC-EUR']]]);

    await router.getEodHistory('SAP.DE', '2026-10-13', '2026-10-13');
    await router.getEodHistory('AAPL', '2026-10-13', '2026-10-13');
    await router.getEodHistory('ETH-EUR', '2026-10-13', '2026-10-13');
    expect([eod.calls.at(-1), td.calls.at(-1), cg.calls.at(-1)]).toEqual([['eod', 'SAP.DE'], ['eod', 'AAPL'], ['eod', 'ETH-EUR']]);

    expect((await router.getProfile('AAPL'))!.name).toBe('Apple');
    expect(td.calls.some(([kind]) => kind === 'profile')).toBe(false);
    await router.getProfile('ASML.AS');
    await router.getProfile('BTC-EUR');
    expect([eod.calls.at(-1), cg.calls.at(-1)]).toEqual([['profile', 'ASML.AS'], ['profile', 'BTC-EUR']]);

    expect((await router.getDividends('AAPL', '2026-01-01', '2026-12-31'))[0]!.symbol).toBe('AAPL');
    expect(eod.calls.at(-1)).toEqual(['div', 'AAPL']);
    expect(await router.getDividends('BTC-EUR', '2026-01-01', '2026-12-31')).toEqual([]);
  });

  it('falls back from Alpha Vantage to Twelve Data for US profiles', async () => {
    const td = new FakeSource('twelvedata', { profile: profile('SPY', 'SPDR') });
    expect((await new RoutingProvider({ twelvedata: td, alphavantage: new FakeSource('alphavantage') }).getProfile('SPY'))!.name).toBe('SPDR');
    expect((await new RoutingProvider({ twelvedata: td, alphavantage: new FakeSource('alphavantage', { error: new RateLimitError('x') }) }).getProfile('SPY'))!.name).toBe('SPDR');
    await expect(new RoutingProvider({ alphavantage: new FakeSource('alphavantage', { error: new RateLimitError('x') }) }).getProfile('SPY')).rejects.toBeInstanceOf(RateLimitError);
    await expect(new RoutingProvider({ alphavantage: new FakeSource('alphavantage', { error: new TypeError('bug') }), twelvedata: td }).getProfile('SPY')).rejects.toThrow('bug');
    expect(await new RoutingProvider({ twelvedata: new FakeSource('twelvedata') }).getProfile('SPY')).toBeNull();
    expect(await new RoutingProvider({ alphavantage: new FakeSource('alphavantage') }).getProfile('SPY')).toBeNull();
  });

  it('skips symbols whose provider has no API key, warning once', async () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), appendKeys: vi.fn(), removeKeys: vi.fn(), createChild: vi.fn() };
    const router = new RoutingProvider({ twelvedata: new FakeSource('twelvedata') }, logger);
    const batch = await router.getQuotes(['AAPL', 'ASML.AS', 'BTC-EUR']);
    expect(Object.keys(batch.quotes)).toEqual(['AAPL']);
    expect(batch.unavailable.toSorted()).toEqual(['ASML.AS', 'BTC-EUR']);
    expect(batch.failed).toEqual([]);
    await expect(router.getEodHistory('ASML.AS', 'a', 'b')).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(new RoutingProvider({}).getProfile('AAPL')).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(await router.getDividends('AAPL', 'a', 'b')).toEqual([]);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('missing API key')).map(([, fields]) => (fields as { provider: string }).provider).toSorted()).toEqual(['coingecko', 'eodhd']);
  });

  it('marks the whole group failed when a source raises a provider error', async () => {
    const error = new RetryableProviderError('503');
    const router = new RoutingProvider({ twelvedata: new FakeSource('twelvedata', { quoteError: error }), eodhd: new FakeSource('eodhd') });
    const batch = await router.getQuotes(['AAPL', 'MSFT', 'ASML.AS']);
    expect(batch.failed.map((f) => f.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(Object.keys(batch.quotes)).toEqual(['ASML.AS']);
    await expect(new RoutingProvider({ twelvedata: new FakeSource('twelvedata', { quoteError: new TypeError('bug') }) }).getQuotes(['AAPL'])).rejects.toThrow('bug');
    expect(new SymbolNotFoundError('x')).toBeInstanceOf(ProviderError);
  });
});
