import { MemoryItemStore, type Logger } from '@portfolio/platform';
import { describe, expect, it, vi } from 'vitest';
import { makeQuote, normalizeCurrency } from './models.js';
import { DEFAULT_CALENDAR_SETTINGS, parseCalendarSettings, parsePricesConfig } from './config.js';
import { csvRecords, parseCsv } from './csv.js';
import { errorMessage, errorName, ProviderError, RateLimitError, RetryableProviderError, SubrequestBudgetError, SymbolNotFoundError } from './errors.js';
import { HttpClient, budgetedFetch, buildUrl, redactUrl, type FetchLike } from './http.js';
import { DailyQuota, MemoryQuotaLedger, StoreQuotaLedger, TokenBucket } from './limits.js';
import { asFloat, byText, cleanText, dayOf, definedOnly, isoDateOrNull, ownValue, positiveNumber, titleCase, validIsin } from './parse.js';
import { cryptoParts, minimalProfile, normalizeSymbol, routeOf } from './symbols.js';
import { addDays, amsterdamHour, daysBetweenDays, fromEpochSeconds, hourIn, isWeekday, utcDay, weekdayOf, zonedTimeToUtc } from './time.js';
import { FakeFetch } from './testing/fake-fetch.js';

const noSleep = (): Promise<void> => Promise.resolve();
const SECRET = 'sup3r-s3cret-key';

const NO_OVERRIDES: Partial<ConstructorParameters<typeof HttpClient>[0]> = {};

function client(fake: FakeFetch, overrides = NO_OVERRIDES): { http: HttpClient; sleeps: number[] } {
  const sleeps: number[] = [];
  const http = new HttpClient({ provider: 'p', fetch: fake.fetch, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), random: () => 0.5, maxRetries: 3, ...overrides });
  return { http, sleeps };
}

