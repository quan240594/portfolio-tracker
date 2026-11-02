import { createConsoleLogger, type Item } from '@portfolio/platform';
import { earningsConfirmation, earningsDatesConclusion, parseEarningsRun, type StoredEarningsEvent } from '@portfolio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriceRepository } from '../repository.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { drive, harness, padCalendar, track, type Harness } from '../testing/harness.js';
import { createRefreshCalendarJob, type CalendarJobResult } from './refresh-calendar.js';

afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const NOW = new Date('2026-11-02T04:30:00.000Z');
const TODAY = '2026-11-02';
const KEY = 'fh-test-key';

/** The real response shape of `/calendar/earnings?symbol=..` (documented fields), with invented values. */
const row = (symbol: string, date: string, hour: string, quarter = 3, year = 2026) => ({ date, epsActual: null, epsEstimate: 1.58, hour, quarter, revenueActual: null, revenueEstimate: 158_000_000_000, symbol, year });
const answer = (...rows: unknown[]) => ({ earningsCalendar: rows });
const EMPTY = answer();
const AV_CSV = padCalendar('symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nAMZN,AMAZON COM INC,2026-11-05,2026-09-30,1.5,USD,\nKO,COCA COLA CO,2026-11-24,2026-09-30,0.7,USD,pre-market\n');

/** What the owner's key returned for held companies on 2 Nov 2026 (dates as the API gave them). */
const LIVE = {
  AMZN: answer(row('AMZN', '2026-10-31', 'amc', 3), row('AMZN', '2027-02-05', 'amc', 4)),
  KMB: answer(row('KMB', '2026-11-05', 'bmo')),
  NVO: answer(row('NVO', '2026-11-04', 'bmo')),
  APP: answer(row('APP', '2026-11-04', 'amc')),
  GE: EMPTY,
};

interface Options {
  alpha?: unknown[];
  finnhub?: Record<string, unknown> | false;
  env?: Record<string, string>;
  /** The held companies; absent: every tracked symbol that is not crypto. */
  held?: string[];
}

function live(options: Options = {}): Harness {
  const fake = new FakeFetch();
  if (options.alpha !== undefined) fake.add('alphavantage.co', ...options.alpha);
  for (const [ticker, reply] of Object.entries(options.finnhub || {})) fake.add(`finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&`, reply);
  const h = harness({ start: NOW, fake, env: { ALPHAVANTAGE_API_KEY: options.alpha === undefined ? '' : 'av-key', FINNHUB_API_KEY: options.finnhub === undefined ? '' : KEY, ...options.env } });
  if (options.held !== undefined) {
    const held = options.held;
    h.deps.heldCompanies = () => Promise.resolve(held);
  }
  return h;
}

const run = (h: Harness, trigger: 'scheduled' | 'manual' = 'scheduled') => drive(h, createRefreshCalendarJob(h.deps), { trigger });
const item = (h: Harness, sk: string, pk = 'CALENDAR'): Item | undefined => h.store.snapshot().find((candidate) => candidate.PK === pk && candidate.SK === sk);
const lastRun = (h: Harness) => parseEarningsRun(item(h, 'EARNINGS#LASTRUN'));
const stored = (h: Harness): StoredEarningsEvent[] => h.store.snapshot().filter((candidate) => candidate.SK.startsWith('EARN#')) as unknown as StoredEarningsEvent[];
const finnhubCalls = (h: Harness) => h.fake.requests.filter((request) => request.url.includes('finnhub.io'));
const askedOrder = (h: Harness): string[] => finnhubCalls(h).map((request) => /symbol=([^&]+)&/.exec(request.url)![1]!);
const finnhubRun = (h: Harness) => lastRun(h)?.sources?.find((source) => source.source === 'finnhub');
const eventLines = (h: Harness): string[] => stored(h).map((event) => `${event.symbol} ${event.date} ${event.timeOfDay} ${event.source}`).toSorted((a, b) => a.localeCompare(b));

