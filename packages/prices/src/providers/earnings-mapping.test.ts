import { describe, expect, it } from 'vitest';
import { ProviderError, RateLimitError } from '../errors.js';
import { HttpClient } from '../http.js';
import { DailyQuota, MemoryQuotaLedger, TokenBucket } from '../limits.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { AlphaVantageEarnings, earningsTargets, parseEarningsRows } from './calendar.js';

const noSleep = (): Promise<void> => Promise.resolve();

/** An invented extract of the Alpha Vantage `EARNINGS_CALENDAR` CSV: the companies of a portfolio with Xetra, Euronext and US listings. */
const CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
CRM,SALESFORCE INC,2026-12-03,2026-10-31,2.41,USD,post-market
MA,MASTERCARD INC,2026-10-29,2026-09-30,3.6,USD,pre-market
NFLX,NETFLIX INC,2026-10-20,2026-09-30,5.1,USD,post-market
ADBE,ADOBE INC,2026-12-10,2026-11-30,,USD,post-market
ASML,ASML HOLDING NV,2027-01-28,2026-12-31,6.9,EUR,pre-market
AMZN,AMAZON COM INC,2026-10-30,2026-09-30,1.5,USD,post-market
DTE,DTE ENERGY CO,2026-10-27,2026-09-30,1.9,USD,pre-market
BRK.B,BERKSHIRE HATHAWAY INC,2026-11-02,2026-09-30,None,USD,
XYZ,SOMETHING ELSE,2026-11-03,2026-09-30,1,USD,during-market
`;

const NAMES = new Map([
  ['FOO.DE', 'Salesforce'],
  ['M4I.DE', 'Mastercard'],
  ['ASML.AS', 'ASML Holding'],
  ['DTE.DE', 'Deutsche Telekom'],
]);

const datesOf = (events: readonly { symbol: string; date: string }[]): string[] => events.map((event) => `${event.symbol} ${event.date}`);

describe('earningsTargets', () => {
  it.each([
    ['FOO.DE', 'CRM'],
    ['M4I.DE', 'MA'],
    ['NFC.DE', 'NFLX'],
    ['ADB.DE', 'ADBE'],
  ])('%s is looked up as %s through the alias table, and by its bare ticker', (symbol, ticker) => {
    const targets = earningsTargets([symbol]);
    expect(targets.get(ticker)).toEqual([{ symbol, via: 'alias', name: undefined }]);
    expect(targets.get(symbol.slice(0, symbol.indexOf('.')))).toEqual([{ symbol, via: 'base', name: undefined }]);
  });

  it('keeps a US ticker as it is (a class share with a dot), looks a Euronext listing up by its bare ticker and ignores crypto', () => {
    const targets = earningsTargets(['AMZN', 'BRK-B', 'ASML.AS', 'BTC-EUR']);
    expect([...targets.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual(['AMZN', 'ASML', 'BRK.B']);
    expect(targets.get('BRK.B')).toEqual([{ symbol: 'BRK-B', via: 'direct', name: undefined }]);
  });

  it('lets two symbols share one ticker (the Euronext listing and the US line of the same company)', () => {
    expect(earningsTargets(['ASML', 'ASML.AS']).get('ASML')?.map((target) => target.symbol)).toEqual(['ASML', 'ASML.AS']);
  });
});

describe('parseEarningsRows', () => {
  const events = parseEarningsRows(CSV, earningsTargets(['AMZN', 'BRK-B', 'FOO.DE', 'M4I.DE', 'NFC.DE', 'ADB.DE', 'ASML.AS', 'DTE.DE'], NAMES));

  it('stores the dates under the app symbols of the holdings: Xetra spellings through the alias table, Euronext through the bare ticker', () => {
    expect(datesOf(events)).toEqual([
      'ADB.DE 2026-12-10',
      'AMZN 2026-10-30',
      'ASML.AS 2027-01-28',
      'BRK-B 2026-11-02',
      'FOO.DE 2026-12-03',
      'M4I.DE 2026-10-29',
      'NFC.DE 2026-10-20',
    ]);
  });

  it('never mistakes another company that happens to have the same bare ticker (DTE Energy is not Deutsche Telekom)', () => {
    expect(events.some((event) => event.symbol === 'DTE.DE')).toBe(false);
  });

  it('reads estimate, currency, fiscal period and the time of day', () => {
    expect(events.find((event) => event.symbol === 'FOO.DE')).toEqual({ symbol: 'FOO.DE', date: '2026-12-03', name: 'SALESFORCE INC', fiscalPeriodEnd: '2026-10-31', epsEstimate: 2.41, currency: 'USD', timeOfDay: 'AMC', source: 'alphavantage' });
    expect(events.find((event) => event.symbol === 'M4I.DE')).toMatchObject({ timeOfDay: 'BMO', epsEstimate: 3.6 });
    expect(events.find((event) => event.symbol === 'ADB.DE')).not.toHaveProperty('epsEstimate');
    expect(events.find((event) => event.symbol === 'BRK-B')).toMatchObject({ timeOfDay: 'unknown' });
  });

  it('accepts an alias when the holding has no real name yet, rejects it when the names differ, and needs a name for a bare ticker', () => {
    const unnamed = parseEarningsRows(CSV, earningsTargets(['FOO.DE', 'ASML.AS']));
    expect(datesOf(unnamed)).toEqual(['FOO.DE 2026-12-03']);
    const symbolAsName = parseEarningsRows(CSV, earningsTargets(['FOO.DE'], new Map([['FOO.DE', 'FOO.DE']])));
    expect(datesOf(symbolAsName)).toEqual(['FOO.DE 2026-12-03']);
    const wrongName = parseEarningsRows(CSV, earningsTargets(['FOO.DE', 'ASML.AS'], new Map([['FOO.DE', 'Something Else Entirely'], ['ASML.AS', 'Another Corp']])));
    expect(wrongName).toEqual([]);
  });

  it('gives both lines of one company the date', () => {
    expect(datesOf(parseEarningsRows(CSV, earningsTargets(['ASML', 'ASML.AS'], NAMES))).toSorted((a, b) => a.localeCompare(b))).toEqual(['ASML 2027-01-28', 'ASML.AS 2027-01-28']);
  });

  it('refuses a JSON answer (a quota note) and a response that is no calendar', () => {
    const targets = earningsTargets(['AMZN']);
    expect(() => parseEarningsRows('{"Information": "Our standard API rate limit is 25 requests per day."}', targets)).toThrow(RateLimitError);
    expect(() => parseEarningsRows('{"Error Message": "invalid"}', targets)).toThrow(ProviderError);
    expect(() => parseEarningsRows('<html>maintenance</html>', targets)).toThrow(ProviderError);
  });
});

describe('AlphaVantageEarnings', () => {
  const setup = (limit = 25) => {
    const fake = new FakeFetch().add('alphavantage.co', { text: CSV });
    const http = new HttpClient({ provider: 'alphavantage', fetch: fake.fetch, sleep: noSleep, maxRetries: 0, random: () => 0 });
    const source = new AlphaVantageEarnings({ apiKey: 'av-secret', http, bucket: new TokenBucket(5, 5, () => 0, noSleep), quota: new DailyQuota(new MemoryQuotaLedger(), 'alphavantage', limit, () => '2026-10-15'), horizon: '12month' });
    return { fake, source };
  };

  it('makes one 12-month call for every holding and keeps the upcoming dates of the held companies, Xetra spellings included', async () => {
    const { fake, source } = setup();
    const events = await source.fetch(['AMZN', 'FOO.DE', 'M4I.DE', 'NFC.DE', 'ADB.DE', 'ASML.AS', 'BTC-EUR'], '2026-10-21', NAMES);
    expect(fake.requests).toHaveLength(1);
    expect(fake.urls[0]).toContain('function=EARNINGS_CALENDAR');
    expect(fake.urls[0]).toContain('horizon=12month');
    expect(datesOf(events)).toEqual(['ADB.DE 2026-12-10', 'AMZN 2026-10-30', 'ASML.AS 2027-01-28', 'FOO.DE 2026-12-03', 'M4I.DE 2026-10-29']);
  });

  it('makes no call when there is nothing it can look up, and spends the quota only when it calls', async () => {
    const { fake, source } = setup(0);
    await expect(source.fetch(['BTC-EUR'], '2026-10-21')).resolves.toEqual([]);
    expect(fake.requests).toEqual([]);
    await expect(source.fetch(['AMZN'], '2026-10-21')).rejects.toBeInstanceOf(RateLimitError);
    expect(fake.requests).toEqual([]);
  });
});
