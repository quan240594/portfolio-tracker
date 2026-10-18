import { addIsoDays } from '@portfolio/shared';
import { createCalendarSeed } from './calendarSeed';

// Any date works as a start: 14 consecutive days cover every weekday twice, including the days on which a weekend pushes a report forward.
const START = '2026-10-12';
const DAYS = Array.from({ length: 14 }, (_, i) => addIsoDays(START, i));

function eventsOn(today: string, date: string): string[] {
  const seed = createCalendarSeed(today);
  return [
    ...seed.earnings.filter((e) => e.date === date).map((e) => `earnings:${e.symbol}`),
    ...seed.splits.filter((s) => s.date === date).map((s) => `split:${s.symbol}`),
    ...seed.dividendEvents.filter((d) => d.exDate === date).map((d) => `ex:${d.symbol}`),
    ...seed.dividendEvents.filter((d) => d.payDate === date).map((d) => `pay:${d.symbol}`),
  ];
}

describe('createCalendarSeed busy day', () => {
  it.each(DAYS)('has exactly the intended cluster 15 days after %s, whatever the weekday', (today) => {
    expect(eventsOn(today, addIsoDays(today, 15)).sort((a, b) => a.localeCompare(b))).toEqual(['earnings:NVDA', 'ex:NVDA', 'split:MSFT']);
  });

  it('keeps every report on a weekday', () => {
    for (const today of DAYS) {
      for (const e of createCalendarSeed(today).earnings) {
        const day = new Date(`${e.date}T00:00:00Z`).getUTCDay();
        const busy = e.date === addIsoDays(today, 15);
        expect(busy || (day !== 0 && day !== 6)).toBe(true);
      }
    }
  });
});
