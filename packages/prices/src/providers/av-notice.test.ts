import { describe, expect, it } from 'vitest';
import { ProviderError, RateLimitError } from '../errors.js';
import { HttpClient } from '../http.js';
import { DailyQuota, MemoryQuotaLedger, TokenBucket } from '../limits.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { AlphaVantageProvider } from './alphavantage.js';
import {
  BURST_RETRY_MS,
  INVALID_KEY_RETRY_MS,
  NOTICE_MAX,
  OTHER_RETRY_MS,
  classifyNotice,
  errorMessageOf,
  limitError,
  nextDayStartMs,
  noticeOf,
  resumeAtMs,
  sanitizeNotice,
} from './av-notice.js';
import { scanEarningsRows } from './calendar.js';
import { parseEarningsEstimates } from './estimates.js';

/** The texts Alpha Vantage answers a free key with, as seen (the quota and burst texts verbatim up to their sales pitch). */
const TEXTS = {
  daily: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.',
  burst: 'Burst pattern detected. Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free request limit.',
  premium: 'Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints',
  volume: 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.',
  frequency: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day.',
  key: 'the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds.',
  unknown: 'Something nobody has seen before.',
};

const NOW = Date.parse('2026-10-29T08:20:00.000Z');
const MIDNIGHT = Date.parse('2026-10-30T00:01:00.000Z');

describe('classifyNotice', () => {
  it.each([
    ['daily', 'daily'],
    ['burst', 'burst'],
    ['premium', 'premium'],
    ['volume', 'other'],
    ['frequency', 'burst'],
    ['key', 'invalid-key'],
    ['unknown', 'other'],
  ] as const)('reads the %s text as %s', (name, kind) => {
    expect(classifyNotice(TEXTS[name])).toBe(kind);
  });

  it('does not mistake the "contact premium@" text, or the premium-plans pitch of a quota text, for a premium endpoint', () => {
    expect(classifyNotice(TEXTS.volume)).not.toBe('premium');
    expect(classifyNotice(TEXTS.daily)).not.toBe('premium');
  });
});

describe('noticeOf and errorMessageOf', () => {
  it('reads Information first, then Note, with the text sanitised', () => {
    expect(noticeOf({ Information: TEXTS.volume })).toEqual({ kind: 'other', message: TEXTS.volume });
    expect(noticeOf({ Note: TEXTS.frequency })).toEqual({ kind: 'burst', message: TEXTS.frequency });
    expect(noticeOf({ Information: TEXTS.premium, Note: TEXTS.daily })?.kind).toBe('premium');
    expect(noticeOf({ Information: ' ', Note: TEXTS.daily })?.kind).toBe('daily');
  });

  it('finds nothing in an answer without text, with a text that is not a string, or with only an Error Message', () => {
    expect(noticeOf({})).toBeUndefined();
    expect(noticeOf({ Information: 5, Note: null })).toBeUndefined();
    expect(noticeOf({ 'Error Message': 'Invalid API call.' })).toBeUndefined();
    expect(errorMessageOf({ 'Error Message': 'Invalid API call.' })).toBe('Invalid API call.');
    expect(errorMessageOf({ 'Error Message': ' ' })).toBeUndefined();
    expect(errorMessageOf({})).toBeUndefined();
  });
});

describe('sanitizeNotice', () => {
  it('drops URLs and keys, control characters and extra spaces, and keeps at most 300 characters', () => {
    expect(sanitizeNotice('see https://www.alphavantage.co/query?function=X&apikey=SECRET123 now')).toBe('see (link) now');
    expect(sanitizeNotice('use apikey=SECRET123 please')).toBe('use apikey=(hidden) please');
    expect(sanitizeNotice('a\u0000b\n\tc   d')).toBe('a b c d');
    const long = sanitizeNotice('x'.repeat(500));
    expect(long).toHaveLength(NOTICE_MAX);
    expect(sanitizeNotice(TEXTS.daily)).not.toContain('https');
    expect(sanitizeNotice(TEXTS.volume)).toContain('premium@alphavantage.co');
  });
});

