import type { Item } from '@portfolio/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeFetch } from '../testing/fake-fetch.js';
import { drive, harness, padCalendar, type Harness } from '../testing/harness.js';
import { createRefreshCalendarJob } from './refresh-calendar.js';

afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const NOW = new Date('2026-11-05T05:30:00.000Z');
const STAMP = '2026-11-05T05:30:00.000Z';
const track = (h: Harness, ...symbols: string[]) => h.store.load(symbols.map((symbol) => ({ PK: 'TRACKED', SK: `TICKER#${symbol}`, entityType: 'TRACKED_TICKER', symbol })));
const stored = (h: Harness, pk: string, sk: string): Item | undefined => h.store.snapshot().find((item) => item.PK === pk && item.SK === sk);
const state = (h: Harness, symbol: string): Item | undefined => stored(h, `TICKER#${symbol}`, 'CAL#STATE');
const run = (h: Harness, payload: { trigger: 'scheduled' | 'manual'; part?: 'dividends' } = { trigger: 'scheduled' }) => drive(h, createRefreshCalendarJob(h.deps), payload);
const urlsOf = (h: Harness, part: string): string[] => h.fake.urls.filter((url) => url.includes(part));

const CSV = padCalendar('symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nHESM,HESS MIDSTREAM LP,2026-11-06,2026-09-30,0.5,USD,pre-market\n');
const HESM_EODHD = [{ date: '2026-08-05', paymentDate: '2026-08-14', value: 0.7, currency: 'USD' }];
const HESM_AV = { symbol: 'HESM', data: [{ ex_dividend_date: '2026-11-05', declaration_date: '2026-10-21', record_date: '2026-11-05', payment_date: '2026-11-13', amount: '0.7152' }, { ex_dividend_date: '2026-08-05', declaration_date: '2026-07-22', record_date: '2026-08-05', payment_date: '2026-08-14', amount: '0.7' }] };

const baseFake = (): FakeFetch => new FakeFetch().add('alphavantage.co', { text: CSV }).add('eodhd.com/api/splits/', []).add('eodhd.com/api/div/', []);
const withHeld = (h: Harness, held: Record<string, string>): Harness => {
  h.deps.heldPositions = () => Promise.resolve(new Map(Object.entries(held)));
  return h;
};