/** The step by step run: how many Finnhub requests each step made. */
async function stepwise(h: Harness, trigger: 'scheduled' | 'manual' = 'scheduled', cursor?: string, counts: number[] = [], delays: (number | undefined)[] = []): Promise<{ counts: number[]; delays: (number | undefined)[]; result: CalendarJobResult }> {
  const before = finnhubCalls(h).length;
  const step = await createRefreshCalendarJob(h.deps)({ payload: { trigger }, cursor });
  counts.push(finnhubCalls(h).length - before);
  if (step.done) return { counts, delays, result: step.result };
  delays.push(step.delayMs);
  if (step.delayMs) h.clock.advance(step.delayMs);
  return stepwise(h, trigger, step.next, counts, delays);
}

describe('the calendar job asks Finnhub for each held company', () => {
  it('makes one call per step, 2.1 s apart, and stores the next date of each company (the verified answers)', async () => {
    const h = live({ finnhub: LIVE, held: ['AMZN', 'KMB', 'NVO', 'APP', 'GE'] });
    track(h.store, 'AMZN', 'KMB', 'NVO', 'APP', 'GE');
    const times: number[] = [];
    const inner = h.deps.fetch;
    h.deps.fetch = (url, init) => {
      if (url.includes('finnhub.io')) times.push(h.clock.now().getTime());
      return inner(url, init);
    };
    const { counts, delays, result } = await stepwise(h);
    expect(counts.every((count) => count <= 1)).toBe(true);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(5);
    expect(times).toHaveLength(5);
    expect(times.slice(1).every((time, index) => time - times[index]! >= 2100)).toBe(true);
    expect(delays.every((delay) => delay === 2100)).toBe(true);
    expect(result.earnings).toEqual({ status: 'ok', symbols: 4, events: 5, staleDeleted: 0 });
    expect(eventLines(h)).toEqual(['AMZN 2026-10-31 AMC finnhub', 'AMZN 2027-02-05 AMC finnhub', 'APP 2026-11-04 AMC finnhub', 'KMB 2026-11-05 BMO finnhub', 'NVO 2026-11-04 BMO finnhub']);
    expect(finnhubCalls(h).every((request) => request.headers['x-finnhub-token'] === KEY && !request.url.includes(KEY))).toBe(true);
    expect(finnhubCalls(h)[0]!.url).toContain('from=2026-10-30&to=2027-01-31');
  });

  it('records the companies asked, how many have a date and the outcome of each, for the Diagnostics card', async () => {
    const h = live({ finnhub: LIVE, held: ['AMZN', 'KMB', 'NVO', 'APP', 'GE'] });
    track(h.store, 'AMZN', 'KMB', 'NVO', 'APP', 'GE');
    await run(h);
    expect(lastRun(h)).toMatchObject({ status: 'ok', rows: 5, events: 5, matchedSymbols: ['AMZN', 'APP', 'KMB', 'NVO'], sources: [{ source: 'alphavantage', status: 'no-key' }, expect.anything()] });
    const source = finnhubRun(h)!;
    expect(source).toMatchObject({ status: 'ok', reason: '', companies: 5, withDate: 4, rows: 5, events: 5 });
    expect(source.checks!.map((check) => `${check.symbol} ${check.result} ${check.date ?? '-'}`).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'AMZN date 2027-02-05',
      'APP date 2026-11-04',
      'GE none -',
      'KMB date 2026-11-05',
      'NVO date 2026-11-04',
    ]);
    expect(earningsDatesConclusion(lastRun(h))).toEqual({ kind: 'partial', text: 'Dates come from Finnhub. Alpha Vantage is not configured (no ALPHAVANTAGE_API_KEY secret).' });
  });

  it('asks only about held companies: no fund, no crypto, no bare ticker of another exchange; an alias is asked under its US ticker', async () => {
    const h = live({ finnhub: { AMZN: LIVE.AMZN, CRM: answer(row('CRM', '2026-11-05', 'amc')) }, held: ['AMZN', 'FOO.DE', 'ASML.AS', 'BTC-EUR'] });
    track(h.store, 'AMZN', 'FOO.DE', 'ASML.AS', 'BTC-EUR', 'SPY');
    await run(h);
    expect(askedOrder(h).toSorted((a, b) => a.localeCompare(b))).toEqual(['AMZN', 'CRM']);
    expect(eventLines(h)).toContain('FOO.DE 2026-11-05 AMC finnhub');
    expect(finnhubRun(h)).toMatchObject({ companies: 2, withDate: 2 });
  });

  it('without a list of held companies every tracked symbol that is not crypto is asked', async () => {
    const h = live({ finnhub: { AMZN: LIVE.AMZN, SPY: EMPTY } });
    track(h.store, 'AMZN', 'SPY', 'BTC-EUR');
    await run(h);
    expect(askedOrder(h).toSorted((a, b) => a.localeCompare(b))).toEqual(['AMZN', 'SPY']);
  });

  it('makes no call when no held company has a US ticker; the run still ends ok', async () => {
    const h = live({ finnhub: {}, held: ['ASML.AS'] });
    track(h.store, 'ASML.AS');
    const { result } = await run(h);
    expect(finnhubCalls(h)).toHaveLength(0);
    expect(result.earnings).toMatchObject({ status: 'ok', symbols: 0 });
    expect(finnhubRun(h)).toMatchObject({ status: 'ok', companies: 0, withDate: 0 });
  });

  it('keeps a report of the last three days next to the next one, and drops an upcoming row of the quarter just reported', async () => {
    const stale = answer(row('KO', '2026-10-31', 'bmo', 3), row('KO', '2026-11-06', 'bmo', 3), row('KO', '2027-02-10', 'bmo', 4));
    const h = live({ finnhub: { KO: stale }, held: ['KO'] });
    track(h.store, 'KO');
    await run(h);
    expect(eventLines(h)).toEqual(['KO 2026-10-31 BMO finnhub', 'KO 2027-02-10 BMO finnhub']);
  });
});

