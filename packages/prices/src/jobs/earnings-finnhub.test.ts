import type { Item } from '@portfolio/platform';
import { earningsConfirmation, earningsDatesConclusion, parseEarningsRun, type StoredEarningsEvent } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { HttpClient } from '../http.js';
import { TokenBucket } from '../limits.js';
import { FinnhubEarnings, finnhubChunks, parseFinnhubRows } from '../providers/finnhub.js';
import { earningsTargets } from '../providers/calendar.js';
import { PriceRepository } from '../repository.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { drive, harness, padCalendar, track, type Harness } from '../testing/harness.js';
import { mergeEarningsSources, trackSeen } from './earnings-merge.js';
import { createRefreshCalendarJob } from './refresh-calendar.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-02T04:30:00.000Z');
const TODAY = '2026-11-02';
const KEY = 'fh-test-key';

/** The real response shape of `/calendar/earnings` (documented fields), with invented values. */
const row = (symbol: string, date: string, hour: string) => ({ date, epsActual: null, epsEstimate: 1.58, hour, quarter: 3, revenueActual: null, revenueEstimate: 158_000_000_000, symbol, year: 2026 });
const answer = (...rows: unknown[]) => ({ earningsCalendar: rows });
const EMPTY = answer();
const AV_CSV = padCalendar('symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nAMZN,AMAZON COM INC,2026-11-05,2026-09-30,1.5,USD,\nKO,COCA COLA CO,2026-11-24,2026-09-30,0.7,USD,pre-market\n');

function live(options: { alpha?: unknown[]; finnhub?: unknown[]; env?: Record<string, string> } = {}): Harness {
  const fake = new FakeFetch();
  if (options.alpha !== undefined) fake.add('alphavantage.co', ...options.alpha);
  if (options.finnhub !== undefined) fake.add('finnhub.io/api/v1/calendar/earnings', ...options.finnhub);
  return harness({ start: NOW, fake, env: { ALPHAVANTAGE_API_KEY: options.alpha === undefined ? '' : 'av-key', FINNHUB_API_KEY: options.finnhub === undefined ? '' : KEY, ...options.env } });
}

const run = (h: Harness, trigger: 'scheduled' | 'manual' = 'scheduled') => drive(h, createRefreshCalendarJob(h.deps), { trigger });
const item = (h: Harness, sk: string): Item | undefined => h.store.snapshot().find((candidate) => candidate.PK === 'CALENDAR' && candidate.SK === sk);
const lastRun = (h: Harness) => parseEarningsRun(item(h, 'EARNINGS#LASTRUN'));
const stored = (h: Harness): StoredEarningsEvent[] => h.store.snapshot().filter((candidate) => candidate.SK.startsWith('EARN#')) as unknown as StoredEarningsEvent[];
const finnhubCalls = (h: Harness) => h.fake.requests.filter((request) => request.url.includes('finnhub.io'));