describe('the outcome of the dividends check of each symbol', () => {
  it('records ok, none, a failure with its cause and the symbols a spent allowance did not reach', async () => {
    const fake = baseFake()
      .add('eodhd.com/api/div/AAPL.US', [{ date: '2026-11-09', paymentDate: '2026-11-12', value: 0.26, currency: 'USD' }])
      .add('eodhd.com/api/div/KO.US', [])
      .add('eodhd.com/api/div/MSFT.US', { status: 500 });
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '6' } });
    track(h, 'AAPL', 'KO', 'MSFT', 'NVDA');
    const { result } = await run(h);
    expect(result.corporateActions).toMatchObject({ status: 'budget-exhausted', checkedSymbols: ['AAPL', 'KO'], failedSymbols: ['MSFT'] });
    expect(state(h, 'AAPL')).toMatchObject({ dividendsCheckedAt: STAMP, dividendsAttemptAt: STAMP, dividendsOutcome: 'ok', dividendsEvents: 1, dividendsSource: 'eodhd' });
    expect(state(h, 'KO')).toMatchObject({ dividendsCheckedAt: STAMP, dividendsOutcome: 'none', dividendsEvents: 0 });
    expect(state(h, 'MSFT')).toMatchObject({ dividendsOutcome: 'failed', splitsFailedAt: STAMP });
    expect(state(h, 'MSFT')).not.toHaveProperty('dividendsCheckedAt');
    expect(String(state(h, 'MSFT')!.dividendsReason)).not.toBe('');
    expect(state(h, 'NVDA')).toMatchObject({ dividendsOutcome: 'budget', dividendsAttemptAt: STAMP });
    expect(state(h, 'NVDA')).not.toHaveProperty('splitsCheckedAt');
  });

  it('records a provider limit for the symbol that met it and for those that were behind it', async () => {
    const fake = baseFake().add('eodhd.com/api/div/KO.US', { status: 402 });
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
    track(h, 'AAPL', 'KO', 'MSFT');
    const { result } = await run(h);
    expect(result.corporateActions).toMatchObject({ status: 'rate-limited', checkedSymbols: ['AAPL'] });
    expect(state(h, 'KO')).toMatchObject({ dividendsOutcome: 'rate-limited' });
    expect(String(state(h, 'KO')!.dividendsReason)).toContain('daily API limit');
    expect(state(h, 'MSFT')).toMatchObject({ dividendsOutcome: 'rate-limited', dividendsReason: 'the provider limit was reached before its turn' });
  });

  it('says the splits call came first when that is what failed', async () => {
    const fake = baseFake().add('eodhd.com/api/splits/KO.US', { status: 500 });
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
    track(h, 'KO');
    await run(h);
    expect(String(state(h, 'KO')!.dividendsReason)).toContain('the splits call came first');
  });

  it('survives a failure to record the outcome', async () => {
    const h = harness({ fake: baseFake(), start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
    track(h, 'KO');
    const update = h.store.update.bind(h.store);
    vi.spyOn(h.store, 'update').mockImplementation((key, patch, options) => (key.SK === 'CAL#STATE' ? Promise.reject(new Error('throttled')) : update(key, patch, options)));
    expect((await run(h)).result.corporateActions).toMatchObject({ failedSymbols: ['KO'], checked: 0 });

    const limited = harness({ fake: baseFake().add('eodhd.com/api/div/KO.US', { status: 402 }), start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
    track(limited, 'KO');
    const updateLimited = limited.store.update.bind(limited.store);
    vi.spyOn(limited.store, 'update').mockImplementation((key, patch, options) => (key.SK === 'CAL#STATE' ? Promise.reject(new Error('throttled')) : updateLimited(key, patch, options)));
    expect((await run(limited)).result.corporateActions.status).toBe('rate-limited');
  });
});

describe('which symbols are read first', () => {
  it('reads a newly bought symbol, then the ones with an ex-date close by, then the stalest', async () => {
    const fake = baseFake();
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100', ALPHAVANTAGE_API_KEY: '' } });
    track(h, 'AAA', 'BBB', 'CCC', 'HESM');
    const read = (symbol: string, days: number): Item => ({ PK: `TICKER#${symbol}`, SK: 'CAL#STATE', entityType: 'CALENDAR_STATE', symbol, splitsCheckedAt: new Date(NOW.getTime() - days * DAY).toISOString(), dividendsCheckedAt: new Date(NOW.getTime() - days * DAY).toISOString() });
    h.store.load([read('AAA', 20), read('BBB', 3), read('CCC', 9)]);
    // BBB: read three days ago and its ex-date is today: close by. HESM: held since yesterday, never read.
    h.store.load([{ PK: 'TICKER#BBB', SK: 'DIV#2026-11-05', entityType: 'DIVIDEND_EVENT', symbol: 'BBB', exDate: '2026-11-05', amount: 1, currency: 'USD' }]);
    withHeld(h, { HESM: '2026-11-04', AAA: '2020-01-01', BBB: '2020-01-01', CCC: '2020-01-01' });
    const { result } = await run(h);
    expect(result.corporateActions).toMatchObject({ checkedSymbols: ['HESM', 'BBB', 'AAA', 'CCC'], due: 4 });
    // The close one is read for its dividends only (its splits were read three days ago).
    expect(urlsOf(h, 'eodhd.com/api/splits/')).toHaveLength(3);
    expect(urlsOf(h, 'eodhd.com/api/splits/BBB')).toHaveLength(0);
    expect(urlsOf(h, 'eodhd.com/api/div/')).toHaveLength(4);
  });

  it('puts a symbol bought after its last read first even when it was read yesterday', async () => {
    const h = harness({ fake: baseFake(), start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100', ALPHAVANTAGE_API_KEY: '' } });
    track(h, 'AAA', 'HESM');
    const at = new Date(NOW.getTime() - DAY).toISOString();
    h.store.load(['AAA', 'HESM'].map((symbol) => ({ PK: `TICKER#${symbol}`, SK: 'CAL#STATE', entityType: 'CALENDAR_STATE', symbol, splitsCheckedAt: at, dividendsCheckedAt: at })));
    withHeld(h, { HESM: '2026-11-05', AAA: '2020-01-01' });
    expect((await run(h)).result.corporateActions.checkedSymbols).toEqual(['HESM']);
  });

  it('keeps the daily rotation without prioritising when the dividends are not refreshed', async () => {
    const h = harness({ fake: baseFake(), start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100', CALENDAR_REFRESH_DIVIDENDS: 'false' } });
    track(h, 'AAA');
    withHeld(h, { AAA: '2026-11-05' });
    expect((await run(h)).result.corporateActions.checkedSymbols).toEqual(['AAA']);
    expect(urlsOf(h, 'eodhd.com/api/div/')).toHaveLength(0);
  });
});

describe('the free fallback for declared dividends', () => {
  const holdHesm = (fake: FakeFetch, env: Record<string, string> = {}): Harness => {
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100', ...env } });
    track(h, 'HESM');
    return withHeld(h, { HESM: '2024-01-02' });
  };

  it('asks Alpha Vantage once EODHD lists no declared upcoming dividend, stores the declared event and records the feed as available', async () => {
    const fake = baseFake().add('eodhd.com/api/div/HESM.US', HESM_EODHD).add('function=DIVIDENDS', HESM_AV);
    const h = holdHesm(fake);
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(urlsOf(h, 'function=DIVIDENDS')).toHaveLength(1);
    expect(urlsOf(h, 'function=DIVIDENDS')[0]).toContain('symbol=HESM');
    expect(stored(h, 'TICKER#HESM', 'DIV#2026-11-05')).toMatchObject({ exDate: '2026-11-05', payDate: '2026-11-13', amount: 0.7152, currency: 'USD', source: 'alphavantage', declared: true, declarationDate: '2026-10-21' });
    // Both list the August dividend with a pay date: equally complete, so the provider's own record stays.
    expect(stored(h, 'TICKER#HESM', 'DIV#2026-08-05')).toMatchObject({ amount: 0.7, source: 'eodhd', declared: true, declarationDate: '2026-07-22' });
    expect(state(h, 'HESM')).toMatchObject({ dividendsOutcome: 'ok', dividendsSource: 'alphavantage', dividendsEvents: 2 });
    expect(stored(h, 'CALENDAR', 'DIVIDENDS#AVFEED')).toMatchObject({ status: 'available', at: STAMP });
    expect(stored(h, 'USAGE', 'alphavantage#dividends')).toMatchObject({ used: 1 });
  });

  it('does not ask when EODHD already lists a declared upcoming dividend, nor for a symbol the rotation merely re-reads', async () => {
    const declared = baseFake().add('eodhd.com/api/div/HESM.US', [{ date: '2026-11-05', paymentDate: '2026-11-13', value: 0.7, currency: 'USD' }]).add('function=DIVIDENDS', HESM_AV);
    const h = holdHesm(declared);
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(urlsOf(h, 'function=DIVIDENDS')).toHaveLength(0);

    const stale = baseFake().add('eodhd.com/api/div/HESM.US', HESM_EODHD).add('function=DIVIDENDS', HESM_AV);
    const s = holdHesm(stale);
    s.store.load([{ PK: 'TICKER#HESM', SK: 'CAL#STATE', entityType: 'CALENDAR_STATE', symbol: 'HESM', splitsCheckedAt: new Date(NOW.getTime() - 8 * DAY).toISOString(), dividendsCheckedAt: new Date(NOW.getTime() - 8 * DAY).toISOString() }]);
    s.store.load([{ PK: 'TICKER#HESM', SK: 'DIV#2026-03-01', entityType: 'DIVIDEND_EVENT', symbol: 'HESM', exDate: '2026-03-01', amount: 0.7, currency: 'USD' }]);
    await run(s);
    expect(urlsOf(s, 'function=DIVIDENDS')).toHaveLength(0);
  });

  it('is not used for a suffixed listing or without an Alpha Vantage key', async () => {
    const fake = baseFake().add('function=DIVIDENDS', HESM_AV);
    const suffixed = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
    track(suffixed, 'ASML.AS');
    await run(suffixed);
    expect(urlsOf(suffixed, 'function=DIVIDENDS')).toHaveLength(0);
    const keyless = holdHesm(baseFake().add('function=DIVIDENDS', HESM_AV), { ALPHAVANTAGE_API_KEY: '' });
    await run(keyless);
    expect(urlsOf(keyless, 'function=DIVIDENDS')).toHaveLength(0);
  });

  it('records the feed as unavailable on a premium refusal, leaves it alone for a week and probes again after', async () => {
    const premium = { Information: 'Thank you for using Alpha Vantage! This is a premium endpoint. Please subscribe to any premium plan to instantly unlock all premium endpoints.' };
    const fake = baseFake().add('eodhd.com/api/div/HESM.US', HESM_EODHD).add('function=DIVIDENDS', premium);
    const h = holdHesm(fake);
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(stored(h, 'CALENDAR', 'DIVIDENDS#AVFEED')).toMatchObject({ status: 'unavailable', at: STAMP });
    expect(String(stored(h, 'CALENDAR', 'DIVIDENDS#AVFEED')!.reason)).toContain('premium endpoint');
    expect(state(h, 'HESM')).toMatchObject({ dividendsOutcome: 'ok', dividendsSource: 'eodhd', dividendsEvents: 1 });
    h.clock.advance(6 * DAY);
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(urlsOf(h, 'function=DIVIDENDS')).toHaveLength(1);
    h.clock.advance(DAY);
    fake.add('function=DIVIDENDS', HESM_AV);
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(urlsOf(h, 'function=DIVIDENDS')).toHaveLength(2);
    expect(stored(h, 'CALENDAR', 'DIVIDENDS#AVFEED')).toMatchObject({ status: 'available' });
  });

  it('treats a rate limit of the feed as no answer, not as unavailable, and a failure of it as no failure of the check', async () => {
    const limited = baseFake().add('eodhd.com/api/div/HESM.US', HESM_EODHD).add('function=DIVIDENDS', { Information: 'Our standard API rate limit is 25 requests per day.' });
    const h = holdHesm(limited);
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(stored(h, 'CALENDAR', 'DIVIDENDS#AVFEED')).toBeUndefined();
    expect(state(h, 'HESM')).toMatchObject({ dividendsOutcome: 'ok', dividendsSource: 'eodhd' });

    const broken = baseFake().add('eodhd.com/api/div/HESM.US', HESM_EODHD).add('function=DIVIDENDS', { text: 'not json' });
    const b = holdHesm(broken);
    await run(b, { trigger: 'manual', part: 'dividends' });
    expect(state(b, 'HESM')).toMatchObject({ dividendsOutcome: 'ok', dividendsSource: 'eodhd' });
    expect(stored(b, 'CALENDAR', 'DIVIDENDS#AVFEED')).toBeUndefined();
  });

  it('stops asking when its own daily cap of the shared allowance is spent', async () => {
    const fake = baseFake().add('eodhd.com/api/div/', []).add('function=DIVIDENDS', { symbol: 'X', data: [] });
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '100' } });
    const symbols = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
    track(h, ...symbols);
    withHeld(h, Object.fromEntries(symbols.map((symbol) => [symbol, '2024-01-02'])));
    await run(h, { trigger: 'manual', part: 'dividends' });
    expect(urlsOf(h, 'function=DIVIDENDS')).toHaveLength(4);
    expect(stored(h, 'USAGE', 'alphavantage#dividends')).toMatchObject({ used: 4 });
    expect(state(h, 'A6')).toMatchObject({ dividendsOutcome: 'none', dividendsSource: 'eodhd' });
  });
});

describe('Check dividends now (a manual dividends-only run)', () => {
  it('reads only the held symbols, the most urgent first and at most eight, without earnings, splits or the calendar budget', async () => {
    const fake = baseFake().add('eodhd.com/api/div/', []);
    const h = harness({ fake, start: NOW, env: { CALENDAR_EODHD_DAILY_CALLS: '0', ALPHAVANTAGE_API_KEY: '' } });
    const held = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'HESM'];
    track(h, ...held, 'WATCHED', 'BTC-EUR');
    const at = new Date(NOW.getTime() - 2 * DAY).toISOString();
    h.store.load(held.slice(0, 9).map((symbol) => ({ PK: `TICKER#${symbol}`, SK: 'CAL#STATE', entityType: 'CALENDAR_STATE', symbol, dividendsCheckedAt: at })));
    withHeld(h, Object.fromEntries(held.map((symbol) => [symbol, '2020-01-01'])));
    const { result } = await run(h, { trigger: 'manual', part: 'dividends' });
    expect(result.earnings.status).toBe('no-symbols');
    expect(result.corporateActions).toMatchObject({ status: 'ok', checked: 8, eligible: 10, splits: 0, due: 8 });
    expect(result.corporateActions.checkedSymbols).toContain('HESM');
    expect(result.corporateActions.checkedSymbols?.[0]).toBe('HESM');
    expect(urlsOf(h, 'alphavantage.co')).toHaveLength(0);
    expect(urlsOf(h, 'eodhd.com/api/splits/')).toHaveLength(0);
    expect(urlsOf(h, 'WATCHED')).toHaveLength(0);
    expect(stored(h, 'CALENDAR', 'BUDGET#eodhd')).toBeUndefined();
    expect(stored(h, 'CALENDAR', 'EARNINGS#LASTRUN')).toBeUndefined();
    expect(state(h, 'HESM')).toMatchObject({ dividendsOutcome: 'none', dividendsCheckedAt: STAMP });
    expect(state(h, 'HESM')).not.toHaveProperty('splitsCheckedAt');
  });

  it('puts symbols with no upcoming dividend ahead of those that have one, and stops at the provider quota', async () => {
    const fake = baseFake().add('eodhd.com/api/div/', []).add('eodhd.com/api/div/H3.US', { status: 402 });
    const h = harness({ fake, start: NOW, env: { ALPHAVANTAGE_API_KEY: '' } });
    track(h, 'H1', 'H2', 'H3', 'H4');
    const at = new Date(NOW.getTime() - 2 * DAY).toISOString();
    h.store.load(['H1', 'H2', 'H3', 'H4'].map((symbol) => ({ PK: `TICKER#${symbol}`, SK: 'CAL#STATE', entityType: 'CALENDAR_STATE', symbol, dividendsCheckedAt: at })));
    h.store.load([{ PK: 'TICKER#H1', SK: 'DIV#2026-12-01', entityType: 'DIVIDEND_EVENT', symbol: 'H1', exDate: '2026-12-01', amount: 1, currency: 'USD' }]);
    withHeld(h, { H1: '2020-01-01', H2: '2020-01-01', H3: '2020-01-01', H4: '2020-01-01' });
    const { result } = await run(h, { trigger: 'manual', part: 'dividends' });
    expect(result.corporateActions).toMatchObject({ status: 'rate-limited', checkedSymbols: ['H2'] });
    expect(state(h, 'H3')).toMatchObject({ dividendsOutcome: 'rate-limited' });
    expect(state(h, 'H4')).toMatchObject({ dividendsOutcome: 'rate-limited', dividendsReason: 'the provider limit was reached before its turn' });
    expect(state(h, 'H1')).toMatchObject({ dividendsCheckedAt: at });
  });

  it('reads every tracked symbol that can pay when the deployment does not say which are held, and does nothing without an EODHD key', async () => {
    const h = harness({ fake: baseFake().add('eodhd.com/api/div/', []), start: NOW, env: { ALPHAVANTAGE_API_KEY: '' } });
    track(h, 'AAA', 'BBB', 'BTC-EUR');
    expect((await run(h, { trigger: 'manual', part: 'dividends' })).result.corporateActions).toMatchObject({ checkedSymbols: ['AAA', 'BBB'], eligible: 2 });
    const keyless = harness({ start: NOW, env: { EODHD_API_KEY: '' } });
    track(keyless, 'AAA');
    expect((await run(keyless, { trigger: 'manual', part: 'dividends' })).result.corporateActions.status).toBe('no-provider');
  });
});
