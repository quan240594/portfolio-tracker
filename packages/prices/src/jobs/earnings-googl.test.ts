import { buildCalendar, type CalendarData, type CalendarEvent, type StoredEarningsEvent, type Transaction } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { FakeFetch } from '../testing/fake-fetch.js';
import { drive, harness, track, type Harness } from '../testing/harness.js';
import { createRefreshCalendarJob } from './refresh-calendar.js';

/** The daily run: 05:30 in Amsterdam on Wednesday 28 Oct 2026 (CET, UTC+1), the day of the Alphabet Q3 call. */
const NOW = new Date('2026-10-28T04:30:00.000Z');
const TODAY = '2026-10-28';

/**
 * An invented extract in the shape of the Alpha Vantage `EARNINGS_CALENDAR` CSV (header, one row per company and report, the two
 * Alphabet share classes, a row dated today that reports after the close, a class share spelled with a dot, a row without a date).
 */
const CSV = [
  'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay',
  'AAPL,Apple Inc,2026-10-29,2026-09-30,1.85,USD,post-market',
  'GOOG,Alphabet Inc - Class C,2026-10-28,2026-09-30,2.31,USD,post-market',
  'GOOGL,Alphabet Inc - Class A,2026-10-28,2026-09-30,2.31,USD,post-market',
  'BRK.B,Berkshire Hathaway Inc,2026-11-01,2026-09-30,None,USD,',
  'MSFT,Microsoft Corp,2026-10-28,2026-09-30,3.1,USD,postmarket',
  'XYZ,No Date Corp,,2026-09-30,1,USD,pre-market',
  'META,Meta Platforms Inc,2026-10-27,2026-09-30,6.5,USD,post-market',
  '',
].join('\r\n');

const run = (h: Harness) => drive(h, createRefreshCalendarJob(h.deps), { trigger: 'scheduled' });
const csvHarness = (csv: string | { text: string }, env: Record<string, string> = {}): Harness =>
  harness({ start: NOW, env, fake: new FakeFetch().add('EARNINGS_CALENDAR', typeof csv === 'string' ? { text: csv } : csv) });

const storedEvents = (h: Harness): StoredEarningsEvent[] => h.store.snapshot().filter((item) => item.SK.startsWith('EARN#')) as unknown as StoredEarningsEvent[];

const transactions = (...symbols: string[]): Transaction[] =>
  symbols.map((symbol, index) => ({ id: `t${index}`, userId: 'u', portfolioId: 'default', date: '2025-06-02', type: 'BUY', symbol, quantity: 3, price: 150, fee: 0, currency: 'USD', createdAt: '2025-06-02T10:00:00Z' }));

function calendarOf(h: Harness, symbols: string[], statuses: CalendarEvent['status'][] = []): CalendarEvent[] {
  const data: CalendarData = {
    today: TODAY,
    transactions: transactions(...symbols),
    quotes: {},
    profiles: {},
    fx: { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-10-27T00:00:00Z' },
    fxHistory: [],
    dividendEvents: [],
    earnings: storedEvents(h),
    splits: [],
    watchlist: [],
  };
  return buildCalendar(data, { from: '2026-10-01', to: '2026-10-31', types: ['EARNINGS'], statuses, scope: 'holdings' }).events;
}

describe('the daily calendar refresh finds the Alphabet report', () => {
  it('stores GOOGL under its own ticker (not GOOG), dated today, after the close, and the calendar shows it', async () => {
    const h = csvHarness(CSV);
    track(h.store, 'GOOGL', 'AAPL');
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', symbols: 2, events: 2 });
    expect(storedEvents(h).map((event) => `${event.symbol} ${event.date} ${event.timeOfDay}`)).toEqual(['AAPL 2026-10-29 AMC', 'GOOGL 2026-10-28 AMC']);
    const events = calendarOf(h, ['GOOGL', 'AAPL']);
    expect(events.find((event) => event.symbol === 'GOOGL')).toMatchObject({ id: 'earn:GOOGL:2026-10-28', date: TODAY, status: 'CONFIRMED', origin: 'HOLDING', earningsPhase: 'scheduled', timeOfDay: 'AMC', epsEstimate: 2.31 });
  });

  it('keeps a report dated today in the calendar for every status filter that includes it', async () => {
    const h = csvHarness(CSV);
    track(h.store, 'GOOGL');
    await run(h);
    expect(calendarOf(h, ['GOOGL'], ['CONFIRMED'])).toHaveLength(1);
    expect(calendarOf(h, ['GOOGL'], ['ESTIMATED'])).toHaveLength(0);
  });

  it('stores GOOG and GOOGL separately when both are held', async () => {
    const h = csvHarness(CSV);
    track(h.store, 'GOOG', 'GOOGL');
    await run(h);
    expect(storedEvents(h).map((event) => event.symbol)).toEqual(['GOOG', 'GOOGL']);
  });

  it('finds a dotted class share under its stored spelling BRK-B and reads the unspaced "postmarket" time of day', async () => {
    const h = csvHarness(CSV);
    track(h.store, 'BRK-B', 'MSFT');
    await run(h);
    expect(storedEvents(h).map((event) => `${event.symbol} ${event.date} ${event.timeOfDay}`)).toEqual(['BRK-B 2026-11-01 unknown', 'MSFT 2026-10-28 AMC']);
  });

  it('does not store a report dated before today (Meta reported yesterday)', async () => {
    const h = csvHarness(CSV);
    track(h.store, 'META');
    expect((await run(h)).result.earnings).toMatchObject({ status: 'ok', symbols: 0, events: 0 });
  });

  it('finds the ticker whatever the spelling of the row: lower case and a dash for the dot', async () => {
    const h = csvHarness('symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\ngoogl,Alphabet Inc,2026-10-28,2026-09-30,2.3,USD,post-market\nBRK-B,Berkshire,2026-11-01,2026-09-30,,USD,\n');
    track(h.store, 'GOOGL', 'BRK-B');
    await run(h);
    expect(storedEvents(h).map((event) => event.symbol)).toEqual(['BRK-B', 'GOOGL']);
  });

  it('does not find GOOGL when the provider lists the other class only (the case to look for on the Diagnostics page)', async () => {
    const h = csvHarness(['symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay', 'GOOG,Alphabet Inc - Class C,2026-10-28,2026-09-30,2.31,USD,post-market'].join('\n'));
    track(h.store, 'GOOGL');
    expect((await run(h)).result.earnings).toMatchObject({ status: 'ok', symbols: 0 });
    expect(calendarOf(h, ['GOOGL'])).toEqual([]);
  });

  it('counts a "Thank you for using Alpha Vantage" body as a provider failure, not as an empty calendar', async () => {
    const h = csvHarness({ text: 'Thank you for using Alpha Vantage! Please visit https://www.alphavantage.co/premium/ to lift the limit.' });
    track(h.store, 'GOOGL');
    expect((await run(h)).result.earnings).toMatchObject({ status: 'failed' });
    expect(storedEvents(h)).toEqual([]);
  });
});