describe('the order of the companies and the daily allowance', () => {
  const held = ['KO', 'JNJ', 'PG', 'MSFT', 'AAPL'];
  const empty = Object.fromEntries(held.map((ticker) => [ticker, EMPTY]));

  it('companies reporting within a week come first, then the never asked ones, then the least recently asked', async () => {
    const h = live({ finnhub: empty, held });
    track(h.store, ...held);
    const repo = new PriceRepository(h.store);
    await repo.putState('KO', { finnhubCheckedAt: '2026-11-01T05:00:00.000Z' });
    await repo.putState('PG', { finnhubCheckedAt: '2026-10-30T05:00:00.000Z' });
    h.store.load([{ PK: 'TICKER#KO', SK: 'EARN#2026-11-06', entityType: 'EARNINGS_EVENT', symbol: 'KO', date: '2026-11-06', source: 'alphavantage' }]);
    await run(h);
    expect(askedOrder(h)).toEqual(['KO', 'AAPL', 'JNJ', 'MSFT', 'PG']);
    await run(h);
    expect(askedOrder(h).slice(5)).toEqual(['KO', 'AAPL', 'JNJ', 'MSFT', 'PG']);
  });

  it('with an allowance smaller than the number of companies the rest wait and come first the next day: all are refreshed in turn', async () => {
    const h = live({ finnhub: empty, held, env: { CALENDAR_FINNHUB_DAILY_CALLS: '3' } });
    track(h.store, ...held);
    await run(h);
    expect(askedOrder(h)).toEqual(['AAPL', 'JNJ', 'KO']);
    expect(finnhubRun(h)).toMatchObject({ status: 'ok', companies: 5, withDate: 0 });
    expect(finnhubRun(h)!.checks!.filter((check) => check.result === 'pending').map((check) => check.symbol)).toEqual(['MSFT', 'PG']);
    h.clock.advance(DAY);
    await run(h);
    expect(askedOrder(h).slice(3)).toEqual(['MSFT', 'PG', 'AAPL']);
  });

  it('spends one call of the Finnhub budget per company, once however often a step is delivered, and refuses the rest of the day', async () => {
    const h = live({ finnhub: empty, held, env: { CALENDAR_FINNHUB_DAILY_CALLS: '5' } });
    track(h.store, ...held);
    const handler = createRefreshCalendarJob(h.deps);
    const first = await handler({ payload: { trigger: 'scheduled' } });
    if (first.done) throw new Error('the run ended in one step');
    h.clock.advance(first.delayMs ?? 0);
    const second = await handler({ payload: { trigger: 'scheduled' }, cursor: first.next });
    const replay = await handler({ payload: { trigger: 'scheduled' }, cursor: first.next });
    expect(replay).toEqual(second);
    expect(await new PriceRepository(h.store).callsUsedOn('finnhub', TODAY)).toMatchObject({ calendarUsed: 2 });
    const rest = await drive(h, handler, { trigger: 'scheduled' });
    expect(rest.result.earnings).toMatchObject({ status: 'ok' });
    expect(await new PriceRepository(h.store).callsUsedOn('finnhub', TODAY)).toMatchObject({ calendarUsed: 5 });
    const calls = finnhubCalls(h).length;
    const { result: again } = await run(h, 'manual');
    expect(again.earnings).toEqual({ status: 'budget-exhausted' });
    expect(finnhubCalls(h)).toHaveLength(calls);
    expect(lastRun(h)).toMatchObject({ status: 'budget-exhausted', reason: '', sources: [{ source: 'alphavantage', status: 'no-key' }, { source: 'finnhub', status: 'budget-exhausted', companies: 5, withDate: 0 }] });
  });

  it('a manual run is paid from the same allowance: what is left of the day, most urgent first', async () => {
    const h = live({ finnhub: empty, held, env: { CALENDAR_FINNHUB_DAILY_CALLS: '7' } });
    track(h.store, ...held);
    await run(h);
    h.store.load([{ PK: 'TICKER#PG', SK: 'EARN#2026-11-04', entityType: 'EARNINGS_EVENT', symbol: 'PG', date: '2026-11-04', source: 'finnhub' }]);
    await run(h, 'manual');
    expect(askedOrder(h).slice(5)).toEqual(['PG', 'AAPL']);
  });
});