describe('resumeAtMs: when to ask again', () => {
  it('waits for the next UTC midnight after a daily limit or a premium endpoint', () => {
    expect(nextDayStartMs(NOW)).toBe(MIDNIGHT);
    expect(resumeAtMs('daily', NOW)).toBe(MIDNIGHT);
    expect(resumeAtMs('premium', NOW, 3)).toBe(MIDNIGHT);
  });

  it('waits two minutes after a burst, a quarter of an hour after any other notice and an hour after a refused key', () => {
    expect(resumeAtMs('burst', NOW)).toBe(NOW + BURST_RETRY_MS);
    expect(BURST_RETRY_MS).toBeGreaterThanOrEqual(120_000);
    expect(resumeAtMs('other', NOW)).toBe(NOW + OTHER_RETRY_MS);
    expect(resumeAtMs('invalid-key', NOW)).toBe(NOW + INVALID_KEY_RETRY_MS);
  });

  it('doubles with every earlier refusal of the day, never past the next UTC midnight', () => {
    expect(resumeAtMs('other', NOW, 1)).toBe(NOW + 2 * OTHER_RETRY_MS);
    expect(resumeAtMs('other', NOW, 2)).toBe(NOW + 4 * OTHER_RETRY_MS);
    expect(resumeAtMs('burst', NOW, 3)).toBe(NOW + 8 * BURST_RETRY_MS);
    expect(resumeAtMs('other', NOW, 10)).toBe(MIDNIGHT);
    expect(resumeAtMs('burst', Date.parse('2026-10-29T23:59:00.000Z'), 0)).toBe(MIDNIGHT);
  });
});

describe('limitError', () => {
  it('is a RateLimitError that keeps the provider\u2019s words and names when to try again', () => {
    const daily = limitError({ kind: 'daily', message: 'twenty-five' }, 'IBM');
    expect(daily).toBeInstanceOf(RateLimitError);
    expect(daily).toMatchObject({ message: 'alphavantage: daily limit: twenty-five', scope: 'day', symbol: 'IBM', provider: 'alphavantage' });
    expect(daily.retryAfterMs).toBeUndefined();
    expect(limitError({ kind: 'burst', message: 'b' })).toMatchObject({ retryAfterMs: BURST_RETRY_MS, message: 'alphavantage: burst limit: b' });
    expect(limitError({ kind: 'other', message: 'o' })).toMatchObject({ retryAfterMs: OTHER_RETRY_MS, message: 'alphavantage: rate limited: o' });
    expect(limitError({ kind: 'invalid-key', message: 'k' })).toMatchObject({ retryAfterMs: INVALID_KEY_RETRY_MS });
    const premium = limitError({ kind: 'premium', message: 'p' });
    expect(premium.message).toBe('alphavantage: premium endpoint: p');
    expect(premium.retryAfterMs).toBeUndefined();
    expect(premium.scope).toBeUndefined();
  });
});

