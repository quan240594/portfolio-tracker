import { describe, expect, it } from 'vitest';
import { calendarSeedItems } from './calendar-seed.js';

describe('calendarSeedItems', () => {
  const items = calendarSeedItems('2026-10-15', '2026-10-15T00:00:00.000Z');

  it('writes earnings and split items in the layout of the prices service', () => {
    expect(items.map((i) => `${i.PK}|${i.SK}|${i.entityType}`)).toEqual([
      'TICKER#AAPL|EARN#2026-10-28|EARNINGS_EVENT',
      'TICKER#MSFT|EARN#2026-11-04|EARNINGS_EVENT',
      'TICKER#NVDA|EARN#2026-11-18|EARNINGS_EVENT',
      'TICKER#MSFT|SPLIT#2026-11-20|SPLIT_EVENT',
      'TICKER#NVDA|SPLIT#2026-12-07|SPLIT_EVENT',
    ]);
    expect(items[0]).toMatchObject({ symbol: 'AAPL', date: '2026-10-28', timeOfDay: 'AMC', epsEstimate: 1.64, source: 'seed' });
    expect(items[3]).toMatchObject({ symbol: 'MSFT', fromFactor: 1, toFactor: 2 });
  });

  it('moves weekend dates to the next weekday', () => {
    // 15 Oct 2026 + 13 days = Tuesday 28th; starting on a Wednesday pushes a Saturday target to Monday.
    const shifted = calendarSeedItems('2026-10-14', 'x');
    expect(shifted[0]).toMatchObject({ date: '2026-10-27' });
    const weekend = calendarSeedItems('2026-10-18', 'x');
    expect(weekend.every((i) => ![0, 6].includes(new Date(`${String(i.date)}T00:00:00Z`).getUTCDay()))).toBe(true);
  });
});