describe('failures at Finnhub', () => {
  const held = ['AMZN', 'KMB', 'NVO'];
  const messages = (h: Harness) => JSON.stringify([lastRun(h), h.store.snapshot()]);

  it('a 429 ends the run as rate-limited: the companies asked before are stored, the others wait, nothing is asked for ten minutes', async () => {
    const h = live({ finnhub: { AMZN: LIVE.AMZN, KMB: { status: 429 }, NVO: LIVE.NVO }, held });
    track(h.store, ...held);
    const { result } = await run(h);
    expect(result.earnings).toEqual({ status: 'rate-limited', error: 'RateLimitError' });
    expect(askedOrder(h)).toEqual(['AMZN', 'KMB']);
    expect(eventLines(h)).toEqual(['AMZN 2026-10-31 AMC finnhub', 'AMZN 2027-02-05 AMC finnhub']);
    expect(finnhubRun(h)).toMatchObject({ status: 'rate-limited', companies: 3, withDate: 1 });
    expect(finnhubRun(h)!.checks!.map((check) => `${check.symbol} ${check.result}`)).toEqual(['AMZN date', 'KMB rate-limited', 'NVO pending']);
    expect(finnhubRun(h)!.reason).toContain('HTTP 429');
    expect(item(h, 'BLOCK#finnhub', 'USAGE')).toMatchObject({ until: expect.any(Number) });
    h.clock.advance(DAY / 24 / 12);
    const again = await run(h, 'manual');
    expect(again.result.earnings).toEqual({ status: 'rate-limited', error: 'RateLimitError' });
    expect(finnhubCalls(h)).toHaveLength(2);
    expect(finnhubRun(h)!.reason).toContain('finnhub is limited until');
    h.clock.advance(DAY / 24);
    h.fake.add('symbol=KMB&', LIVE.KMB);
    await run(h);
    expect(askedOrder(h).slice(2)).toEqual(['KMB', 'NVO', 'AMZN']);
  });

  it('a refused key (401) ends the run as refused after one call, with a clear message and no key anywhere', async () => {
    const h = live({ alpha: [{ text: AV_CSV }], finnhub: { AMZN: { status: 401 }, KMB: LIVE.KMB, NVO: LIVE.NVO }, held });
    track(h.store, ...held);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    h.deps.logger = createConsoleLogger();
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', events: 1 });
    expect(finnhubCalls(h)).toHaveLength(1);
    expect(finnhubRun(h)).toMatchObject({ status: 'refused', reason: 'finnhub: HTTP 401: the key was refused or has no access to the earnings calendar', companies: 3, withDate: 0 });
    expect(finnhubRun(h)!.checks!.map((check) => `${check.symbol} ${check.result}`)).toEqual(['AMZN refused', 'KMB pending', 'NVO pending']);
    expect(earningsDatesConclusion(lastRun(h))?.text).toContain('Finnhub refused the request (finnhub: HTTP 401');
    expect(earningsDatesConclusion(lastRun(h))?.text).toContain('check the FINNHUB_API_KEY secret');
    expect(eventLines(h)).toEqual(['AMZN 2026-11-05 unknown alphavantage']);
    expect(messages(h)).not.toContain(KEY);
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY);
  });

  it('Finnhub refusing alone ends the run as failed with the class of the error; a 403 and an Invalid API key body are refusals too', async () => {
    for (const reply of [{ status: 403 }, { error: 'Invalid API key' }]) {
      const h = live({ finnhub: { AMZN: reply }, held: ['AMZN'] });
      track(h.store, 'AMZN');
      const { result } = await run(h);
      expect(result.earnings).toEqual({ status: 'failed', error: 'FinnhubRefusedError' });
      expect(finnhubRun(h)).toMatchObject({ status: 'refused' });
    }
  });

  it('one company that fails does not stop the others; it is retried first in the next run', async () => {
    const later = { KMB: answer(row('KMB', '2026-12-01', 'bmo')), NVO: answer(row('NVO', '2026-12-02', 'bmo')) };
    const h = live({ finnhub: { AMZN: { status: 500 }, ...later }, held });
    track(h.store, ...held);
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ status: 'ok', symbols: 2 });
    expect(askedOrder(h)).toEqual(['AMZN', 'KMB', 'NVO']);
    expect(finnhubRun(h)).toMatchObject({ status: 'ok', companies: 3, withDate: 2 });
    expect(finnhubRun(h)!.reason).toBe('finnhub: HTTP 500 for [url]');
    expect(finnhubRun(h)!.checks![0]).toMatchObject({ symbol: 'AMZN', result: 'failed' });
    h.clock.advance(DAY);
    await run(h);
    expect(askedOrder(h).slice(3)).toEqual(['AMZN', 'KMB', 'NVO']);
  });

  it('every company failing is a failed source with the class of the error', async () => {
    const h = live({ finnhub: { AMZN: { status: 400 } }, held: ['AMZN'] });
    track(h.store, 'AMZN');
    expect((await run(h)).result.earnings).toEqual({ status: 'failed', error: 'ProviderError' });
    expect(finnhubRun(h)).toMatchObject({ status: 'failed', companies: 1, withDate: 0 });
  });

  it('when the minute\'s calls are used the step waits for the next minute and then goes on, without a request in between', async () => {
    const h = live({ finnhub: { AMZN: LIVE.AMZN }, held: ['AMZN'] });
    track(h.store, 'AMZN');
    h.store.load([{ PK: 'USAGE', SK: 'finnhub#minute', entityType: 'PROVIDER_USAGE', day: '2026-11-02T04:30', used: 30 }]);
    const { counts, delays, result } = await stepwise(h);
    expect(counts).toEqual([0, 1]);
    expect(delays).toEqual([61_000]);
    expect(result.earnings).toMatchObject({ status: 'ok', symbols: 1 });
  });
});