describe('EARNINGS_ESTIMATES: every message variant', () => {
  const answer = (name: keyof typeof TEXTS, key: 'Information' | 'Note' = 'Information') => parseEarningsEstimates({ [key]: TEXTS[name] });

  it('classifies the daily quota text, in Information or Note, as a daily rate limit', () => {
    expect(answer('daily')).toMatchObject({ status: 'rate-limited', scope: 'daily' });
    expect(answer('daily', 'Note')).toMatchObject({ status: 'rate-limited', scope: 'daily' });
  });

  it('classifies the burst text, and the per-minute frequency text, as a burst', () => {
    expect(answer('burst')).toMatchObject({ status: 'rate-limited', scope: 'burst' });
    expect(answer('frequency', 'Note')).toMatchObject({ status: 'rate-limited', scope: 'burst' });
  });

  it('classifies "contact premium@alphavantage.co ... higher API call volume" as a rate limit with a short back-off, not as a failure or a premium endpoint', () => {
    const result = answer('volume');
    expect(result).toEqual({ status: 'rate-limited', scope: 'other', detail: TEXTS.volume });
  });

  it('classifies the premium endpoint text as premium and keeps the sanitised text', () => {
    const result = answer('premium');
    expect(result.status).toBe('premium');
    expect(result.status === 'premium' && result.detail).not.toContain('http');
  });

  it('reads a refused key as an error that says so, and an unknown notice as a rate limit', () => {
    expect(answer('key')).toMatchObject({ status: 'error', invalidKey: true });
    expect(parseEarningsEstimates({ 'Error Message': TEXTS.key })).toMatchObject({ status: 'error', invalidKey: true });
    expect(answer('unknown')).toEqual({ status: 'rate-limited', scope: 'other', detail: TEXTS.unknown });
  });

  it('keeps at most 300 characters of the provider\u2019s words and never a key', () => {
    const result = parseEarningsEstimates({ Information: `${'word '.repeat(100)} https://x.test/?apikey=SECRET` });
    expect(result.status === 'rate-limited' && result.detail?.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('EARNINGS_CALENDAR and OVERVIEW: the same classification', () => {
  const targets = new Map([['IBM', [{ symbol: 'IBM', via: 'direct' as const }]]]);
  const scan = (name: keyof typeof TEXTS, key: 'Information' | 'Note' = 'Information') => () => scanEarningsRows(JSON.stringify({ [key]: TEXTS[name] }), targets);

  it.each(['daily', 'burst', 'volume', 'frequency', 'premium', 'unknown'] as const)('records the %s text of the calendar as a RateLimitError with the provider\u2019s words', (name) => {
    expect(scan(name)).toThrow(RateLimitError);
    expect(scan(name)).toThrow(/^alphavantage: /);
  });

  it('keeps the daily scope and the burst wait on the calendar error', () => {
    expect(() => scan('daily')()).toThrow(expect.objectContaining({ scope: 'day' }));
    expect(() => scan('burst', 'Note')()).toThrow(expect.objectContaining({ retryAfterMs: BURST_RETRY_MS }));
    expect(() => scan('volume')()).toThrow(expect.objectContaining({ retryAfterMs: OTHER_RETRY_MS, message: expect.stringContaining('higher API call volume') }));
  });

  it('keeps an Error Message of the calendar, and any other JSON, a plain failure with the words', () => {
    expect(() => scanEarningsRows(JSON.stringify({ 'Error Message': 'Invalid API call.' }), targets)).toThrow(expect.objectContaining({ message: 'alphavantage: unexpected JSON response for EARNINGS_CALENDAR: Invalid API call.' }));
    expect(() => scanEarningsRows('{"other": 1}', targets)).toThrow(ProviderError);
    expect(() => scanEarningsRows('{"other": 1}', targets)).not.toThrow(RateLimitError);
    expect(() => scanEarningsRows('[1]', targets)).toThrow(ProviderError);
  });

  it('records the OVERVIEW notices of the profile provider as rate limits, with the words, even an empty one', async () => {
    const noSleep = (): Promise<void> => Promise.resolve();
    const profile = (body: unknown) =>
      new AlphaVantageProvider({
        apiKey: 'k',
        http: new HttpClient({ provider: 'alphavantage', fetch: new FakeFetch().add('OVERVIEW', body).fetch, sleep: noSleep, maxRetries: 0, random: () => 0 }),
        bucket: new TokenBucket(100, 100, () => 0, noSleep),
        quota: new DailyQuota(new MemoryQuotaLedger(), 'alphavantage', 25, () => '2026-10-29'),
        now: () => new Date(NOW),
      }).getProfile('IBM');
    await expect(profile({ Information: TEXTS.volume })).rejects.toMatchObject({ name: 'RateLimitError', message: expect.stringContaining('higher API call volume'), retryAfterMs: OTHER_RETRY_MS });
    await expect(profile({ Note: TEXTS.daily })).rejects.toMatchObject({ scope: 'day' });
    await expect(profile({ Information: '' })).rejects.toBeInstanceOf(RateLimitError);
  });
});
