import { describe, expect, it } from 'vitest';
import { MemoryItemStore } from '@portfolio/platform';
import { sequentially } from '@portfolio/shared';
import { EstimateBudget, ESTIMATES_DAILY_CALLS, ESTIMATES_MIN_REMAINING } from './estimate-budget.js';
import { AlphaVantageEstimatesClient, estimateTicker, parseEarningsEstimates } from './providers/estimates.js';

/** The shape of a real `EARNINGS_ESTIMATES` answer (a large company, demo key), cut to a few entries: strings with decimals, nulls, years and quarters mixed. */
const REAL = {
  symbol: 'IBM',
  estimates: [
    {
      date: '2027-12-31',
      horizon: 'fiscal year',
      eps_estimate_average: '13.2353',
      eps_estimate_high: '13.6733',
      eps_estimate_low: '12.3018',
      eps_estimate_analyst_count: '24.0000',
      eps_estimate_average_7_days_ago: '13.1501',
      eps_estimate_revision_up_trailing_7_days: '1.0000',
      eps_estimate_revision_down_trailing_7_days: null,
      revenue_estimate_average: '73218871900.00',
      revenue_estimate_high: '74446000000.00',
      revenue_estimate_low: '71325270790.00',
      revenue_estimate_analyst_count: '23.00',
    },
    {
      date: '2026-12-31',
      horizon: 'fiscal quarter',
      eps_estimate_average: '4.6278',
      eps_estimate_high: '4.9000',
      eps_estimate_low: '4.4000',
      eps_estimate_analyst_count: '14.0000',
      eps_estimate_revision_down_trailing_7_days: null,
      revenue_estimate_average: '20391352200.00',
      revenue_estimate_high: '20800000000.00',
      revenue_estimate_low: '20100000000.00',
      revenue_estimate_analyst_count: '13.00',
    },
    {
      date: '2026-06-30',
      horizon: 'fiscal quarter',
      eps_estimate_average: '2.9331',
      eps_estimate_high: '2.9600',
      eps_estimate_low: '2.9279',
      eps_estimate_analyst_count: '9.0000',
      revenue_estimate_average: '17178737000.00',
      revenue_estimate_high: '17219000000.00',
      revenue_estimate_low: '17110000000.00',
      revenue_estimate_analyst_count: '9.00',
    },
  ],
};