describe('FinnhubEarnings', () => {
  const http = (fake: FakeFetch) => new HttpClient({ provider: 'finnhub', fetch: fake.fetch, sleep: () => Promise.resolve(), random: () => 0 });
  const bucket = () => new TokenBucket(3, 1, () => 0, () => Promise.resolve(), 2000);
  const source = (fake: FakeFetch) => new FinnhubEarnings({ apiKey: KEY, http: http(fake), bucket: bucket() });

  it('asks for the next 21 days in three weekly calls, with the key in a header and not in the URL', async () => {
    const fake = new FakeFetch().add('finnhub.io/api/v1/calendar/earnings', EMPTY);
    await source(fake).fetchReport(['AMZN'], TODAY);
    expect(fake.urls).toEqual([
      'https://finnhub.io/api/v1/calendar/earnings?from=2026-11-02&to=2026-11-08',
      'https://finnhub.io/api/v1/calendar/earnings?from=2026-11-09&to=2026-11-15',
      'https://finnhub.io/api/v1/calendar/earnings?from=2026-11-16&to=2026-11-23',
    ]);
    expect(fake.requests.every((request) => request.headers['x-finnhub-token'] === KEY && !request.url.includes(KEY))).toBe(true);
    expect(finnhubChunks('2026-12-28')).toHaveLength(3);
  });

  it('keeps the tracked tickers, maps bmo, amc and dmh and leaves any other hour unknown', async () => {
    const fake = new FakeFetch().add(
      'finnhub.io',
      answer(row('AMZN', '2026-11-05', 'amc'), row('NOHOLD', '2026-11-05', 'bmo'), row('BRK.B', '2026-11-04', 'DMH'), row('KO', '2026-11-04', 'bmo')),
      answer(row('NVDA', '2026-11-12', ''), { symbol: 'AMZN', date: 'garbage', hour: 'amc' }, 'not-a-row'),
      answer(row('AMZN', '2026-11-05', 'amc'), row('NVDA', '2026-11-30', 'bmo')),
    );
    const report = await source(fake).fetchReport(['AMZN', 'BRK-B', 'KO', 'NVDA'], TODAY);
    expect(report.events.map((event) => `${event.symbol} ${event.date} ${event.timeOfDay}`)).toEqual(['AMZN 2026-11-05 AMC', 'BRK-B 2026-11-04 DMH', 'KO 2026-11-04 BMO', 'NVDA 2026-11-12 unknown', 'NVDA 2026-11-30 BMO']);
    expect(report.events[0]).toEqual({ symbol: 'AMZN', date: '2026-11-05', epsEstimate: 1.58, timeOfDay: 'AMC', source: 'finnhub' });
    expect(report.rows).toBe(9);
    expect(report.listed).toEqual(['AMZN', 'BRK-B', 'KO', 'NVDA']);
  });

  it('skips events before today, and matches a curated alias but not a bare ticker of another exchange', async () => {
    const fake = new FakeFetch().add('finnhub.io', answer(row('AMZN', '2026-10-30', 'amc'), row('CRM', '2026-11-05', 'amc'), row('ASML', '2026-11-05', 'bmo')));
    const report = await source(fake).fetchReport(['AMZN', 'FOO.DE', 'ASML.AS'], TODAY);
    expect(report.events.map((event) => event.symbol)).toEqual(['FOO.DE']);
    expect(report.listed).toEqual(['AMZN', 'FOO.DE']);
  });

  it('makes no call when nothing tracked can be looked up', async () => {
    const fake = new FakeFetch();
    expect(await source(fake).fetchReport(['BTC-EUR'], TODAY)).toEqual({ events: [], rows: 0, listed: [], unvouched: [] });
    expect(fake.urls).toEqual([]);
    expect(await source(fake).fetch(['BTC-EUR'], TODAY)).toEqual([]);
  });

  it('says what a refused key means, and passes other failures through', async () => {
    for (const status of [401, 403]) {
      const fake = new FakeFetch().add('finnhub.io', { status });
      await expect(source(fake).fetchReport(['AMZN'], TODAY)).rejects.toThrow(`finnhub: HTTP ${status}: the key was refused or has no access to the earnings calendar`);
    }
    await expect(source(new FakeFetch().add('finnhub.io', { status: 400 })).fetchReport(['AMZN'], TODAY)).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects an answer that is not a calendar', () => {
    expect(() => parseFinnhubRows({ error: 'nope' }, earningsTargets(['AMZN']))).toThrow('unexpected response');
    expect(() => parseFinnhubRows(null, earningsTargets(['AMZN']))).toThrow('unexpected response');
  });
});

