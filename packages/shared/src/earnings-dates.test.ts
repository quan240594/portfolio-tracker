import { describe, expect, it } from 'vitest';
import { nextEarningsEvents } from './calendar.js';
import {
  buildEarningsDatesReport,
  earningsDatesSchema,
  parseEarningsRun,
  whyNoEarningsDate,
  type EarningsDatesInput,
  type EarningsRunRecord,
  type RefreshReport,
} from './earnings-dates.js';
import type { Transaction } from './types.js';

const NOW = new Date('2026-10-28T09:00:00.000Z');
const AVAILABLE: RefreshReport = { available: true, reason: null, nextAllowedAt: null };

const run = (over: Partial<EarningsRunRecord> = {}): EarningsRunRecord => ({ at: '2026-10-28T04:30:00.000Z', trigger: 'scheduled', status: 'ok', reason: '', tracked: 4, rows: 5000, events: 2, matchedSymbols: ['AAPL'], listed: ['AAPL', 'GOOG'], unvouched: [], ...over });
const why = (over: Partial<Parameters<typeof whyNoEarningsDate>[0]> = {}) => whyNoEarningsDate({ symbol: 'GOOGL', name: 'Alphabet Inc', trackedAt: '2026-10-01T10:00:00.000Z', run: run(), lastOk: run(), ...over });

describe('whyNoEarningsDate', () => {
  it('has no earnings for crypto', () => {
    expect(why({ symbol: 'BTC-EUR' })).toEqual({ code: 'not-applicable', text: 'Crypto has no earnings reports.' });
  });

  it('says a symbol the job does not track yet is not looked up', () => {
    expect(why({ trackedAt: undefined }).code).toBe('not-tracked');
  });

  it('says the job has not run when there is no record', () => {
    expect(why({ run: null, lastOk: null })).toMatchObject({ code: 'never-run', text: expect.stringContaining('05:30') });
  });

  it('says the job has not run since the holding was added', () => {
    expect(why({ trackedAt: '2026-10-28T08:00:00.000Z' })).toEqual({ code: 'since-bought', text: 'The calendar job has not run since you bought it (added 2026-10-28, last run 2026-10-28).' });
  });

  it('does not take a tracked symbol of unknown age for a new one', () => {
    expect(why({ trackedAt: null }).code).toBe('not-listed');
  });

  it('names the provider calendar as the place the date is missing from', () => {
    expect(why()).toEqual({ code: 'not-listed', text: "Not in the provider's calendar: its calendar of 5000 rows (2026-10-28) has no row for GOOGL." });
    expect(why({ run: run({ rows: undefined }) }).text).toBe("Not in the provider's calendar: its calendar (2026-10-28) has no row for GOOGL.");
  });

  it('tells a listed ticker with no upcoming date and a listing under another name apart', () => {
    expect(why({ run: run({ listed: ['GOOGL'] }) }).code).toBe('no-upcoming-date');
    const mismatch = why({ run: run({ listed: ['GOOGL'], unvouched: ['GOOGL'] }) });
    expect(mismatch).toEqual({ code: 'name-mismatch', text: 'The provider lists the ticker, but for a company whose name does not match "Alphabet Inc", so its date was not taken (2026-10-28).' });
  });

  it.each([
    ['rate-limited', 'alphavantage: rate limited', 'rate-limited', 'The Alpha Vantage rate limit was reached on 2026-10-28: alphavantage: rate limited. Nothing was read.'],
    ['failed', 'alphavantage: 500', 'failed', 'The provider call failed on 2026-10-28: alphavantage: 500.'],
    ['failed', '', 'failed', 'The provider call failed on 2026-10-28: no detail was recorded.'],
    ['budget-exhausted', '', 'budget', 'The daily Alpha Vantage allowance for the calendar was already used on 2026-10-28, so the job did not call the provider.'],
    ['no-provider', '', 'no-provider', 'No Alpha Vantage key is set on this deployment, so earnings dates are not looked up (last run 2026-10-28).'],
    ['no-symbols', '', 'not-tracked', 'The last run (2026-10-28) found no tracked symbol that has a US ticker to look up.'],
    ['skipped', 'the budget was above 60%.', 'skipped', 'The run of 2026-10-28 did not start: the budget was above 60%.'],
  ] as const)('explains a last run that was %s (%s)', (status, reason, code, text) => {
    expect(why({ run: run({ status, reason }), lastOk: null })).toEqual({ code, text });
  });

  it('falls back to the last successful run that covered the symbol and adds the failure', () => {
    const answer = why({ run: run({ status: 'failed', reason: 'alphavantage: 500', at: '2026-10-29T04:30:00.000Z' }), lastOk: run() });
    expect(answer.code).toBe('not-listed');
    expect(answer.text).toBe("Not in the provider's calendar: its calendar of 5000 rows (2026-10-28) has no row for GOOGL. The latest attempt did not read the calendar either: The provider call failed on 2026-10-29: alphavantage: 500.");
  });

  it('does not lean on a successful run from before the holding was added', () => {
    const answer = why({ trackedAt: '2026-10-28T05:00:00.000Z', run: run({ status: 'failed', reason: 'x', at: '2026-10-29T04:30:00.000Z' }), lastOk: run() });
    expect(answer.code).toBe('failed');
  });
});

