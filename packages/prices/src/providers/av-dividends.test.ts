import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { EstimateBudget } from '../estimate-budget.js';
import { HttpClient } from '../http.js';
import { TokenBucket } from '../limits.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { AlphaVantageDividends, DIVIDEND_FEED_DAILY_CALLS, DIVIDEND_FEED_KEY_ITEM, DIVIDEND_FEED_MIN_REMAINING } from './av-dividends.js';

const NOW = new Date('2026-11-05T05:30:00.000Z');
const IBM = {
  symbol: 'HESM',
  data: [
    { ex_dividend_date: '2026-11-05', declaration_date: '2026-10-21', record_date: '2026-11-05', payment_date: '2026-11-13', amount: '0.7152' },
    { ex_dividend_date: '2026-08-05', declaration_date: 'None', record_date: '2026-08-05', payment_date: '2026-08-14', amount: '0.7' },
    { ex_dividend_date: '2026-05-06', declaration_date: '', record_date: '', payment_date: 'None', amount: '0.69' },
    { ex_dividend_date: '2020-01-01', declaration_date: '2019-12-01', record_date: '2020-01-01', payment_date: '2020-01-10', amount: '0.1' },
    { ex_dividend_date: 'None', amount: '0.5' },
    { ex_dividend_date: '2026-02-05', amount: 'None' },
    { ex_dividend_date: '2026-01-05', amount: '0' },
    'junk',
  ],
};

function feed(fake: FakeFetch, store = new MemoryItemStore(), options: { jobLimit?: number; minRemaining?: number } = {}): AlphaVantageDividends {
  const budget = new EstimateBudget({ store, dailyLimit: 25, generalLimit: 24, jobLimit: options.jobLimit ?? DIVIDEND_FEED_DAILY_CALLS, minRemaining: options.minRemaining ?? DIVIDEND_FEED_MIN_REMAINING, jobKey: DIVIDEND_FEED_KEY_ITEM, today: () => '2026-11-05' });
  const http = new HttpClient({ provider: 'alphavantage', fetch: fake.fetch, sleep: () => Promise.resolve(), random: () => 0 });
  return new AlphaVantageDividends({ apiKey: 'av-secret', http, bucket: new TokenBucket(5, 1, () => NOW.getTime(), () => Promise.resolve()), budget });
}

const ask = (source: AlphaVantageDividends, symbol = 'HESM') => source.fetch(symbol, '2024-11-05', '2027-11-05');

describe('AlphaVantageDividends', () => {
  it('reads the declared and past dividends of a US symbol within the window, with pay and declaration dates', async () => {
    const fake = new FakeFetch().add('function=DIVIDENDS', IBM);
    const answer = await ask(feed(fake));
    expect(answer).toEqual({
      status: 'ok',
      events: [
        { symbol: 'HESM', exDate: '2026-05-06', amount: 0.69, currency: 'USD', source: 'alphavantage' },
        { symbol: 'HESM', exDate: '2026-08-05', amount: 0.7, currency: 'USD', source: 'alphavantage', payDate: '2026-08-14', declared: true },
        { symbol: 'HESM', exDate: '2026-11-05', amount: 0.7152, currency: 'USD', source: 'alphavantage', payDate: '2026-11-13', declarationDate: '2026-10-21', declared: true },
      ],
    });
    expect(fake.urls[0]).toContain('function=DIVIDENDS');
    expect(fake.urls[0]).toContain('symbol=HESM');
  });

  it('asks for a class share with a dot', async () => {
    const fake = new FakeFetch().add('function=DIVIDENDS', { symbol: 'BRK.B', data: [] });
    expect(await ask(feed(fake), 'BRK-B')).toEqual({ status: 'ok', events: [] });
    expect(fake.urls[0]).toContain('symbol=BRK.B');
  });

  it('takes an unknown symbol for a symbol without dividends', async () => {
    expect(await ask(feed(new FakeFetch().add('function=DIVIDENDS', { 'Error Message': 'Invalid API call.' })))).toEqual({ status: 'ok', events: [] });
  });

  it('says the feed is unavailable on a premium refusal or a bad key, and limited on a quota or burst text', async () => {
    const answerTo = (text: string) => ask(feed(new FakeFetch().add('function=DIVIDENDS', { Information: text })));
    expect(await answerTo('Thank you for using Alpha Vantage! This is a premium endpoint. Please subscribe.')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('premium endpoint') });
    expect(await answerTo('the parameter apikey is invalid or missing.')).toMatchObject({ status: 'unavailable' });
    expect(await answerTo('Our standard API rate limit is 25 requests per day.')).toMatchObject({ status: 'limited', reason: expect.stringContaining('daily limit') });
    expect(await answerTo('Burst pattern detected. Please consider spreading out your free API requests more sparingly (1 request per second).')).toMatchObject({ status: 'limited' });
    expect(JSON.stringify(await answerTo('premium endpoint https://x.test/?apikey=SECRET'))).not.toContain('SECRET');
  });

  it('rejects an answer that is not a dividend list', async () => {
    await expect(ask(feed(new FakeFetch().add('function=DIVIDENDS', { something: 'else' })))).rejects.toThrow(ProviderError);
    await expect(ask(feed(new FakeFetch().add('function=DIVIDENDS', [])))).rejects.toThrow('unexpected response');
  });

  it('is held to its own daily cap and to the reserve of the shared allowance, without asking', async () => {
    const fake = new FakeFetch().add('function=DIVIDENDS', { symbol: 'X', data: [] });
    const capped = feed(fake, new MemoryItemStore(), { jobLimit: 1 });
    expect(await ask(capped)).toEqual({ status: 'ok', events: [] });
    expect(await ask(capped)).toEqual({ status: 'skipped', reason: 'budget' });
    expect(fake.urls).toHaveLength(1);

    const store = new MemoryItemStore().load([{ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-11-05', used: 20 }]);
    expect(await ask(feed(fake, store))).toEqual({ status: 'skipped', reason: 'low-allowance' });
    expect(fake.urls).toHaveLength(1);
  });

  it('counts a call in the shared allowance and in its own counter', async () => {
    const store = new MemoryItemStore();
    await ask(feed(new FakeFetch().add('function=DIVIDENDS', { symbol: 'X', data: [] }), store));
    const items = store.snapshot();
    expect(items.find((item) => item.SK === 'alphavantage')).toMatchObject({ used: 1 });
    expect(items.find((item) => item.SK === 'alphavantage#dividends')).toMatchObject({ used: 1 });
  });
});
