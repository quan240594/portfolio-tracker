import { describe, expect, it } from 'vitest';
import {
  DIVIDEND_FEED_RETRY_DAYS,
  buildDividendDatesReport,
  dividendCadenceDays,
  dividendDatesSchema,
  feedRetryDue,
  parseDividendCheckState,
  parseDividendFeedState,
  whyNoDeclaredDividend,
  type DividendCheckState,
  type DividendDatesInput,
  type DividendFacts,
} from './dividend-dates.js';
import type { DividendEvent, InstrumentProfile, Transaction } from './types.js';

const NOW = new Date('2026-11-05T09:00:00.000Z');
const TODAY = '2026-11-05';
const FX = { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-11-05T00:00:00Z' };
const REFRESH = { available: true, reason: null, nextAllowedAt: null };

let seq = 0;
const tx = (extra: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'u1',
  portfolioId: 'default',
  date: '2025-01-02',
  type: 'BUY',
  symbol: 'HESM',
  quantity: 10,
  price: 30,
  fee: 0,
  currency: 'USD',
  createdAt: '2025-01-02T00:00:00Z',
  ...extra,
});
const ev = (extra: Partial<DividendEvent> = {}): DividendEvent => ({ symbol: 'HESM', exDate: TODAY, payDate: '2026-11-13', amount: 0.7, currency: 'USD', source: 'eodhd', declared: true, ...extra });
const profiles: Record<string, InstrumentProfile> = { HESM: { symbol: 'HESM', name: 'Hess Midstream LP', assetClass: 'STOCK', currency: 'USD' } };

const input = (extra: Partial<DividendDatesInput> = {}): DividendDatesInput => ({
  now: NOW,
  transactions: [tx({})],
  profiles,
  fx: FX,
  dividendEvents: [],
  tracked: new Map([['HESM', '2025-01-02T00:00:00Z']]),
  states: new Map(),
  budget: null,
  refresh: REFRESH,
  feed: undefined,
  ...extra,
});

const only = (report: ReturnType<typeof buildDividendDatesReport>) => report.symbols[0]!;