describe('mergeEarningsSources and trackSeen', () => {
  const av = (date: string, extra: Partial<StoredEarningsEvent> = {}): StoredEarningsEvent => ({ symbol: 'AMZN', date, source: 'alphavantage', fiscalPeriodEnd: '2026-09-30', currency: 'USD', ...extra });
  const fh = (date: string, extra: Partial<StoredEarningsEvent> = {}): StoredEarningsEvent => ({ symbol: 'AMZN', date, source: 'finnhub', timeOfDay: 'AMC', epsEstimate: 1.6, ...extra });
  const none = new Map<string, StoredEarningsEvent[]>();

  it('the same date is one event: Alpha Vantage fields plus Finnhub time and estimate, Finnhub as the source', () => {
    const merged = mergeEarningsSources([av('2026-11-05', { timeOfDay: 'unknown' })], [fh('2026-11-05')], none, TODAY);
    expect(merged).toEqual({ events: [{ symbol: 'AMZN', date: '2026-11-05', fiscalPeriodEnd: '2026-09-30', currency: 'USD', epsEstimate: 1.6, timeOfDay: 'AMC', timeSource: 'finnhub', source: 'finnhub' }], conflicts: [] });
    const known = mergeEarningsSources([av('2026-11-05', { timeOfDay: 'BMO', epsEstimate: 1.5 })], [fh('2026-11-05', { timeOfDay: 'unknown' })], none, TODAY).events[0];
    expect(known).toMatchObject({ timeOfDay: 'BMO', epsEstimate: 1.5, source: 'finnhub' });
    expect(known).not.toHaveProperty('timeSource');
    const bare = mergeEarningsSources([av('2026-11-05')], [{ symbol: 'AMZN', date: '2026-11-05', source: 'finnhub' }], none, TODAY).events[0];
    expect(bare).toMatchObject({ source: 'finnhub' });
    expect(bare!.timeOfDay).toBeUndefined();
  });

  it('a different date of the same quarter is a conflict: Finnhub wins, and the loser is named', () => {
    const merged = mergeEarningsSources([av('2026-11-12')], [fh('2026-11-05')], none, TODAY);
    expect(merged.events.map((event) => `${event.source} ${event.date}`)).toEqual(['finnhub 2026-11-05']);
    expect(merged.conflicts).toEqual([{ symbol: 'AMZN', kept: { source: 'finnhub', date: '2026-11-05' }, dropped: { source: 'alphavantage', date: '2026-11-12' } }]);
  });

  it('a date that is already confirmed in the store wins over a new listing of another date', () => {
    const ahead = new Map([['AMZN', [av('2026-11-12', { reads: 3, firstSeenOn: '2026-10-28' })]]]);
    const merged = mergeEarningsSources([av('2026-11-12')], [fh('2026-11-05')], ahead, TODAY);
    expect(merged.events.map((event) => `${event.source} ${event.date}`)).toEqual(['alphavantage 2026-11-12']);
    expect(merged.conflicts).toEqual([{ symbol: 'AMZN', kept: { source: 'alphavantage', date: '2026-11-12' }, dropped: { source: 'finnhub', date: '2026-11-05' } }]);
  });

  it('dates of another quarter, and companies only one source lists, do not conflict', () => {
    const merged = mergeEarningsSources([av('2027-02-05'), { symbol: 'KO', date: '2026-11-24', source: 'alphavantage' }], [fh('2026-11-05'), { symbol: 'NVDA', date: '2026-11-11', source: 'finnhub' }], none, TODAY);
    expect(merged.events.map((event) => `${event.symbol} ${event.date}`)).toEqual(['AMZN 2026-11-05', 'AMZN 2027-02-05', 'KO 2026-11-24', 'NVDA 2026-11-11']);
    expect(merged.conflicts).toEqual([]);
  });

  it('counts a read once per day, starts a new date at one, and keeps what an old item did not record', () => {
    const [first] = trackSeen([fh('2026-11-05')], none, TODAY);
    expect(first).toMatchObject({ firstSeenOn: TODAY, lastSeenOn: TODAY, reads: 1 });
    const tomorrow = '2026-11-03';
    const ahead = new Map([['AMZN', [{ ...fh('2026-11-05'), ...first }]]]);
    expect(trackSeen([fh('2026-11-05')], ahead, TODAY)[0]).toMatchObject({ reads: 1, lastSeenOn: TODAY });
    expect(trackSeen([fh('2026-11-05')], ahead, tomorrow)[0]).toMatchObject({ firstSeenOn: TODAY, lastSeenOn: tomorrow, reads: 2 });
    expect(trackSeen([fh('2026-11-06')], ahead, tomorrow)[0]).toMatchObject({ firstSeenOn: tomorrow, reads: 1 });
    const old = new Map([['AMZN', [{ ...fh('2026-11-05'), updatedAt: '2026-11-01T05:30:00.000Z' }]]]);
    expect(trackSeen([fh('2026-11-05')], old, TODAY)[0]).toMatchObject({ firstSeenOn: '2026-11-01', lastSeenOn: TODAY, reads: 2 });
    const undated = new Map([['AMZN', [fh('2026-11-05')]]]);
    expect(trackSeen([fh('2026-11-05')], undated, TODAY)[0]).toMatchObject({ firstSeenOn: TODAY, reads: 1 });
  });
});