describe('errors', () => {
  it('knows which failures are worth a retry', () => {
    expect(new ProviderError('x').retryable).toBe(false);
    expect(new SymbolNotFoundError('x').retryable).toBe(false);
    expect(new RetryableProviderError('x').retryable).toBe(true);
    expect(new RateLimitError('x', { retryAfterMs: 5 })).toMatchObject({ retryable: true, retryAfterMs: 5, name: 'RateLimitError' });
    expect(new SubrequestBudgetError(3).message).toContain('3');
  });

  it('names and describes any thrown value', () => {
    expect(errorName(new RateLimitError('x'))).toBe('RateLimitError');
    expect(errorName('boom')).toBe('string');
    expect(errorMessage(new Error('m'))).toBe('m');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('http', () => {
  it('redacts credential-like query parameters', () => {
    const url = `https://x.test/a?symbol=AAPL&api_token=${SECRET}&apikey=${SECRET}&fmt=json&s=A,B`;
    expect(redactUrl(url)).toBe('https://x.test/a?symbol=AAPL&api_token=***&apikey=***&fmt=json&s=A,B');
    expect(redactUrl('https://x.test/a')).toBe('https://x.test/a');
    expect(redactUrl('https://x.test/a?flag&token=1')).toBe('https://x.test/a?flag&token=***');
  });

  it('builds urls with readable commas and without empty parameters', () => {
    expect(buildUrl('https://x.test/q', { s: 'A,B', n: 5, skip: undefined, none: null, text: 'a b&c' })).toBe('https://x.test/q?s=A,B&n=5&text=a%20b%26c');
    expect(buildUrl('https://x.test/q?a=1', { b: 2 })).toBe('https://x.test/q?a=1&b=2');
    expect(buildUrl('https://x.test/q')).toBe('https://x.test/q');
  });

  it('retries 429 and 5xx with backoff, logs without the key, and succeeds', async () => {
    const fake = new FakeFetch().add('x.test', { status: 429 }, { status: 503 }, { ok: true });
    const warn = vi.fn();
    const logger = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn(), appendKeys: vi.fn(), removeKeys: vi.fn(), createChild: vi.fn() } as unknown as Logger;
    const { http, sleeps } = client(fake, { logger });
    await expect(http.getJson('https://x.test/q', { apikey: SECRET, s: 'A,B' })).resolves.toEqual({ ok: true });
    expect(fake.requests).toHaveLength(3);
    expect(sleeps).toEqual([0, 0]); // the fake answers with `Retry-After: 0`
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(warn.mock.calls)).toContain('apikey=***');
    expect(fake.urls[0]).toContain('s=A,B');
  });

  it('raises a RateLimitError once the retries are used up, without the key in the message', async () => {
    const fake = new FakeFetch().add('x.test', { status: 429 });
    const { http } = client(fake, { maxRetries: 2 });
    const error = await http.getJson('https://x.test/q', { api_token: SECRET }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryable: true, status: 429 });
    expect((error as Error).message).not.toContain(SECRET);
    expect(fake.requests).toHaveLength(3);
  });

  it('treats 5xx as retryable but not as a rate limit, and 404 and other statuses as terminal', async () => {
    const down = client(new FakeFetch().add('x.test', { status: 502 }), { maxRetries: 1 });
    const error = await down.http.getJson('https://x.test/q').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).not.toBeInstanceOf(RateLimitError);

    const fake = new FakeFetch().add('/missing', { status: 404 }).add('/bad', { status: 400 });
    const { http, sleeps } = client(fake);
    await expect(http.getJson('https://x.test/missing', undefined, undefined, 'X')).rejects.toMatchObject({ name: 'SymbolNotFoundError', symbol: 'X', status: 404 });
    await expect(http.getJson('https://x.test/bad')).rejects.toMatchObject({ name: 'ProviderError', retryable: false, status: 400 });
    expect(sleeps).toEqual([]);
    expect(fake.requests).toHaveLength(2);
  });

  it('retries network errors and timeouts', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    const fake = new FakeFetch().add('x.test', new TypeError('fetch failed'), timeout, { a: 1 });
    const { http } = client(fake);
    await expect(http.getJson('https://x.test/q')).resolves.toEqual({ a: 1 });
    const failing = client(new FakeFetch().add('x.test', timeout), { maxRetries: 0 });
    await expect(failing.http.getJson('https://x.test/q')).rejects.toThrow('network error for https://x.test/q: TimeoutError');
    const odd = client(new FakeFetch().add('x.test', Object.assign(new Error('x'), { name: '' })), { maxRetries: 0 });
    await expect(odd.http.getJson('https://x.test/q')).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it('rejects invalid JSON, reads empty bodies as null and a failing body read as a network error', async () => {
    await expect(client(new FakeFetch().add('x.test', { text: '<html>' })).http.getJson('https://x.test/q', { apikey: SECRET })).rejects.toThrow('invalid JSON from https://x.test/q?apikey=***');
    await expect(client(new FakeFetch().add('x.test', { text: '' })).http.getJson('https://x.test/q')).resolves.toBeNull();
    const broken: FetchLike = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error('reset')) } as unknown as Response);
    await expect(client(new FakeFetch(), { fetch: broken, maxRetries: 0 }).http.getText('https://x.test/q')).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it('computes the backoff from Retry-After, falling back to exponential jitter', () => {
    const { http } = client(new FakeFetch(), { backoffBaseMs: 1000, backoffMaxMs: 4000, random: () => 0.5 });
    expect(http.backoffMs(1, null)).toBe(750);
    expect(http.backoffMs(2, null)).toBe(1500);
    expect(http.backoffMs(6, null)).toBe(3000);
    expect(http.backoffMs(1, '2')).toBe(2000);
    expect(http.backoffMs(1, '99')).toBe(4000);
    expect(http.backoffMs(1, 'soon')).toBe(750);
    expect(http.backoffMs(1, '-1')).toBe(750);
    expect(http.backoffMs(1, ' ')).toBe(750);
    const defaults = new HttpClient({ provider: 'p', fetch: new FakeFetch().fetch, sleep: noSleep });
    const delay = defaults.backoffMs(1, null);
    expect(delay).toBeGreaterThanOrEqual(125);
    expect(delay).toBeLessThanOrEqual(500);
  });

  it('gives every request a timeout signal', async () => {
    const fake = new FakeFetch().add('x.test', {});
    const signal = new AbortController().signal;
    const custom = new HttpClient({ provider: 'p', fetch: fake.fetch, sleep: noSleep, timeoutMs: 5, timeoutSignal: () => signal });
    await custom.getJson('https://x.test/q');
    expect(fake.requests[0]!.signal).toBe(signal);
    await new HttpClient({ provider: 'p', fetch: fake.fetch, sleep: noSleep }).getJson('https://x.test/q');
    expect(fake.requests[1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('stops at the subrequest budget without retrying it', async () => {
    const fake = new FakeFetch().add('x.test', { ok: true });
    const budget = budgetedFetch(fake.fetch, 1);
    const { http } = client(fake, { fetch: budget.fetch });
    await http.getJson('https://x.test/a');
    expect([budget.used(), budget.remaining(), budget.limit]).toEqual([1, 0, 1]);
    await expect(http.getJson('https://x.test/b')).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('limits', () => {
  it('waits for tokens like the Python bucket', async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = new TokenBucket(8, 8 / 60, () => now, (ms) => (slept.push(ms), (now += ms), Promise.resolve()));
    expect(await bucket.acquire(8)).toBe(0);
    expect(await bucket.acquire(4)).toBeCloseTo(30_000);
    expect(slept).toHaveLength(1);
    await expect(bucket.acquire(9)).rejects.toThrow(RangeError);
  });

  it('raises a RateLimitError instead of sleeping longer than allowed', async () => {
    const bucket = new TokenBucket(1, 1 / 60, () => 0, noSleep, 1000);
    await bucket.acquire();
    const error = await bucket.acquire().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(60_000);
  });

  describe.each([
    ['memory', () => new MemoryQuotaLedger()],
    ['store', () => new StoreQuotaLedger(new MemoryItemStore())],
  ])('%s quota ledger', (_name, create) => {
    const key = { PK: 'USAGE', SK: 'p' };

    it('spends per day, refuses over the limit and starts a new day at zero', async () => {
      const ledger = create();
      expect(await ledger.consume(key, 'E', '2026-10-13', 2, 3)).toBe(true);
      expect(await ledger.consume(key, 'E', '2026-10-13', 2, 3)).toBe(false);
      expect(await ledger.consume(key, 'E', '2026-10-13', 1, 3)).toBe(true);
      expect(await ledger.consume(key, 'E', '2026-10-13', 1, 3)).toBe(false);
      expect(await ledger.consume(key, 'E', '2026-10-14', 3, 3)).toBe(true);
    });

    it('handles the edge cases: nothing to spend, more than the limit', async () => {
      const ledger = create();
      expect(await ledger.consume(key, 'E', 'd', 0, 3)).toBe(true);
      expect(await ledger.consume(key, 'E', 'd', 4, 3)).toBe(false);
      expect(await ledger.consume(key, 'E', 'd', 3, 3)).toBe(true);
    });

    it('pays a token only once per day', async () => {
      const ledger = create();
      expect(await ledger.consume(key, 'E', 'd', 2, 2, 't1')).toBe(true);
      expect(await ledger.consume(key, 'E', 'd', 2, 2, 't1')).toBe(true);
      expect(await ledger.consume(key, 'E', 'd', 1, 2, 't2')).toBe(false);
      expect(await ledger.consume(key, 'E', 'd2', 2, 2, 't1')).toBe(true);
      expect(await ledger.consume(key, 'E', 'd2', 1, 2, 't1')).toBe(true);
    });
  });

  it('stores the spend in the item shape of the Python calendar budget', async () => {
    const store = new MemoryItemStore();
    await new StoreQuotaLedger(store).consume({ PK: 'CALENDAR', SK: 'BUDGET#eodhd' }, 'CALENDAR_BUDGET', '2026-10-13', 2, 8);
    expect(store.snapshot()).toEqual([{ PK: 'CALENDAR', SK: 'BUDGET#eodhd', entityType: 'CALENDAR_BUDGET', day: '2026-10-13', used: 2 }]);
  });

  it('retries a lost compare-and-set and gives up on endless contention', async () => {
    const store = new MemoryItemStore();
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, 'put').mockImplementationOnce(() => Promise.resolve(false)).mockImplementation(put);
    expect(await new StoreQuotaLedger(store).consume({ PK: 'U', SK: 'p' }, 'E', 'd', 1, 5)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockResolvedValue(false);
    await expect(new StoreQuotaLedger(store).consume({ PK: 'U', SK: 'p' }, 'E', 'd', 1, 5)).rejects.toThrow('contended');
  });

  it('raises a RateLimitError once the daily quota is used up', async () => {
    const quota = new DailyQuota(new MemoryQuotaLedger(), 'eodhd', 2, () => '2026-10-13');
    await quota.consume(2);
    await expect(quota.consume()).rejects.toMatchObject({ name: 'RateLimitError', provider: 'eodhd', message: 'eodhd daily quota of 2 exhausted' });
  });
});

describe('parsing helpers', () => {
  it('reads numbers defensively', () => {
    expect(['12.5', ' 7 ', '1e3', '.5', '5.', '-0.25', 3, 2.5].map(asFloat)).toEqual([12.5, 7, 1000, 0.5, 5, -0.25, 3, 2.5]);
    expect(['', 'NA', 'None', '-', 'abc', 'inf', 'nan', null, undefined, true, {}, Number.NaN, Number.POSITIVE_INFINITY, '1e999'].map(asFloat)).toEqual(Array(14).fill(null));
    expect([25, '34.2', 0, '-1', 'None', undefined].map(positiveNumber)).toEqual([25, 34.2, null, null, null, null]);
  });

  it('cleans free text and ISINs', () => {
    expect(cleanText('  Makes   chips \n and more ')).toBe('Makes chips and more');
    expect(cleanText('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(cleanText('aaaaaaa bbb', 9)).toBe('aaaaaaa…');
    expect([undefined, 5, '', '   ', 'None', 'n/a', '-', 'NA'].map((value) => cleanText(value))).toEqual(Array(8).fill(undefined));
    expect(validIsin(' nl0010273215 ')).toBe('NL0010273215');
    expect([undefined, 12, 'NL001027321', 'NL0010273215X', 'NL00102732-5', 'ÑL0010273215'].map(validIsin)).toEqual(Array(6).fill(undefined));
  });

  it('title-cases like Python', () => {
    expect(titleCase('CONSUMER CYCLICAL')).toBe('Consumer Cyclical');
    expect(titleCase("O'NEIL & 3M")).toBe("O'Neil & 3M");
  });

  it('validates dates and shapes values', () => {
    expect(isoDateOrNull('2026-10-29')).toBe('2026-10-29');
    expect([' 2026-10-29 ', '2026-02-30', '2026-13-01', 'not-a-date', '20261029', 5, undefined].map(isoDateOrNull)).toEqual(['2026-10-29', null, null, null, null, null, null]);
    expect(dayOf('2026-10-13T00:00:00')).toBe('2026-10-13');
    expect(dayOf(null)).toBe('');
    expect(dayOf(20261013)).toBe('20261013');
    expect(definedOnly({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
    expect(ownValue({ a: 1 }, 'a')).toBe(1);
    expect(['constructor', '__proto__', 'toString', 'b'].map((key) => ownValue({ a: 1 }, key))).toEqual([undefined, undefined, undefined, undefined]);
    expect(['b', 'a', 'C'].toSorted(byText)).toEqual(['a', 'b', 'C']);
  });
});

describe('time', () => {
  it('does date arithmetic on YYYY-MM-DD strings', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetweenDays('2026-10-01', '2026-10-13')).toBe(12);
    expect(utcDay(new Date('2026-10-13T23:59:59Z'))).toBe('2026-10-13');
    expect([weekdayOf('2026-10-11'), isWeekday('2026-10-11'), isWeekday('2026-10-12'), isWeekday('2026-10-17')]).toEqual([0, false, true, false]);
  });

  it('reads provider timestamps, falling back to the clock', () => {
    const fallback = new Date('2026-10-13T12:00:00Z');
    expect(fromEpochSeconds(1_792_000_000.9, fallback).toISOString()).toBe('2026-10-14T17:46:40.000Z');
    expect([null, 0, 1e18].map((seconds) => fromEpochSeconds(seconds, fallback))).toEqual([fallback, fallback, fallback]);
  });

  it('knows the Amsterdam and Frankfurt wall clocks across daylight-saving changes', () => {
    expect(amsterdamHour(new Date('2026-10-13T16:00:00Z'))).toBe(18);
    expect(amsterdamHour(new Date('2026-12-01T17:00:00Z'))).toBe(18);
    expect(amsterdamHour(new Date('2026-03-29T00:59:00Z'))).toBe(1);
    expect(amsterdamHour(new Date('2026-03-29T01:00:00Z'))).toBe(3);
    expect(hourIn(new Date('2026-10-13T00:00:00Z'), 'UTC')).toBe(0);
    expect(zonedTimeToUtc('2026-10-13', 16, 'Europe/Berlin').toISOString()).toBe('2026-10-13T14:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', 16, 'Europe/Berlin').toISOString()).toBe('2026-12-01T15:00:00.000Z');
    expect(zonedTimeToUtc('2026-10-25', 16, 'Europe/Berlin').toISOString()).toBe('2026-10-25T15:00:00.000Z');
  });
});

describe('currencies', () => {
  it('never reads provider text as an object member', () => {
    expect(normalizeCurrency('constructor', 'USD')).toBe('CONSTRUCTOR');
    expect(makeQuote({ symbol: 'X', price: 100, previousClose: 50, currency: 'toString', asOf: 't', source: 's' })).toMatchObject({ price: 100, currency: 'toString' });
  });
});

describe('symbols', () => {
  it('routes symbols to their market', () => {
    expect(['BTC-EUR', 'ASML.AS', 'SAP.DE', 'AAPL', 'BRK-B'].map(routeOf)).toEqual(['crypto', 'listed', 'listed', 'us', 'us']);
    expect(normalizeSymbol(' sap.de ')).toBe('SAP.DE');
    expect(cryptoParts('BTC-EUR')).toEqual(['BTC', 'EUR']);
    expect(minimalProfile('BTC-EUR')).toEqual({ symbol: 'BTC-EUR', name: 'BTC', assetClass: 'CRYPTO', currency: 'EUR' });
  });
});

describe('csv', () => {
  it('reads quoted fields, line breaks, escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n1,"x, ""y""",3\r\n\r\n"multi\nline",,last');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'x, "y"', '3'], ['multi\nline', '', 'last']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a\n')).toEqual([['a']]);
  });

  it('maps rows to records and leaves missing columns undefined', () => {
    expect(csvRecords(parseCsv('a,b\n1\n2,3,4'))).toEqual({ header: ['a', 'b'], records: [{ a: '1', b: undefined }, { a: '2', b: '3' }] });
    expect(csvRecords([])).toEqual({ header: [], records: [] });
  });
});

describe('configuration', () => {
  it('has the defaults of the Python service', () => {
    const config = parsePricesConfig({});
    expect(config).toMatchObject({ baseCurrency: 'EUR', fxHistoryStart: '2015-01-01', euRefreshHours: [18], keys: {}, coinGeckoCoinIds: '', dailyLimits: { twelvedata: 800, eodhd: 20, alphavantage: 25 }, calendar: DEFAULT_CALENDAR_SETTINGS });
  });

  it('reads keys, limits, hours and dates from the injected environment', () => {
    const config = parsePricesConfig({ BASE_CURRENCY: ' usd ', FX_HISTORY_START: '2020-03-02', EU_REFRESH_HOURS: '9, 12, x, 30', TWELVEDATA_API_KEY: ' k ', EODHD_API_KEY: '  ', EODHD_DAILY_LIMIT: '12', ALPHAVANTAGE_DAILY_LIMIT: 'many', COINGECKO_COIN_IDS: 'AVAX=avalanche-2' });
    expect(config).toMatchObject({ baseCurrency: 'USD', fxHistoryStart: '2020-03-02', euRefreshHours: [9, 12], keys: { twelvedata: 'k' }, dailyLimits: { eodhd: 12, alphavantage: 25 }, coinGeckoCoinIds: 'AVAX=avalanche-2' });
    expect(parsePricesConfig({ FX_HISTORY_START: '  ' }).fxHistoryStart).toBe('2015-01-01');
    expect(parsePricesConfig({ FX_HISTORY_START: '2020-99-99' }).fxHistoryStart).toBe('2015-01-01');
    expect(parsePricesConfig({ EU_REFRESH_HOURS: 'x' }).euRefreshHours).toEqual([18]);
  });

  it('reads the calendar settings and ignores invalid values', () => {
    expect(parseCalendarSettings({ CALENDAR_EARNINGS_HORIZON: ' 3Month ', CALENDAR_ALPHAVANTAGE_DAILY_CALLS: '2', CALENDAR_EODHD_DAILY_CALLS: '0', CALENDAR_RECHECK_DAYS: '0', CALENDAR_REFRESH_DIVIDENDS: 'No', CALENDAR_SPLIT_LOOKBACK_DAYS: '30' })).toEqual({ earningsHorizon: '3month', alphavantageDailyCalls: 2, eodhdDailyCalls: 0, recheckDays: 1, refreshDividends: false, splitLookbackDays: 30 });
    expect(parseCalendarSettings({ CALENDAR_EARNINGS_HORIZON: 'forever', CALENDAR_EODHD_DAILY_CALLS: 'lots', CALENDAR_REFRESH_DIVIDENDS: 'yes' })).toEqual({ ...DEFAULT_CALENDAR_SETTINGS });
    expect(parseCalendarSettings({ CALENDAR_REFRESH_DIVIDENDS: 'on' }).refreshDividends).toBe(true);
  });
});