describe('the dates it stores', () => {
  it('the same date on a second day is confirmed (inside 21 days); a changed date starts again', async () => {
    const h = live({ finnhub: { KMB: LIVE.KMB }, held: ['KMB'] });
    track(h.store, 'KMB');
    await run(h);
    expect(earningsConfirmation(stored(h)[0]!, TODAY).confirmed).toBe(false);
    await run(h, 'manual');
    expect(stored(h)).toHaveLength(1);
    expect(earningsConfirmation(stored(h)[0]!, TODAY).confirmed).toBe(false);
    h.clock.advance(DAY);
    await run(h);
    expect(stored(h)[0]).toMatchObject({ date: '2026-11-05', reads: 2, firstSeenOn: TODAY, lastSeenOn: '2026-11-03' });
    expect(earningsConfirmation(stored(h)[0]!, '2026-11-03')).toMatchObject({ confirmed: true });
    h.fake.add('symbol=KMB&', answer(row('KMB', '2026-11-06', 'bmo')));
    h.clock.advance(DAY);
    await run(h);
    expect(stored(h).map((event) => `${event.date} ${event.reads}`)).toEqual(['2026-11-06 1']);
  });

  it('a stored date inside 21 days that Finnhub moved is removed; one it does not know, and one beyond 21 days, stay', async () => {
    const h = live({ finnhub: { AMZN: answer(row('AMZN', '2026-11-06', 'amc')), KMB: EMPTY }, held: ['AMZN', 'KMB'] });
    track(h.store, 'AMZN', 'KMB');
    h.store.load([
      { PK: 'TICKER#AMZN', SK: 'EARN#2026-11-05', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2026-11-05', source: 'finnhub' },
      { PK: 'TICKER#AMZN', SK: 'EARN#2027-02-05', entityType: 'EARNINGS_EVENT', symbol: 'AMZN', date: '2027-02-05', source: 'alphavantage' },
      { PK: 'TICKER#KMB', SK: 'EARN#2026-11-09', entityType: 'EARNINGS_EVENT', symbol: 'KMB', date: '2026-11-09', source: 'alphavantage' },
    ]);
    const { result } = await run(h);
    expect(result.earnings).toMatchObject({ staleDeleted: 1 });
    expect(stored(h).map((event) => `${event.symbol} ${event.date}`).toSorted((a, b) => a.localeCompare(b))).toEqual(['AMZN 2026-11-06', 'AMZN 2027-02-05', 'KMB 2026-11-09']);
  });

  it('Alpha Vantage and Finnhub together: one event on a shared date, both sources ok, and the first step reads both', async () => {
    const h = live({ alpha: [{ text: AV_CSV }], finnhub: { AMZN: answer(row('AMZN', '2026-11-05', 'amc')), KO: answer(row('KO', '2026-11-24', 'bmo')) }, held: ['AMZN', 'KO'] });
    track(h.store, 'AMZN', 'KO');
    const { counts, result } = await stepwise(h);
    expect(counts).toEqual([1, 1]);
    expect(result.earnings).toMatchObject({ status: 'ok', symbols: 2 });
    expect(eventLines(h)).toEqual(['AMZN 2026-11-05 AMC finnhub', 'KO 2026-11-24 BMO finnhub']);
    expect(lastRun(h)?.sources?.map((source) => `${source.source} ${source.status}`)).toEqual(['alphavantage ok', 'finnhub ok']);
    expect(earningsDatesConclusion(lastRun(h))).toEqual({ kind: 'ok', text: 'Dates come from Alpha Vantage and Finnhub.' });
  });

  it('records a conflict between the sources: Finnhub, asked for the company itself, wins', async () => {
    const h = live({ alpha: [{ text: AV_CSV }], finnhub: { AMZN: answer(row('AMZN', '2026-11-04', 'bmo')) }, held: ['AMZN'] });
    track(h.store, 'AMZN');
    await run(h);
    expect(eventLines(h)).toEqual(['AMZN 2026-11-04 BMO finnhub']);
    expect(lastRun(h)?.conflicts).toEqual([{ symbol: 'AMZN', kept: { source: 'finnhub', date: '2026-11-04' }, dropped: { source: 'alphavantage', date: '2026-11-05' } }]);
  });

  it('a held company that Finnhub has no date for is explained in the report', async () => {
    const h = live({ finnhub: { GE: EMPTY }, held: ['GE'] });
    track(h.store, 'GE');
    await run(h);
    expect(finnhubRun(h)!.checks).toEqual([{ symbol: 'GE', result: 'none' }]);
  });
});