describe('buildDividendDatesReport', () => {
  it('lists a dividend whose ex-date is today and whose payout is in 8 days as declared', () => {
    const report = buildDividendDatesReport(input({ dividendEvents: [ev()], states: new Map([['HESM', { checkedAt: '2026-11-04T05:30:00.000Z' }]]) }));
    expect(report).toMatchObject({ today: TODAY, held: 1, withDeclared: 1 });
    expect(only(report)).toMatchObject({
      symbol: 'HESM',
      name: 'Hess Midstream LP',
      boughtOn: '2025-01-02',
      next: { exDate: TODAY, payDate: '2026-11-13', amount: 0.7, currency: 'USD', source: 'eodhd', kind: 'declared', enteredByYou: false },
      last: { exDate: TODAY },
      reasonCode: null,
      reason: null,
    });
  });

  it('keeps showing the payment after the ex-date has passed', () => {
    const report = buildDividendDatesReport(input({ now: new Date('2026-11-06T09:00:00.000Z'), dividendEvents: [ev()] }));
    expect(only(report).next).toMatchObject({ exDate: TODAY, payDate: '2026-11-13', kind: 'declared' });
  });

  it('does not show a dividend whose ex-date is today when the position was bought today', () => {
    const report = buildDividendDatesReport(input({ transactions: [tx({ date: TODAY })], dividendEvents: [ev()] }));
    expect(only(report)).toMatchObject({ next: null, reasonCode: 'after-ex-date', last: { exDate: TODAY } });
    expect(only(report).reason).toContain('held no shares before it');
  });

  it('shows it when the position was bought the day before the ex-date', () => {
    const report = buildDividendDatesReport(input({ transactions: [tx({ date: '2026-11-04' })], dividendEvents: [ev()] }));
    expect(only(report).next).toMatchObject({ exDate: TODAY, kind: 'declared' });
  });

  it('marks an entry of the owner and reports a missing amount as null', () => {
    const own = ev({ source: 'manual', amount: 0 });
    const next = only(buildDividendDatesReport(input({ dividendEvents: [own] }))).next;
    expect(next).toMatchObject({ source: 'manual', amount: null, enteredByYou: true, kind: 'declared' });
  });

  it('excludes crypto, includes ETFs and sorts the symbols without a declared date first', () => {
    const report = buildDividendDatesReport(
      input({
        transactions: [tx({}), tx({ symbol: 'VWRL.L', currency: 'GBP' }), tx({ symbol: 'BTC-EUR', currency: 'EUR' }), tx({ symbol: 'AAA' })],
        dividendEvents: [ev(), ev({ symbol: 'AAA', exDate: '2026-11-20', payDate: '2026-12-01' })],
      }),
    );
    expect(report.symbols.map((entry) => entry.symbol)).toEqual(['VWRL.L', 'HESM', 'AAA']);
    expect(report.held).toBe(3);
    expect(report.withDeclared).toBe(2);
  });

  it('says it is only a projection when the calendar has just an estimate', () => {
    const paid = [tx({ type: 'DIVIDEND', date: '2026-08-14', price: 0.7, quantity: 10 }), tx({ type: 'DIVIDEND', date: '2026-05-14', price: 0.7, quantity: 10 })];
    const report = buildDividendDatesReport(input({ transactions: [tx({}), ...paid], states: new Map([['HESM', { checkedAt: '2026-11-04T05:30:00.000Z', attempt: { at: '2026-11-04T05:30:00.000Z', outcome: 'none', reason: '', source: 'eodhd', events: 0 } }]]) }));
    expect(only(report)).toMatchObject({ next: { kind: 'estimated', source: 'history' }, reasonCode: 'estimate-only' });
    expect(only(report).reason).toContain('Only a projection');
  });

  it('reports the budget, the refresh, the configured sources and the feed', () => {
    const budget = { provider: 'EODHD' as const, day: TODAY, used: 4, limit: 20, remaining: 16, calendarUsed: 2, calendarLimit: 8 };
    const report = buildDividendDatesReport(input({ budget, configured: { eodhd: true, alphavantage: true }, feed: { status: 'available', at: '2026-11-04T05:30:00.000Z', reason: '' } }));
    expect(report).toMatchObject({ budget, refresh: REFRESH, configured: { eodhd: true, alphavantage: true }, feed: { status: 'available', retryAt: null } });
    expect(dividendDatesSchema.safeParse(JSON.parse(JSON.stringify(report))).success).toBe(true);
    expect(dividendDatesSchema.safeParse({ ...report, symbols: [{ symbol: 'X' }] }).success).toBe(false);
  });

  it('describes the feed: no key, not yet tried, unavailable with a retry date and due again', () => {
    const feedOf = (extra: Partial<DividendDatesInput>) => buildDividendDatesReport(input(extra)).feed;
    expect(feedOf({ configured: { eodhd: true, alphavantage: false } }).status).toBe('no-key');
    expect(feedOf({}).status).toBe('untested');
    const recent = feedOf({ feed: { status: 'unavailable', at: '2026-11-03T05:30:00.000Z', reason: 'premium endpoint' } });
    expect(recent).toMatchObject({ status: 'unavailable', retryAt: '2026-11-10T05:30:00.000Z', reason: 'premium endpoint' });
    expect(feedOf({ feed: { status: 'unavailable', at: '2026-10-01T05:30:00.000Z', reason: 'x' } }).retryAt).toBeNull();
  });
});

