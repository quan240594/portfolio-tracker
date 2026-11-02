import { describe, expect, it } from 'vitest';
import { buildCalendar, earningsConfirmation, nextEarningsEvents, type CalendarData, type CalendarEvent, type StoredEarningsEvent } from './calendar.js';
import { calendarToIcs } from './calendar-ics.js';
import { earningsDatesConclusion, parseEarningsRun, whyNoEarningsDate, type EarningsRunRecord } from './earnings-dates.js';
import type { Transaction } from './types.js';

const TODAY = '2026-11-02';
const stored = (over: Partial<StoredEarningsEvent> = {}): StoredEarningsEvent => ({ symbol: 'AMZN', date: '2026-11-10', source: 'finnhub', ...over });

describe('earningsConfirmation', () => {
  it('(i) a date the source flags as confirmed is confirmed, whatever its age or distance', () => {
    expect(earningsConfirmation(stored({ date: '2027-01-30', confirmed: true, confirmedBy: 'finnhub' }), TODAY)).toEqual({ confirmed: true, basis: 'Flagged as confirmed by Finnhub.' });
    expect(earningsConfirmation(stored({ confirmed: true, source: 'alphavantage' }), TODAY).basis).toBe('Flagged as confirmed by Alpha Vantage.');
    expect(earningsConfirmation(stored({ confirmed: true, source: 'other' }), TODAY).basis).toBe('Flagged as confirmed by other.');
  });

  it('(ii) needs the same date on two separate days and at most 21 days ahead', () => {
    expect(earningsConfirmation(stored({ date: '2026-11-23', reads: 2, firstSeenOn: '2026-10-30', lastSeenOn: TODAY }), TODAY)).toEqual({
      confirmed: true,
      basis: 'Finnhub has listed this date on 2 separate days, first seen 30-10-2026, and it is 21 days ahead.',
    });
    expect(earningsConfirmation(stored({ date: '2026-11-23', reads: 9 }), TODAY).basis).toBe('Finnhub has listed this date on 9 separate days, and it is 21 days ahead.');
  });

  it('is not confirmed by a single read, however close the date is', () => {
    for (const reads of [undefined, 0, 1]) {
      const result = earningsConfirmation(stored({ date: '2026-11-03', reads }), TODAY);
      expect(result.confirmed).toBe(false);
      expect(result.basis).toBe('Provider date, listed on 1 day so far: it is confirmed once the provider has listed the same date on 2 separate days.');
    }
  });

  it('is not confirmed more than 21 days ahead, even when it was listed on many days', () => {
    const result = earningsConfirmation(stored({ date: '2026-11-24', reads: 30 }), TODAY);
    expect(result.confirmed).toBe(false);
    expect(result.basis).toContain('Provider date, 22 days ahead');
  });

  it('(iii) a date that has passed is confirmed', () => {
    expect(earningsConfirmation(stored({ date: TODAY }), TODAY)).toEqual({ confirmed: true, basis: 'The date has passed.' });
    expect(earningsConfirmation(stored({ date: '2026-10-29' }), TODAY).confirmed).toBe(true);
  });

  it('a changed date is a new item, so it starts again at one read', () => {
    expect(earningsConfirmation(stored({ date: '2026-11-12', reads: 1, firstSeenOn: TODAY }), TODAY).confirmed).toBe(false);
  });
});