describe('parseEarningsRun', () => {
  it('reads a stored record and drops what is not part of it', () => {
    const item = { PK: 'CALENDAR', SK: 'EARNINGS#LASTRUN', entityType: 'EARNINGS_RUN', ...run(), junk: 1 };
    expect(parseEarningsRun(item)).toEqual(run());
  });

  it('reads a record without counts and tolerates damaged optional fields', () => {
    expect(parseEarningsRun({ at: 'x', trigger: 'sometimes', status: 'failed', reason: 3, tracked: -1, rows: 'many', matchedSymbols: 'GOOGL' })).toEqual({ at: 'x', trigger: 'scheduled', status: 'failed', reason: '', tracked: 0 });
  });

  it('returns null for nothing or for something else', () => {
    expect(parseEarningsRun(undefined)).toBeNull();
    expect(parseEarningsRun({ at: 'x', status: 'who-knows' })).toBeNull();
  });
});

const tx = (symbol: string): Transaction => ({ id: symbol, userId: 'u', portfolioId: 'default', date: '2026-01-02', type: 'BUY', symbol, quantity: 1, price: 10, fee: 0, currency: 'USD', createdAt: '2026-01-02T10:00:00Z' });

function input(over: Partial<EarningsDatesInput> = {}): EarningsDatesInput {
  const transactions = [tx('GOOGL'), tx('AAPL'), tx('NVDA'), tx('BTC-EUR')];
  const next = nextEarningsEvents({
    today: '2026-10-28',
    transactions,
    watchlist: [],
    profiles: {},
    earnings: [
      { symbol: 'GOOGL', date: '2026-10-28', timeOfDay: 'AMC', source: 'alphavantage' },
      { symbol: 'AAPL', date: '2026-10-29', source: 'alphavantage' },
    ],
    reportedEarnings: [{ symbol: 'NVDA', reportDate: '2026-09-01', period: 'Q2 2027' }],
  });
  return {
    now: NOW,
    held: ['AAPL', 'BTC-EUR', 'GOOGL', 'NVDA', 'TSLA'].map((symbol) => ({ symbol, name: symbol })),
    tracked: new Map([
      ['AAPL', '2026-01-02T10:00:00.000Z'],
      ['GOOGL', '2026-01-02T10:00:00.000Z'],
      ['NVDA', '2026-01-02T10:00:00.000Z'],
    ]),
    next,
    run: run({ matchedSymbols: ['AAPL', 'GOOGL', 'MSFT'] }),
    lastOk: run({ matchedSymbols: ['AAPL', 'GOOGL', 'MSFT'] }),
    budget: null,
    refresh: AVAILABLE,
    ...over,
  };
}