describe('whyNoDeclaredDividend', () => {
  const facts = (extra: Partial<DividendFacts> = {}): DividendFacts => ({ symbol: 'HESM', today: TODAY, boughtAt: '2025-01-02T00:00:00.000Z', trackedAt: '2025-01-02T00:00:00.000Z', state: undefined, events: [], eodhdKey: true, ...extra });
  const attempt = (outcome: 'ok' | 'none' | 'failed' | 'rate-limited' | 'budget', at = '2026-11-04T05:30:00.000Z', reason = ''): DividendCheckState => ({ checkedAt: outcome === 'ok' || outcome === 'none' ? at : undefined, attempt: { at, outcome, reason, source: 'eodhd', events: 0 } });

  it('names each cause', () => {
    expect(whyNoDeclaredDividend(facts({ trackedAt: undefined })).code).toBe('not-tracked');
    expect(whyNoDeclaredDividend(facts()).code).toBe('never-checked');
    expect(whyNoDeclaredDividend(facts({ eodhdKey: false })).code).toBe('no-provider');
    expect(whyNoDeclaredDividend(facts({ state: attempt('budget') })).code).toBe('budget');
    expect(whyNoDeclaredDividend(facts({ state: attempt('rate-limited', undefined, 'eodhd: daily API limit reached') })).text).toContain('daily API limit reached');
    expect(whyNoDeclaredDividend(facts({ state: attempt('failed', undefined, 'HTTP 500') })).code).toBe('failed');
    expect(whyNoDeclaredDividend(facts({ state: attempt('failed') })).text).not.toContain(': .');
  });

  it('knows a symbol bought after its last check', () => {
    const why = whyNoDeclaredDividend(facts({ trackedAt: null, boughtAt: '2026-11-05T00:00:00.000Z', state: attempt('ok', '2026-11-04T05:30:00.000Z') }));
    expect(why).toMatchObject({ code: 'since-bought' });
    expect(why.text).toContain('2026-11-05');
  });

  it('says when the provider answered and listed nothing, with what is expected', () => {
    const events = [ev({ exDate: '2026-02-05' }), ev({ exDate: '2026-05-07' }), ev({ exDate: '2026-08-06' })];
    const why = whyNoDeclaredDividend(facts({ state: attempt('ok'), events }));
    expect(why.code).toBe('none-returned');
    expect(why.text).toContain('Latest stored ex-date 2026-08-06');
    expect(why.text).toContain('expected around 2026-11-05');
    expect(whyNoDeclaredDividend(facts({ state: attempt('none'), events: [ev({ exDate: '2026-05-07' })], today: '2026-11-20' })).text).toContain('overdue');
    expect(whyNoDeclaredDividend(facts({ state: attempt('none') })).code).toBe('no-history');
  });

  it('lets an earlier successful read stand when a later attempt did not fail', () => {
    const state: DividendCheckState = { checkedAt: '2026-11-04T05:30:00.000Z', attempt: { at: '2026-11-03T05:30:00.000Z', outcome: 'failed', reason: 'old', source: 'eodhd', events: 0 } };
    expect(whyNoDeclaredDividend(facts({ state, events: [ev({ exDate: '2026-08-06' })] })).code).toBe('none-returned');
  });

  it('reads a state the AWS service wrote (a check time and no outcome)', () => {
    expect(whyNoDeclaredDividend(facts({ state: { checkedAt: '2026-11-04T05:30:00.000Z' }, events: [ev({ exDate: '2026-08-06' })] })).text).toContain('The provider was asked');
  });
});

describe('dividendCadenceDays', () => {
  it('uses the median gap of the last stored ex-dates, about a quarter by default', () => {
    expect(dividendCadenceDays([])).toBe(91);
    expect(dividendCadenceDays([ev({ exDate: '2026-02-05' })])).toBe(91);
    expect(dividendCadenceDays([ev({ exDate: '2026-02-05' }), ev({ exDate: '2026-03-07' }), ev({ exDate: '2026-04-06' })])).toBe(30);
  });
});

describe('stored markers', () => {
  it('parses the dividends marker of a CAL#STATE item', () => {
    expect(parseDividendCheckState(undefined)).toBeUndefined();
    expect(parseDividendCheckState({ splitsCheckedAt: '2026-11-01T00:00:00Z' })).toBeUndefined();
    expect(parseDividendCheckState({ dividendsCheckedAt: '2026-11-04T05:30:00Z' })).toEqual({ checkedAt: '2026-11-04T05:30:00Z' });
    expect(parseDividendCheckState({ dividendsCheckedAt: '2026-11-04T05:30:00Z', dividendsAttemptAt: '2026-11-05T05:30:00Z', dividendsOutcome: 'budget', dividendsReason: 5, dividendsSource: 'nope', dividendsEvents: -1 })).toEqual({
      checkedAt: '2026-11-04T05:30:00Z',
      attempt: { at: '2026-11-05T05:30:00Z', outcome: 'budget', reason: '', source: 'eodhd', events: 0 },
    });
    expect(parseDividendCheckState({ dividendsAttemptAt: '2026-11-05T05:30:00Z', dividendsOutcome: 'ok', dividendsSource: 'alphavantage', dividendsEvents: 3, dividendsReason: '' })?.attempt).toMatchObject({ source: 'alphavantage', events: 3 });
  });

  it('parses the feed marker and knows when an unavailable feed is due again', () => {
    expect(parseDividendFeedState(undefined)).toBeUndefined();
    expect(parseDividendFeedState({ status: 'maybe', at: 'x' })).toBeUndefined();
    expect(parseDividendFeedState({ status: 'available' })).toBeUndefined();
    const feed = parseDividendFeedState({ status: 'unavailable', at: '2026-11-01T00:00:00.000Z', reason: 'premium' })!;
    expect(feed).toEqual({ status: 'unavailable', at: '2026-11-01T00:00:00.000Z', reason: 'premium' });
    expect(parseDividendFeedState({ status: 'available', at: 'x' })?.reason).toBe('');
    expect(feedRetryDue(feed, new Date(Date.parse(feed.at) + (DIVIDEND_FEED_RETRY_DAYS * 86_400_000 - 1)))).toBe(false);
    expect(feedRetryDue(feed, new Date(Date.parse(feed.at) + DIVIDEND_FEED_RETRY_DAYS * 86_400_000))).toBe(true);
  });
});