describe('the calendar job with Finnhub', () => {
  it('Finnhub alone (no Alpha Vantage key) stores the dates with time of day, and records both sources', async () => {
    const h = live({ finnhub: [answer(row('AMZN', '2026-11-05', 'amc')), EMPTY, EMPTY] });
    track(h.store, 'AMZN', 'ASML.AS');
    const { result } = await run(h);
    expect(result.earnings).toEqual({ status: 'ok', symbols: 1, events: 1, staleDeleted: 0 });
    expect(stored(h)).toEqual([expect.objectContaining({ symbol: 'AMZN', date: '2026-11-05', timeOfDay: 'AMC', source: 'finnhub', firstSeenOn: TODAY, lastSeenOn: TODAY, reads: 1 })]);
    expect(finnhubCalls(h)).toHaveLength(3);
    expect(lastRun(h)).toMatchObject({
      status: 'ok',
      rows: 1,
      events: 1,
      sources: [
        { source: 'alphavantage', status: 'no-key', reason: '' },
        { source: 'finnhub', status: 'ok', reason: '', rows: 1, events: 1, matchedSymbols: ['AMZN'] },
      ],
    });
    expect(earningsDatesConclusion(lastRun(h))).toEqual({ kind: 'partial', text: 'Dates come from Finnhub. Alpha Vantage is not configured (no ALPHAVANTAGE_API_KEY secret).' });
  });

  it('the same date on a second day is confirmed (inside 21 days); a changed date starts again', async () => {
    const h = live({ finnhub: [answer(row('AMZN', '2026-11-05', 'amc')), EMPTY, EMPTY, answer(row('AMZN', '2026-11-05', 'amc')), EMPTY, EMPTY, answer(row('AMZN', '2026-11-06', 'amc')), EMPTY, EMPTY] });
    track(h.store, 'AMZN');
    await run(h);
    expect(earningsConfirmation(stored(h)[0]!, TODAY).confirmed).toBe(false);
    await run(h);
    expect(stored(h)).toHaveLength(1);
    expect(earningsConfirmation(stored(h)[0]!, TODAY).confirmed).toBe(false);
    h.clock.advance(DAY);
    await run(h);
    expect(stored(h)[0]).toMatchObject({ date: '2026-11-05', reads: 2, firstSeenOn: TODAY, lastSeenOn: '2026-11-03' });
    expect(earningsConfirmation(stored(h)[0]!, '2026-11-03')).toMatchObject({ confirmed: true });
    h.clock.advance(DAY);
    await run(h);
    expect(stored(h).map((event) => `${event.date} ${event.reads}`)).toEqual(['2026-11-06 1']);
  });

  it('Alpha Vantage with a real-sized calendar plus Finnhub: one event on a shared date, both sources ok', async () => {
    const h = live({ alpha: [{ text: AV_CSV }], finnhub: [answer(row('AMZN', '2026-11-05', 'amc')), EMPTY, EMPTY] });
    track(h.store, 'AMZN', 'KO');
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', symbols: 2, events: 2 });
    expect(stored(h).map((event) => `${event.symbol} ${event.date} ${event.source} ${event.timeOfDay}`)).toEqual(['AMZN 2026-11-05 finnhub AMC', 'KO 2026-11-24 alphavantage BMO']);
    expect(earningsDatesConclusion(lastRun(h))).toEqual({ kind: 'ok', text: 'Dates come from Alpha Vantage and Finnhub.' });
  });

  it('a calendar with a handful of rows is provider-limited, not ok; Finnhub still delivers', async () => {
    const tiny = { text: 'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nZZ,FILLER,2026-11-05,,,,\n' };
    const h = live({ alpha: [tiny], finnhub: [answer(row('AMZN', '2026-11-05', 'amc')), EMPTY, EMPTY] });
    track(h.store, 'AMZN');
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', events: 1 });
    expect(lastRun(h)).toMatchObject({ status: 'ok', sources: [{ source: 'alphavantage', status: 'provider-limited', rows: 1 }, { source: 'finnhub', status: 'ok' }] });
    expect(earningsDatesConclusion(lastRun(h))?.kind).toBe('partial');
  });

  it('with Alpha Vantage limited and no Finnhub key the run is provider-limited and the conclusion says what to do', async () => {
    const tiny = { text: 'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nZZ,FILLER,2026-10-28,,,,\n' };
    const h = live({ alpha: [tiny] });
    track(h.store, 'GOOGL');
    const { result } = await run(h);
    expect(result.earnings).toEqual({ status: 'provider-limited', symbols: 0, events: 0, staleDeleted: 0 });
    expect(lastRun(h)).toMatchObject({ status: 'provider-limited', rows: 1 });
    expect(item(h, 'EARNINGS#LASTOK')).toBeUndefined();
    expect(earningsDatesConclusion(lastRun(h))?.text).toBe(
      'No provider date source is working. Alpha Vantage returned only 1 rows: its free plan does not provide the earnings calendar for this key. Finnhub is not configured: add a free key (the FINNHUB_API_KEY secret). Until then every date in the calendar is a projection (previous report + about 91 days).',
    );
  });

  it('a Finnhub failure is its own outcome; Alpha Vantage dates are still stored', async () => {
    const h = live({ alpha: [{ text: AV_CSV }], finnhub: [{ status: 401 }] });
    track(h.store, 'AMZN');
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', events: 1 });
    expect(lastRun(h)?.sources?.[1]).toEqual({ source: 'finnhub', status: 'failed', reason: 'finnhub: HTTP 401: the key was refused or has no access to the earnings calendar' });
    expect(earningsDatesConclusion(lastRun(h))?.text).toContain('Finnhub failed: finnhub: HTTP 401');
  });

  it('Finnhub failing alone ends the run as failed, a rate limit as rate-limited, with the class of the error', async () => {
    const failed = live({ finnhub: [{ status: 400 }] });
    track(failed.store, 'AMZN');
    expect((await run(failed)).result.earnings).toEqual({ status: 'failed', error: 'ProviderError' });
    const limited = live({ finnhub: [{ status: 429 }] });
    track(limited.store, 'AMZN');
    expect((await run(limited)).result.earnings).toMatchObject({ status: 'rate-limited', error: 'RateLimitError' });
  });

  it('spends three calls of the Finnhub budget a day; a day that cannot afford them skips the call, a manual run does not ask', async () => {
    const h = live({ finnhub: [EMPTY], env: { CALENDAR_FINNHUB_DAILY_CALLS: '2' } });
    track(h.store, 'AMZN');
    expect((await run(h)).result.earnings).toEqual({ status: 'budget-exhausted' });
    expect(finnhubCalls(h)).toHaveLength(0);
    expect(lastRun(h)).toMatchObject({ status: 'budget-exhausted', sources: [{ source: 'alphavantage', status: 'no-key' }, { source: 'finnhub', status: 'budget-exhausted' }] });
    await run(h, 'manual');
    expect(finnhubCalls(h)).toHaveLength(3);
    const day = live({ finnhub: [EMPTY] });
    track(day.store, 'AMZN');
    await run(day);
    expect(await new PriceRepository(day.store).callsUsedOn('finnhub', TODAY)).toMatchObject({ calendarUsed: 3 });
  });

  it('removes a stored date Finnhub no longer lists inside its window, but leaves a later one Alpha Vantage listed', async () => {
    const h = live({ finnhub: [answer(row('AMZN', '2026-11-06', 'amc')), EMPTY, EMPTY] });
    track(h.store, 'AMZN');
    h.store.load([
      { PK: 'TICKER#AMZN', SK: 'EARN#2026-11-05', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2026-11-05', source: 'finnhub' },
      { PK: 'TICKER#AMZN', SK: 'EARN#2027-02-05', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2027-02-05', source: 'alphavantage' },
    ]);
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ staleDeleted: 1 });
    expect(stored(h).map((event) => event.date).toSorted((a, b) => a.localeCompare(b))).toEqual(['2026-11-06', '2027-02-05']);
  });

  it('a full Alpha Vantage calendar replaces a stored date it no longer lists, wherever it was', async () => {
    const h = live({ alpha: [{ text: AV_CSV }] });
    track(h.store, 'AMZN');
    h.store.load([{ PK: 'TICKER#AMZN', SK: 'EARN#2027-02-05', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2027-02-05', source: 'alphavantage' }]);
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', staleDeleted: 1 });
    expect(stored(h).map((event) => event.date)).toEqual(['2026-11-05']);
  });

  it('records a conflict between the two sources', async () => {
    const h = live({ alpha: [{ text: AV_CSV }], finnhub: [answer(row('AMZN', '2026-11-04', 'bmo')), EMPTY, EMPTY] });
    track(h.store, 'AMZN');
    await run(h);
    expect(stored(h).map((event) => `${event.date} ${event.source}`)).toEqual(['2026-11-04 finnhub']);
    expect(lastRun(h)?.conflicts).toEqual([{ symbol: 'AMZN', kept: { source: 'finnhub', date: '2026-11-04' }, dropped: { source: 'alphavantage', date: '2026-11-05' } }]);
  });

  it('reads the stored upcoming events of the symbols from today on', async () => {
    const h = live({ finnhub: [EMPTY] });
    h.store.load([
      { PK: 'TICKER#AMZN', SK: 'EARN#2026-11-01', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2026-11-01', source: 'finnhub' },
      { PK: 'TICKER#AMZN', SK: 'EARN#2026-11-05', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2026-11-05', source: 'finnhub', reads: 2 },
    ]);
    const ahead = await new PriceRepository(h.store).upcomingEarnings(['AMZN', 'KO'], TODAY);
    expect(ahead.get('AMZN')).toEqual([{ symbol: 'AMZN', date: '2026-11-05', source: 'finnhub', reads: 2 }]);
    expect(ahead.get('KO')).toEqual([]);
  });
});