const buy: Transaction = { id: 't1', userId: 'u', portfolioId: 'p', date: '2025-01-02', type: 'BUY', symbol: 'AMZN', quantity: 1, price: 100, fee: 0, currency: 'USD', createdAt: '2025-01-02T00:00:00Z' };
const data = (over: Partial<CalendarData>): CalendarData => ({
  today: TODAY,
  transactions: [buy],
  quotes: {},
  profiles: { AMZN: { symbol: 'AMZN', name: 'Amazon.com', assetClass: 'STOCK', currency: 'USD' } },
  fx: { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-11-02T00:00:00Z' },
  dividendEvents: [],
  earnings: [],
  splits: [],
  watchlist: [],
  ...over,
});
const earningsEvents = (over: Partial<CalendarData>): CalendarEvent[] => buildCalendar(data(over), { from: '2026-10-01', to: '2027-03-31', scope: 'all', types: ['EARNINGS'] }).events;

describe('earnings events in the calendar', () => {
  it('a provider date within the window and listed twice is Confirmed, with its basis and release time', () => {
    const [event] = earningsEvents({ earnings: [stored({ date: '2026-11-05', reads: 2, firstSeenOn: '2026-11-01', timeOfDay: 'AMC', timeSource: 'finnhub' })] });
    expect(event).toMatchObject({ status: 'CONFIRMED', earningsPhase: 'scheduled', source: 'finnhub' });
    expect(event!.basis).toContain('listed this date on 2 separate days');
    expect(event!.release).toMatchObject({ kind: 'typical', source: 'finnhub', short: '~16:05 ET = ~22:05 Amsterdam' });
    expect(event!.description).toContain('After the close, typically ~16:05 ET = ~22:05 Amsterdam. Finnhub has listed this date');
  });

  it('a provider date listed once stays Scheduled (ESTIMATED), and says what is missing', () => {
    const [event] = earningsEvents({ earnings: [stored({ date: '2026-11-05', reads: 1 })] });
    expect(event).toMatchObject({ status: 'ESTIMATED', earningsPhase: 'scheduled' });
    expect(event!.basis).toContain('confirmed once the provider has listed the same date on 2 separate days');
  });

  it('the release time uses the summer/winter gap of the day itself', () => {
    const [event] = earningsEvents({ earnings: [stored({ date: '2026-10-30', timeOfDay: 'AMC' })] });
    expect(event!.release?.short).toBe('~16:05 ET = ~21:05 Amsterdam');
  });

  it('a provider date left over after the company reported (less than 45 days after the report) is dropped; the projection takes over', () => {
    const events = earningsEvents({
      earnings: [stored({ date: '2026-11-20', source: 'alphavantage' })],
      reportedEarnings: [{ symbol: 'AMZN', reportDate: '2026-10-29', period: 'Q3 2026' }],
    });
    expect(events.map((e) => `${e.earningsPhase} ${e.date}`)).toEqual(['reported 2026-10-29', 'projected 2027-01-28']);
  });

  it('a provider date 45 days or more after the report is the next quarter and stays', () => {
    const events = earningsEvents({ earnings: [stored({ date: '2027-01-28' })], reportedEarnings: [{ symbol: 'AMZN', reportDate: '2026-10-29' }] });
    expect(events.map((e) => `${e.earningsPhase} ${e.date}`)).toEqual(['reported 2026-10-29', 'scheduled 2027-01-28']);
  });

  it('an exact release instant of the source is shown as exact', () => {
    const [event] = earningsEvents({ earnings: [stored({ date: '2026-11-05', timeOfDay: 'AMC', releaseAt: '2026-11-05T21:10:00Z', timeSource: 'company' })] });
    expect(event!.release).toMatchObject({ kind: 'exact', text: 'Released at 16:10 ET = 22:10 Amsterdam' });
  });

  it('is the next event of the symbol with its release', () => {
    const next = nextEarningsEvents({ today: TODAY, transactions: [buy], watchlist: [], profiles: {}, earnings: [stored({ date: '2026-11-05', timeOfDay: 'BMO' })] });
    expect(next.get('AMZN')?.release?.kind).toBe('typical');
  });
});

describe('.ics export of earnings', () => {
  const unfold = (ics: string) => ics.replaceAll('\r\n ', '').split('\r\n');

  it('keeps an event with a typical time all-day and puts the time and the basis in the description', () => {
    const [event] = earningsEvents({ earnings: [stored({ date: '2026-11-05', reads: 2, timeOfDay: 'AMC', timeSource: 'finnhub' })] });
    const lines = unfold(calendarToIcs([event!], { now: new Date('2026-11-02T09:00:00Z') }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20261105');
    expect(lines).toContain('DTEND;VALUE=DATE:20261106');
    expect(lines.find((line) => line.startsWith('DESCRIPTION:'))).toContain(String.raw`Release time: After the close\, typically ~16:05 ET = ~22:05 Amsterdam`);
    expect(lines.find((line) => line.startsWith('DESCRIPTION:'))).toContain('Date: Finnhub has listed this date');
  });

  it('makes an event with an exact instant a one-hour timed event in UTC', () => {
    const [event] = earningsEvents({ earnings: [stored({ date: '2026-11-05', releaseAt: '2026-11-05T21:10:00Z' })] });
    const lines = unfold(calendarToIcs([event!], { now: new Date('2026-11-02T09:00:00Z') }));
    expect(lines).toContain('DTSTART:20261105T211000Z');
    expect(lines).toContain('DTEND:20261105T221000Z');
  });
});

const record = (over: Partial<EarningsRunRecord> = {}): EarningsRunRecord => ({ at: '2026-11-02T04:30:00.000Z', trigger: 'scheduled', status: 'ok', reason: '', tracked: 3, rows: 1, events: 0, matchedSymbols: [], listed: [], unvouched: [], ...over });

describe('earningsDatesConclusion', () => {
  it('says nothing before the first run or for a run the guard skipped', () => {
    expect(earningsDatesConclusion(null)).toBeNull();
    expect(earningsDatesConclusion(record({ status: 'skipped' }))).toBeNull();
  });

  it('broken: Alpha Vantage answered with a handful of rows and Finnhub has no key', () => {
    const conclusion = earningsDatesConclusion(record({ status: 'provider-limited', sources: [{ source: 'alphavantage', status: 'provider-limited', reason: '', rows: 1 }, { source: 'finnhub', status: 'no-key', reason: '' }] }));
    expect(conclusion?.kind).toBe('broken');
    expect(conclusion?.text).toBe(
      'No provider date source is working. Alpha Vantage returned only 1 rows: its free plan does not provide the earnings calendar for this key. Finnhub is not configured: add a free key (the FINNHUB_API_KEY secret). Until then every date in the calendar is a projection (previous report + about 91 days).',
    );
  });

  it('broken: a record from before there were several sources reads as an Alpha Vantage attempt', () => {
    expect(earningsDatesConclusion(record({ status: 'provider-limited' }))?.text).toContain('Alpha Vantage returned only 1 rows');
    expect(earningsDatesConclusion(record({ status: 'failed', reason: 'boom' }))?.text).toContain('Alpha Vantage failed: boom.');
    expect(earningsDatesConclusion(record({ status: 'rate-limited', reason: 'slow down' }))?.text).toContain('Alpha Vantage: rate limit reached (slow down).');
    expect(earningsDatesConclusion(record({ status: 'budget-exhausted' }))?.text).toContain('the daily allowance for the calendar was already used');
    expect(earningsDatesConclusion(record({ status: 'no-provider' }))?.text).toContain('Alpha Vantage is not configured (no ALPHAVANTAGE_API_KEY secret).');
    expect(earningsDatesConclusion(record({ status: 'no-symbols' }))?.text).toContain('Alpha Vantage failed.');
  });

  it('broken: Finnhub is configured but fails', () => {
    const conclusion = earningsDatesConclusion(record({ status: 'failed', sources: [{ source: 'alphavantage', status: 'provider-limited', reason: '', rows: 3 }, { source: 'finnhub', status: 'failed', reason: 'HTTP 401' }] }));
    expect(conclusion?.text).toContain('Finnhub failed: HTTP 401.');
  });

  it('ok: both sources deliver', () => {
    const sources = [{ source: 'alphavantage' as const, status: 'ok' as const, reason: '', rows: 4000 }, { source: 'finnhub' as const, status: 'ok' as const, reason: '', rows: 800 }];
    expect(earningsDatesConclusion(record({ sources }))).toEqual({ kind: 'ok', text: 'Dates come from Alpha Vantage and Finnhub.' });
  });

  it('partial: Finnhub works, Alpha Vantage is limited', () => {
    const conclusion = earningsDatesConclusion(record({ sources: [{ source: 'alphavantage', status: 'provider-limited', reason: '', rows: 1 }, { source: 'finnhub', status: 'ok', reason: '', rows: 800, events: 5 }] }));
    expect(conclusion?.kind).toBe('partial');
    expect(conclusion?.text).toBe('Dates come from Finnhub. Alpha Vantage returned only 1 rows: its free plan does not provide the earnings calendar for this key.');
  });

  it('a second run the same day that found the calls already spent does not hide what the last real read found', () => {
    const sources = [{ source: 'alphavantage' as const, status: 'ok' as const, reason: '', rows: 4000 }, { source: 'finnhub' as const, status: 'ok' as const, reason: '', rows: 800 }];
    const spent = record({ status: 'budget-exhausted', sources: [{ source: 'alphavantage', status: 'budget-exhausted', reason: '' }, { source: 'finnhub', status: 'budget-exhausted', reason: '' }] });
    expect(earningsDatesConclusion(spent, undefined, record({ sources }))).toEqual({ kind: 'ok', text: 'Dates come from Alpha Vantage and Finnhub.' });
    expect(earningsDatesConclusion(spent, undefined, null)?.kind).toBe('broken');
  });

  it('the keys the deployment knows override what the record says about a missing key', () => {
    const sources = [{ source: 'alphavantage' as const, status: 'ok' as const, reason: '', rows: 4000 }];
    expect(earningsDatesConclusion(record({ sources }), { alphavantage: true, finnhub: false })?.text).toContain('Finnhub is not configured: add a free key');
    expect(earningsDatesConclusion(record({ sources }), { alphavantage: true, finnhub: true })?.text).toBe('Dates come from Alpha Vantage. Finnhub is not configured: add a free key (the FINNHUB_API_KEY secret).');
  });
});

describe('whyNoEarningsDate with several sources', () => {
  const base = { symbol: 'AMZN', name: 'Amazon', trackedAt: '2026-10-01T00:00:00Z' };

  it('names the limited provider and the way out', () => {
    const run = record({ status: 'provider-limited', sources: [{ source: 'alphavantage', status: 'provider-limited', reason: '', rows: 1 }] });
    expect(whyNoEarningsDate({ ...base, run, lastOk: null })).toEqual({
      code: 'provider-limited',
      text: 'Alpha Vantage returned only 1 rows: its free plan does not provide the earnings calendar for this key (2026-11-02). Add a free Finnhub key (the FINNHUB_API_KEY secret) to get dates and release times.',
    });
    expect(whyNoEarningsDate({ ...base, run: record({ status: 'provider-limited', rows: undefined }), lastOk: null }).text).toContain('only a few rows');
  });

  it('says which sources answered when none lists the company', () => {
    const run = record({ sources: [{ source: 'alphavantage', status: 'ok', reason: '', rows: 4000 }, { source: 'finnhub', status: 'ok', reason: '', rows: 800 }, { source: 'finnhub', status: 'failed', reason: 'x' }] });
    expect(whyNoEarningsDate({ ...base, run, lastOk: run })).toEqual({
      code: 'not-listed',
      text: 'Not listed by the sources that answered on 2026-11-02: Alpha Vantage: 4000 rows; Finnhub: 800 rows.',
    });
  });
});

describe('parseEarningsRun with sources', () => {
  it('reads the sources and conflicts and drops damaged ones', () => {
    const item = {
      PK: 'CALENDAR',
      SK: 'EARNINGS#LASTRUN',
      at: '2026-11-02T04:30:00.000Z',
      status: 'ok',
      sources: [{ source: 'finnhub', status: 'ok', reason: '', rows: 12, events: 3, matchedSymbols: ['AMZN'] }, { source: 'alphavantage', status: 'no-key' }],
      conflicts: [{ symbol: 'AMZN', kept: { source: 'finnhub', date: '2026-11-05' }, dropped: { source: 'alphavantage', date: '2026-11-07' } }],
    };
    expect(parseEarningsRun(item)).toMatchObject({
      sources: [{ source: 'finnhub', status: 'ok', rows: 12, events: 3, matchedSymbols: ['AMZN'] }, { source: 'alphavantage', status: 'no-key', reason: '' }],
      conflicts: [{ symbol: 'AMZN', kept: { source: 'finnhub', date: '2026-11-05' }, dropped: { source: 'alphavantage', date: '2026-11-07' } }],
    });
    expect(parseEarningsRun({ ...item, sources: 'oops', conflicts: [{ nope: true }] })).not.toHaveProperty('sources');
  });
});
