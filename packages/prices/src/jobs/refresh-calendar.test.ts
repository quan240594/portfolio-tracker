import type { CorporateActionsSource, EarningsSource, Item } from '@portfolio/platform';
import type { DividendEvent, StoredEarningsEvent, StoredSplitEvent } from '@portfolio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimitError, RetryableProviderError, SymbolNotFoundError } from '../errors.js';
import { createMarketData } from '../market.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { collect, drive, driveTwice, harness, type Harness } from '../testing/harness.js';
import { createRefreshCalendarJob, dueSymbols } from './refresh-calendar.js';

afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const NOW = new Date('2026-10-15T05:30:00.000Z');
const STAMP = '2026-10-15T05:30:00.000Z';
const track = (h: Harness, ...symbols: string[]) => h.store.load(symbols.map((symbol) => ({ PK: 'TRACKED', SK: `TICKER#${symbol}`, entityType: 'TRACKED_TICKER', symbol })));
const run = (h: Harness) => drive(h, createRefreshCalendarJob(h.deps), { trigger: 'scheduled' });
const stored = (h: Harness, pk: string, sk: string): Item | undefined => h.store.snapshot().find((item) => item.PK === pk && item.SK === sk);
const keysWith = (h: Harness, prefix: string): string[] => h.store.snapshot().filter((item) => item.SK.startsWith(prefix)).map((item) => `${item.PK}|${item.SK}`);

const CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
AAPL,APPLE INC,2026-10-29,2026-09-30,1.85,USD,post-market
MSFT,MICROSOFT CORP,2026-10-28,2026-09-30,,USD,pre-market
`;

class FakeEarnings implements EarningsSource {
  readonly name = 'alphavantage';
  readonly budgeted = true;
  readonly calls: string[][] = [];

  constructor(
    private readonly events: StoredEarningsEvent[] = [],
    private readonly error?: Error,
  ) {}

  fetch(symbols: readonly string[]): Promise<StoredEarningsEvent[]> {
    this.calls.push([...symbols]);
    return this.error ? Promise.reject(this.error) : Promise.resolve(this.events);
  }
}

const NO_ACTION_OPTIONS = {};

class FakeActions implements CorporateActionsSource {
  readonly name = 'eodhd';
  readonly splitCalls: string[] = [];
  readonly dividendCalls: string[] = [];

  readonly budgeted: boolean;
  private readonly failures: Record<string, Error>;

  constructor(options: { budgeted?: boolean; failures?: Record<string, Error> } = NO_ACTION_OPTIONS) {
    this.budgeted = options.budgeted ?? true;
    this.failures = options.failures ?? {};
  }

  getSplits(symbol: string): Promise<StoredSplitEvent[]> {
    this.splitCalls.push(symbol);
    const failure = this.failures[symbol];
    if (failure) return Promise.reject(failure);
    return Promise.resolve(symbol === 'AAPL' ? [{ symbol, date: '2026-11-02', fromFactor: 1, toFactor: 4, source: 'eodhd' }] : []);
  }

  getDividends(symbol: string): Promise<DividendEvent[]> {
    this.dividendCalls.push(symbol);
    return Promise.resolve([{ symbol, exDate: '2026-11-09', payDate: '2026-11-12', amount: 0.26, currency: 'USD' }]);
  }
}

const withSources = (earnings?: EarningsSource, actions?: CorporateActionsSource): Harness['deps']['marketData'] => (deps, fetch) => ({ ...createMarketData(deps, fetch), earnings, actions });

interface FakeOptions {
  earnings?: EarningsSource;
  actions?: CorporateActionsSource;
  env?: Record<string, string>;
}

const NO_FAKES: FakeOptions = {};

function fakeHarness(options = NO_FAKES): Harness {
  return harness({ start: NOW, env: options.env, marketData: withSources(options.earnings, options.actions) });
}

const liveCalendarFake = (): FakeFetch =>
  new FakeFetch()
    .add('alphavantage.co', { text: CSV })
    .add('eodhd.com/api/splits/AAPL.US', [{ date: '2026-11-02', split: '4.000000/1.000000' }])
    .add('eodhd.com/api/splits/ASML.AS', [])
    .add('eodhd.com/api/div/AAPL.US', [{ date: '2026-11-09', paymentDate: '2026-11-12', value: 0.26, currency: 'USD' }])
    .add('eodhd.com/api/div/ASML.AS', [{ date: '2026-11-04', value: 1.5, currency: 'EUR' }]);

describe('refreshCalendar', () => {
  it('stores earnings, splits and dividends of the tracked symbols with live sources and spends the budgets', async () => {
    const h = harness({ fake: liveCalendarFake(), start: NOW });
    track(h, 'AAPL', 'ASML.AS', 'BTC-EUR');
    const { result } = await run(h);
    expect(result).toEqual({
      tracked: 3,
      earnings: { status: 'ok', symbols: 1, events: 1, staleDeleted: 0 },
      corporateActions: { status: 'ok', checked: 2, splits: 1, dividends: 2, failed: 0, eligible: 2, due: 2, failedSymbols: [], checkedSymbols: ['AAPL', 'ASML.AS'] },
    });
    expect(stored(h, 'TICKER#AAPL', 'EARN#2026-10-29')).toEqual({ PK: 'TICKER#AAPL', SK: 'EARN#2026-10-29', entityType: 'EARNINGS_EVENT', symbol: 'AAPL', date: '2026-10-29', name: 'APPLE INC', fiscalPeriodEnd: '2026-09-30', epsEstimate: 1.85, currency: 'USD', timeOfDay: 'AMC', source: 'alphavantage', updatedAt: STAMP });
    expect(keysWith(h, 'EARN#')).toEqual(['TICKER#AAPL|EARN#2026-10-29']);
    expect(stored(h, 'TICKER#AAPL', 'SPLIT#2026-11-02')).toMatchObject({ entityType: 'SPLIT_EVENT', fromFactor: 1, toFactor: 4, source: 'eodhd', updatedAt: STAMP });
    expect(keysWith(h, 'DIV#')).toEqual(['TICKER#AAPL|DIV#2026-11-09', 'TICKER#ASML.AS|DIV#2026-11-04']);
    expect(stored(h, 'TICKER#AAPL', 'CAL#STATE')).toEqual({ PK: 'TICKER#AAPL', SK: 'CAL#STATE', entityType: 'CALENDAR_STATE', symbol: 'AAPL', splitsCheckedAt: STAMP, dividendsCheckedAt: STAMP });
    expect(stored(h, 'TICKER#BTC-EUR', 'CAL#STATE')).toBeUndefined();
    expect(stored(h, 'CALENDAR', 'BUDGET#alphavantage')).toEqual({ PK: 'CALENDAR', SK: 'BUDGET#alphavantage', entityType: 'CALENDAR_BUDGET', day: '2026-10-15', used: 1, tokens: [`${STAMP}#earnings`] });
    expect(stored(h, 'CALENDAR', 'BUDGET#eodhd')).toMatchObject({ used: 4 });
    expect(JSON.stringify(h.store.snapshot())).not.toContain('secret');
  });

  it('is idempotent and skips symbols checked within the re-check interval', async () => {
    const h = harness({ fake: liveCalendarFake(), start: NOW });
    track(h, 'AAPL', 'ASML.AS');
    await run(h);
    const first = h.store.snapshot().filter((item) => item.PK !== 'CALENDAR' && item.PK !== 'USAGE');
    h.clock.advance(60_000);
    const again = (await run(h)).result;
    expect(again.corporateActions).toMatchObject({ due: 0, checked: 0 });
    expect(again.earnings.status).toBe('budget-exhausted');
    expect(h.store.snapshot().filter((item) => item.PK !== 'CALENDAR' && item.PK !== 'USAGE')).toEqual(first);
    h.clock.advance(8 * DAY);
    h.fake.add('alphavantage.co', { text: CSV.replace('2026-10-29', '2026-11-05') });
    const later = (await run(h)).result;
    expect(later.corporateActions.checked).toBe(2);
    expect(later.earnings).toMatchObject({ status: 'ok', staleDeleted: 1 });
    expect(keysWith(h, 'EARN#')).toEqual(['TICKER#AAPL|EARN#2026-11-05']);
  });

  describe('earnings', () => {
    it('reports a missing provider or nothing to look up', async () => {
      const none = fakeHarness();
      track(none, 'AAPL');
      expect((await run(none)).result).toMatchObject({ earnings: { status: 'no-provider' }, corporateActions: { status: 'no-provider' } });

      const earnings = new FakeEarnings();
      const noUs = fakeHarness({ earnings });
      track(noUs, 'BTC-EUR');
      expect((await run(noUs)).result.earnings).toEqual({ status: 'no-symbols' });
      expect(earnings.calls).toEqual([]);
      const empty = fakeHarness({ earnings });
      expect((await run(empty)).result.earnings).toEqual({ status: 'no-symbols' });
    });

    it('uses one call per day and honours a configurable budget', async () => {
      const earnings = new FakeEarnings([{ symbol: 'AAPL', date: '2026-10-29', source: 'alphavantage' }]);
      const h = fakeHarness({ earnings });
      track(h, 'AAPL', 'ASML.AS');
      expect((await run(h)).result.earnings).toEqual({ status: 'ok', symbols: 1, events: 1, staleDeleted: 0 });
      expect(earnings.calls).toEqual([['AAPL', 'ASML.AS']]);
      h.clock.advance(60_000);
      expect((await run(h)).result.earnings.status).toBe('budget-exhausted');
      h.clock.advance(DAY);
      expect((await run(h)).result.earnings.status).toBe('ok');
      expect(earnings.calls).toHaveLength(2);

      const two = fakeHarness({ earnings: new FakeEarnings(), env: { CALENDAR_ALPHAVANTAGE_DAILY_CALLS: '2' } });
      track(two, 'AAPL');
      const statuses = await collect([1, 2, 3], async () => {
        two.clock.advance(60_000);
        return (await run(two)).result.earnings.status;
      });
      expect(statuses).toEqual(['ok', 'ok', 'budget-exhausted']);
    });

    it('replaces rescheduled report dates but keeps past reports and symbols that are not in the feed', async () => {
      const h = fakeHarness({ earnings: new FakeEarnings([{ symbol: 'AAPL', date: '2026-11-02', source: 'alphavantage' }]) });
      track(h, 'AAPL', 'MSFT');
      const earn = (symbol: string, date: string): Item => ({ PK: `TICKER#${symbol}`, SK: `EARN#${date}`, entityType: 'EARNINGS_EVENT', symbol, date });
      h.store.load([earn('AAPL', '2026-07-30'), earn('AAPL', '2026-10-29'), earn('MSFT', '2026-10-28')]);
      const { result } = await run(h);
      expect(result.earnings).toMatchObject({ staleDeleted: 1 });
      expect(keysWith(h, 'EARN#')).toEqual(['TICKER#AAPL|EARN#2026-07-30', 'TICKER#MSFT|EARN#2026-10-28', 'TICKER#AAPL|EARN#2026-11-02']);
    });

    it.each([new RateLimitError('quota', { provider: 'alphavantage' }), new RetryableProviderError('down'), new ProviderError('bad'), new Error('storage')])('reports %s as failed and still checks splits', async (error) => {
      const h = fakeHarness({ earnings: new FakeEarnings([], error), actions: new FakeActions() });
      track(h, 'AAPL');
      const { result } = await run(h);
      expect(result.earnings).toEqual({ status: 'failed', error: error.name });
      expect(result.corporateActions).toMatchObject({ checkedSymbols: ['AAPL'] });
    });
  });

  describe('earnings of suffixed listings and failures (live Alpha Vantage source, no scripted source)', () => {
    const XETRA_CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
CRM,SALESFORCE INC,2026-12-03,2026-10-31,2.41,USD,post-market
MA,MASTERCARD INC,2026-10-29,2026-09-30,3.6,USD,pre-market
ASML,ASML HOLDING NV,2027-01-28,2026-12-31,6.9,EUR,pre-market
AMZN,AMAZON COM INC,2026-10-30,2026-09-30,1.5,USD,post-market
`;
    const profile = (symbol: string, name: string): Item => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name });
    const liveHarness = (fake: FakeFetch): Harness => harness({ fake, start: NOW, env: { ALPHAVANTAGE_API_KEY: 'av-key' } });

    it('stores the dates of Xetra and Euronext listings under the symbols of the holdings, with one call', async () => {
      const fake = new FakeFetch().add('alphavantage.co', { text: XETRA_CSV });
      const h = liveHarness(fake);
      track(h, 'AMZN', 'FOO.DE', 'M4I.DE', 'ASML.AS', 'BTC-EUR');
      h.store.load([profile('ASML.AS', 'ASML Holding'), profile('FOO.DE', 'FOO.DE')]);
      const { result } = await run(h);
      expect(result.earnings).toEqual({ status: 'ok', symbols: 4, events: 4, staleDeleted: 0 });
      expect(fake.urls.filter((url) => url.includes('alphavantage.co'))).toHaveLength(1);
      expect(keysWith(h, 'EARN#')).toEqual(['TICKER#AMZN|EARN#2026-10-30', 'TICKER#ASML.AS|EARN#2027-01-28', 'TICKER#FOO.DE|EARN#2026-12-03', 'TICKER#M4I.DE|EARN#2026-10-29']);
    });

    it('does not retry a failed call the same day, tries once the next day', async () => {
      const note = { text: JSON.stringify({ Information: 'Our standard API rate limit is 25 requests per day.' }) };
      const fake = new FakeFetch().add('alphavantage.co', note, { text: XETRA_CSV });
      const h = liveHarness(fake);
      track(h, 'AMZN');
      expect((await run(h)).result.earnings).toEqual({ status: 'failed', error: 'RateLimitError' });
      h.clock.advance(6 * 3_600_000);
      expect((await run(h)).result.earnings.status).toBe('budget-exhausted');
      expect(fake.urls.filter((url) => url.includes('alphavantage.co'))).toHaveLength(1);
      expect(keysWith(h, 'EARN#')).toEqual([]);
      h.clock.advance(DAY);
      expect((await run(h)).result.earnings).toMatchObject({ status: 'ok', events: 1 });
      expect(keysWith(h, 'EARN#')).toEqual(['TICKER#AMZN|EARN#2026-10-30']);
    });
  });

  describe('splits and dividends', () => {
    const all = ['AAPL', 'KO', 'MSFT', 'NVDA'];

    it('checks the oldest first within the daily budget and rotates over the days', async () => {
      const actions = new FakeActions();
      const h = fakeHarness({ actions, env: { CALENDAR_EODHD_DAILY_CALLS: '4' } });
      track(h, ...all);
      const day1 = (await run(h)).result.corporateActions;
      expect(day1).toMatchObject({ status: 'budget-exhausted', checkedSymbols: ['AAPL', 'KO'], due: 4, splits: 1, dividends: 2 });
      h.clock.advance(60_000);
      expect((await run(h)).result.corporateActions).toMatchObject({ status: 'budget-exhausted', checkedSymbols: [], due: 2 });
      expect(actions.splitCalls).toEqual(['AAPL', 'KO']);

      h.clock.advance(DAY);
      expect((await run(h)).result.corporateActions).toMatchObject({ status: 'ok', checkedSymbols: ['MSFT', 'NVDA'], due: 2 });
      h.clock.advance(DAY);
      expect((await run(h)).result.corporateActions).toMatchObject({ status: 'ok', due: 0 });
      h.clock.advance(6 * DAY);
      expect((await run(h)).result.corporateActions.checkedSymbols).toEqual(['AAPL', 'KO']);
    });

    it('can skip the dividends, run with a zero budget or without budgeting', async () => {
      const noDividends = new FakeActions();
      const a = fakeHarness({ actions: noDividends, env: { CALENDAR_EODHD_DAILY_CALLS: '2', CALENDAR_REFRESH_DIVIDENDS: 'false' } });
      track(a, 'AAPL', 'KO', 'MSFT');
      expect((await run(a)).result.corporateActions.checkedSymbols).toEqual(['AAPL', 'KO']);
      expect(noDividends.dividendCalls).toEqual([]);
      expect(stored(a, 'TICKER#AAPL', 'CAL#STATE')).not.toHaveProperty('dividendsCheckedAt');

      const zeroActions = new FakeActions();
      const zero = fakeHarness({ actions: zeroActions, env: { CALENDAR_EODHD_DAILY_CALLS: '0' } });
      track(zero, 'AAPL');
      expect((await run(zero)).result.corporateActions).toMatchObject({ status: 'budget-exhausted', checked: 0 });
      expect(zeroActions.splitCalls).toEqual([]);

      const free = fakeHarness({ actions: new FakeActions({ budgeted: false }), env: { CALENDAR_EODHD_DAILY_CALLS: '0' } });
      track(free, 'AAPL', 'KO', 'MSFT');
      expect((await run(free)).result.corporateActions.checkedSymbols).toEqual(['AAPL', 'KO', 'MSFT']);
    });

    it('does not stop at one failing symbol, which goes to the back of the queue', async () => {
      const actions = new FakeActions({ failures: { KO: new RetryableProviderError('boom', { provider: 'eodhd' }), ZZZ: new SymbolNotFoundError('nope'), BAD: new Error('storage') } });
      const h = fakeHarness({ actions, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
      track(h, 'AAPL', 'BAD', 'KO', 'MSFT', 'ZZZ');
      const { corporateActions } = (await run(h)).result;
      expect(corporateActions).toMatchObject({ checkedSymbols: ['AAPL', 'MSFT'], failed: 3, failedSymbols: ['BAD', 'KO', 'ZZZ'], status: 'ok' });
      const ko = stored(h, 'TICKER#KO', 'CAL#STATE')!;
      expect(ko.splitsFailedAt).toBe(STAMP);
      expect(ko).not.toHaveProperty('splitsCheckedAt');
      const states = await new (await import('../repository.js')).PriceRepository(h.store).getStates(['AAPL', 'KO', 'MSFT']);
      expect(dueSymbols(['AAPL', 'KO', 'MSFT'], states, new Date(NOW.getTime() + 8 * DAY), 7)).toEqual(['AAPL', 'KO', 'MSFT']);
      expect(dueSymbols(['AAPL', 'KO', 'MSFT'], states, new Date(NOW.getTime() + DAY), 7)).toEqual(['KO']);
    });

    it('stops at a provider rate limit and survives a failure to record a failure', async () => {
      const limited = fakeHarness({ actions: new FakeActions({ failures: { KO: new RateLimitError('daily limit', { provider: 'eodhd' }) } }), env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
      track(limited, 'AAPL', 'KO', 'MSFT');
      const { corporateActions } = (await run(limited)).result;
      expect(corporateActions).toMatchObject({ status: 'rate-limited', checkedSymbols: ['AAPL'] });

      const broken = fakeHarness({ actions: new FakeActions({ failures: { AAPL: new ProviderError('bad', { provider: 'eodhd' }) } }), env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
      track(broken, 'AAPL');
      const update = broken.store.update.bind(broken.store);
      vi.spyOn(broken.store, 'update').mockImplementation((key, patch, options) => (key.SK === 'CAL#STATE' ? Promise.reject(new Error('throttled')) : update(key, patch, options)));
      expect((await run(broken)).result.corporateActions).toMatchObject({ failedSymbols: ['AAPL'] });
    });

    it('orders by the last attempt', () => {
      const states = new Map([
        ['A', { splitsCheckedAt: '2026-10-01T00:00:00.000Z' }],
        ['B', { splitsCheckedAt: '2026-10-05T00:00:00.000Z' }],
        ['C', { splitsCheckedAt: '2026-10-14T00:00:00.000Z' }],
        ['D', { splitsFailedAt: '2026-10-03T00:00:00.000Z' }],
      ]);
      expect(dueSymbols(['C', 'B', 'A', 'D', 'E', 'F'], states, NOW, 7)).toEqual(['E', 'F', 'A', 'D', 'B']);
      expect(dueSymbols([], states, NOW, 7)).toEqual([]);
    });
  });

  describe('resumable steps', () => {
    it('never spends a budget twice for a check that was cut off by the step budget', async () => {
      const fake = new FakeFetch()
        .add('alphavantage.co', { text: CSV })
        .add('eodhd.com/api/splits/AAPL.US', { status: 503 }, [{ date: '2026-11-02', split: '4/1' }])
        .add('eodhd.com/api/div/AAPL.US', [{ date: '2026-11-09', value: 0.26, currency: 'USD' }]);
      const h = harness({ fake, start: NOW, stepSubrequests: 3 });
      track(h, 'AAPL');
      const { result, steps } = await run(h);
      expect(steps.length).toBeGreaterThan(1);
      expect(result.corporateActions).toMatchObject({ checkedSymbols: ['AAPL'], splits: 1, dividends: 1 });
      expect(stored(h, 'CALENDAR', 'BUDGET#eodhd')).toMatchObject({ used: 2, tokens: [`${STAMP}#AAPL`] });
    });

    it('gives the same result when every step is delivered twice', async () => {
      const reference = harness({ fake: liveCalendarFake(), start: NOW, stepSubrequests: 2 });
      track(reference, 'AAPL', 'ASML.AS');
      const expected = (await run(reference)).result;
      const h = harness({ fake: liveCalendarFake(), start: NOW, stepSubrequests: 2 });
      track(h, 'AAPL', 'ASML.AS');
      expect(await driveTwice(h, createRefreshCalendarJob(h.deps), { trigger: 'scheduled' })).toEqual(expected);
    });

    it('refuses a step budget that can never be enough', async () => {
      const h = harness({ fake: liveCalendarFake(), start: NOW, stepSubrequests: 0 });
      track(h, 'AAPL');
      await expect(createRefreshCalendarJob(h.deps)({ payload: { trigger: 'scheduled' } })).rejects.toThrow('too small');
    });
  });
});