describe('parseEarningsEstimates', () => {
  it('reads the fiscal quarters of a real answer, newest first, and skips the years', () => {
    const answer = parseEarningsEstimates(REAL);
    expect(answer).toEqual({
      status: 'ok',
      quarters: [
        {
          quarterEnd: '2026-12-31',
          eps: { average: 4.6278, high: 4.9, low: 4.4, analysts: 14 },
          revenue: { average: 20_391_352_200, high: 20_800_000_000, low: 20_100_000_000, analysts: 13 },
        },
        {
          quarterEnd: '2026-06-30',
          eps: { average: 2.9331, high: 2.96, low: 2.9279, analysts: 9 },
          revenue: { average: 17_178_737_000, high: 17_219_000_000, low: 17_110_000_000, analysts: 9 },
        },
      ],
    });
  });

  it('is defensive about None, empty text, numbers, junk and missing fields', () => {
    const answer = parseEarningsEstimates({
      estimates: [
        { date: '2026-03-31', horizon: 'fiscal quarter', eps_estimate_average: 1.5, eps_estimate_high: 'None', eps_estimate_low: '', eps_estimate_analyst_count: 'abc', revenue_estimate_average: null },
        { date: '2026-06-30', horizon: 'Fiscal Quarter', revenue_estimate_average: '1000', revenue_estimate_analyst_count: '-3' },
        { date: '2026-09-30', horizon: 'fiscal quarter', eps_estimate_average: 'None', revenue_estimate_average: 'NA' },
        { date: 'not a date', horizon: 'fiscal quarter', eps_estimate_average: '9' },
        { date: '2026-12-31', eps_estimate_average: '9' },
        { date: '2026-03-31', horizon: 'fiscal quarter', eps_estimate_average: '7' },
        'junk',
        null,
      ],
    });
    expect(answer).toEqual({
      status: 'ok',
      quarters: [{ quarterEnd: '2026-06-30', revenue: { average: 1000 } }, { quarterEnd: '2026-03-31', eps: { average: 1.5 } }],
    });
  });

  it('keeps the newest twelve quarters', () => {
    const estimates = Array.from({ length: 20 }, (_, index) => ({ date: `${2020 + Math.floor(index / 4)}-${['03-31', '06-30', '09-30', '12-31'][index % 4]}`, horizon: 'fiscal quarter', eps_estimate_average: String(index + 1) }));
    const answer = parseEarningsEstimates({ estimates });
    expect(answer.status === 'ok' && answer.quarters).toHaveLength(12);
    expect(answer.status === 'ok' && answer.quarters[0]?.quarterEnd).toBe('2024-12-31');
  });

  it('tells a premium endpoint from a rate limit, and neither from "no coverage"', () => {
    const premium = { Information: 'Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans (https://www.alphavantage.co/premium/) to instantly unlock all premium endpoints' };
    const limit = { Information: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.' };
    const frequency = { Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day.' };
    expect(parseEarningsEstimates(premium)).toMatchObject({ status: 'premium' });
    expect(parseEarningsEstimates(limit)).toMatchObject({ status: 'rate-limited', scope: 'daily' });
    expect(parseEarningsEstimates(frequency)).toMatchObject({ status: 'rate-limited', scope: 'burst' });
    expect(parseEarningsEstimates({ 'Error Message': 'Invalid API call. Please retry or visit the documentation.' })).toEqual({ status: 'no-coverage' });
    expect(parseEarningsEstimates({})).toEqual({ status: 'no-coverage' });
    expect(parseEarningsEstimates({ symbol: 'ZZZZ', estimates: [] })).toEqual({ status: 'no-coverage' });
    expect(parseEarningsEstimates({ estimates: [{ date: '2026-03-31', horizon: 'fiscal year', eps_estimate_average: '3' }] })).toEqual({ status: 'no-coverage' });
  });

  it('records an unknown notice as a rate limit with the provider\u2019s words (no URL), and a malformed answer as an error with a short reason', () => {
    expect(parseEarningsEstimates({ Information: 'Something new happened, see https://example.test/x?apikey=SECRET for details' })).toEqual({ status: 'rate-limited', scope: 'other', detail: 'Something new happened, see (link) for details' });
    expect(parseEarningsEstimates({ Information: ' ' })).toEqual({ status: 'error', reason: 'the answer has no list of estimates' });
    expect(parseEarningsEstimates({ Note: 'https://example.test/only' })).toEqual({ status: 'rate-limited', scope: 'other', detail: '(link)' });
    expect(parseEarningsEstimates({ symbol: 'X', estimates: 'soon' })).toEqual({ status: 'error', reason: 'the answer has no list of estimates' });
    expect(parseEarningsEstimates([])).toEqual({ status: 'error', reason: 'the answer was not a JSON object' });
    expect(parseEarningsEstimates('premium endpoint')).toEqual({ status: 'error', reason: 'the answer was not a JSON object' });
    expect(parseEarningsEstimates(null)).toEqual({ status: 'error', reason: 'the answer was not a JSON object' });
  });
});

describe('estimateTicker', () => {
  it('uses a US ticker as it is, a class share with a dot, and a suffixed listing only through the alias table', () => {
    expect(estimateTicker('MSFT')).toEqual({ ticker: 'MSFT', via: 'direct' });
    expect(estimateTicker('BRK-B')).toEqual({ ticker: 'BRK.B', via: 'direct' });
    expect(estimateTicker('FOO.DE')).toEqual({ ticker: 'CRM', via: 'alias' });
    expect(estimateTicker('M4I.DE')).toEqual({ ticker: 'MA', via: 'alias' });
  });

  it('has no ticker for a listing without an alias, and none for crypto', () => {
    expect(estimateTicker('ASML.AS')).toBeNull();
    expect(estimateTicker('SAP.DE')).toBeNull();
    expect(estimateTicker('BTC-EUR')).toBeNull();
  });
});

describe('AlphaVantageEstimatesClient', () => {
  const respond = (body: BodyInit | null, init?: ResponseInit) => async () => new Response(body, init);
  const client = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => new AlphaVantageEstimatesClient({ apiKey: 'KEY1', fetch, timeoutMs: 1000 });

  it('calls EARNINGS_ESTIMATES with the ticker and the key, and parses the answer', async () => {
    const urls: string[] = [];
    const answer = await client(async (url) => {
      urls.push(url);
      return Response.json(REAL);
    }).fetchEstimates('BRK.B');
    expect(urls).toEqual(['https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=BRK.B&apikey=KEY1']);
    expect(answer.status).toBe('ok');
  });

  it('maps HTTP failures, a rate-limit status, a body that is not JSON and a failed request', async () => {
    expect(await client(respond('', { status: 429 })).fetchEstimates('X')).toEqual({ status: 'rate-limited', scope: 'other', detail: 'the provider answered 429 (too many requests)' });
    expect(await client(respond('', { status: 503 })).fetchEstimates('X')).toEqual({ status: 'error', reason: 'the provider answered 503' });
    expect(await client(respond('<html>')).fetchEstimates('X')).toEqual({ status: 'error', reason: 'the answer was not JSON' });
    expect(await client(() => Promise.reject(new Error('network'))).fetchEstimates('X')).toEqual({ status: 'error', reason: 'the request failed' });
    expect(await client(respond(JSON.stringify({ Information: 'This is a premium endpoint.' }))).fetchEstimates('X')).toEqual({ status: 'premium', detail: 'This is a premium endpoint.' });
  });

  it('waits for the pacer before it sends, and again for every call', async () => {
    const events: string[] = [];
    const paced = new AlphaVantageEstimatesClient({
      apiKey: 'K',
      fetch: async () => {
        events.push('fetch');
        return Response.json({});
      },
      pace: async () => {
        events.push('pace');
      },
    });
    await paced.fetchEstimates('X');
    await paced.fetchEstimates('Y');
    expect(events).toEqual(['pace', 'fetch', 'pace', 'fetch']);
  });

  it('lets the host\u2019s subrequest limit through: the step is deferred, it is not the provider\u2019s answer', async () => {
    const limit = Object.assign(new Error('Too many subrequests'), { name: 'SubrequestLimitError' });
    await expect(client(() => Promise.reject(limit)).fetchEstimates('X')).rejects.toBe(limit);
  });

  it('uses the default timeout without an option', async () => {
    const answer = await new AlphaVantageEstimatesClient({ apiKey: 'K', fetch: async () => Response.json({}) }).fetchEstimates('X');
    expect(answer).toEqual({ status: 'no-coverage' });
  });
});

describe('EstimateBudget', () => {
  const setup = (options: { dailyLimit?: number; generalLimit?: number; day?: () => string } = {}) => {
    const store = new MemoryItemStore();
    let day = '2026-10-13';
    const budget = new EstimateBudget({ store, dailyLimit: options.dailyLimit ?? 25, generalLimit: options.generalLimit ?? 24, today: options.day ?? (() => day) });
    return { store, budget, nextDay: () => (day = '2026-10-14') };
  };
  const spendAll = async (budget: EstimateBudget, times: number): Promise<boolean[]> => {
    const results: boolean[] = [];
    for await (const result of sequentially(Array.from({ length: times }), () => budget.spend())) results.push(result);
    return results;
  };

  it('allows 8 calls a day of its own and then refuses', async () => {
    const { budget } = setup();
    expect(ESTIMATES_DAILY_CALLS).toBe(8);
    expect(await budget.room()).toEqual({ allowed: true, remaining: 25 });
    expect(await spendAll(budget, 9)).toEqual([true, true, true, true, true, true, true, true, false]);
    expect(await budget.room()).toEqual({ allowed: false, reason: 'job-cap' });
  });

  it('counts every call in the provider\u2019s shared counter and keeps the last five of the 25 for the others', async () => {
    const { store, budget } = setup();
    await store.put({ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-13', used: 17 });
    expect(await budget.room()).toEqual({ allowed: true, remaining: 8 });
    await spendAll(budget, 3);
    expect((await store.get({ PK: 'USAGE', SK: 'alphavantage' }))?.used).toBe(20);
    expect(await budget.room()).toEqual({ allowed: true, remaining: 5 });
    await spendAll(budget, 1);
    expect(await budget.room()).toEqual({ allowed: false, reason: 'low-allowance' });
    expect(ESTIMATES_MIN_REMAINING).toBe(5);
  });

  it('refuses the spend when the shared counter is at the general limit (the calendar keeps its call)', async () => {
    const { store, budget } = setup();
    await store.put({ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-13', used: 24 });
    expect(await budget.spend()).toBe(false);
  });

  it('starts every UTC day from zero', async () => {
    const { budget, nextDay } = setup();
    await spendAll(budget, 8);
    expect((await budget.room()).allowed).toBe(false);
    nextDay();
    expect(await budget.room()).toEqual({ allowed: true, remaining: 25 });
    expect(await budget.spend()).toBe(true);
  });

  it('honours its own limits when given', async () => {
    const store = new MemoryItemStore();
    const budget = new EstimateBudget({ store, dailyLimit: 10, generalLimit: 10, jobLimit: 2, minRemaining: 1, today: () => '2026-10-13' });
    expect(await budget.spend()).toBe(true);
    expect(await budget.spend()).toBe(true);
    expect(await budget.room()).toEqual({ allowed: false, reason: 'job-cap' });
  });
});