describe('buildEarningsDatesReport', () => {
  const report = buildEarningsDatesReport(input());

  it('lists the symbols without a date first, then the dates in order', () => {
    expect(report.symbols.map((entry) => `${entry.symbol}:${entry.next?.date ?? '-'}`)).toEqual(['BTC-EUR:-', 'TSLA:-', 'GOOGL:2026-10-28', 'AAPL:2026-10-29', 'NVDA:2026-12-01']);
  });

  it('describes the date with its source and time of day, and the missing ones with a reason', () => {
    const bySymbol = Object.fromEntries(report.symbols.map((entry) => [entry.symbol, entry]));
    expect(bySymbol.GOOGL).toMatchObject({ next: { date: '2026-10-28', source: 'scheduled', timeOfDay: 'AMC' }, reasonCode: null, reason: null });
    expect(bySymbol.NVDA?.next?.source).toBe('projected');
    expect(bySymbol['BTC-EUR']).toMatchObject({ next: null, reasonCode: 'not-applicable' });
    expect(bySymbol.TSLA).toMatchObject({ next: null, reasonCode: 'not-tracked' });
  });

  it('counts the held symbols with a date and the held ones the run matched', () => {
    expect(report).toMatchObject({ today: '2026-10-28', asOf: NOW.toISOString(), held: 5, withDate: 3 });
    expect(report.lastRun).toMatchObject({ status: 'ok', rows: 5000, events: 2, matchedHeld: 2 });
  });

  it('keeps the counts of a run that did not say them as null and passes the budget and refresh state through', () => {
    const budget = { provider: 'Alpha Vantage' as const, day: '2026-10-28', used: 24, limit: 25, remaining: 1, calendarUsed: 1, calendarLimit: 1 };
    const refresh: RefreshReport = { available: false, reason: 'Nearly used', nextAllowedAt: '2026-10-29T00:00:00.000Z' };
    const bare = buildEarningsDatesReport(input({ run: run({ rows: undefined, events: undefined, matchedSymbols: undefined }), lastOk: null, budget, refresh }));
    expect(bare.lastRun).toMatchObject({ rows: null, events: null, matchedHeld: null });
    expect(bare.lastSuccess).toBeNull();
    expect(bare.budget).toEqual(budget);
    expect(bare.refresh).toEqual(refresh);
  });

  it('is valid against the schema the web client parses it with', () => {
    expect(earningsDatesSchema.safeParse(report).success).toBe(true);
    expect(earningsDatesSchema.safeParse(buildEarningsDatesReport(input({ run: null, lastOk: null }))).success).toBe(true);
  });

  it('sorts equal dates by symbol', () => {
    const twins = buildEarningsDatesReport(input({ held: [{ symbol: 'GOOG', name: 'GOOG' }, { symbol: 'GOOGL', name: 'GOOGL' }], next: new Map() }));
    expect(twins.symbols.map((entry) => entry.symbol)).toEqual(['GOOG', 'GOOGL']);
  });
});

describe('nextEarningsEvents', () => {
  const base = { today: '2026-10-28', transactions: [tx('GOOGL')], watchlist: ['MSFT'], profiles: { GOOGL: { symbol: 'GOOGL', name: 'Alphabet Inc', assetClass: 'STOCK' as const, currency: 'USD' } } };

  it('takes the earliest event on or after today of each held or watched symbol, and none of a symbol the user neither holds nor watches', () => {
    const next = nextEarningsEvents({
      ...base,
      earnings: [
        { symbol: 'GOOGL', date: '2026-10-20', source: 'alphavantage' },
        { symbol: 'GOOGL', date: '2026-10-28', source: 'alphavantage', timeOfDay: 'AMC' },
        { symbol: 'GOOGL', date: '2027-01-27', source: 'alphavantage' },
        { symbol: 'MSFT', date: '2026-10-29', source: 'alphavantage' },
        { symbol: 'TSLA', date: '2026-10-30', source: 'alphavantage' },
      ],
    });
    expect([...next].map(([symbol, event]) => `${symbol} ${event.date} ${event.earningsPhase} ${event.origin}`)).toEqual(['GOOGL 2026-10-28 scheduled HOLDING', 'MSFT 2026-10-29 scheduled WATCHLIST']);
    expect(next.get('GOOGL')?.name).toBe('Alphabet Inc');
  });

  it('shows a report released today as reported, and projects the next date from the last report when the provider has none', () => {
    const reported = nextEarningsEvents({ ...base, earnings: [], reportedEarnings: [{ symbol: 'GOOGL', reportDate: '2026-10-28', period: 'Q3 2026' }] });
    expect(reported.get('GOOGL')).toMatchObject({ earningsPhase: 'reported', date: '2026-10-28' });
    const projected = nextEarningsEvents({ ...base, earnings: [], reportedEarnings: [{ symbol: 'GOOGL', reportDate: '2026-08-10' }] });
    expect(projected.get('GOOGL')).toMatchObject({ earningsPhase: 'projected', date: '2026-11-09' });
  });
});
