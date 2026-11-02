import type { StoredEarningsEvent } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { mergeEarningsSources, trackSeen } from './earnings-merge.js';

const TODAY = '2026-11-02';

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
