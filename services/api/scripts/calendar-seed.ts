import { CALENDAR_ENTITY, addIsoDays, calendarKeys, type StoredEarningsEvent, type StoredSplitEvent } from '@portfolio/shared';

const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const weekday = (date: string): string => (isWeekend(date) ? weekday(addIsoDays(date, 1)) : date);

/** [symbol, days ahead, EPS estimate, time of day] of upcoming earnings reports of the seeded US symbols. */
const EARNINGS: [string, number, number, 'BMO' | 'AMC'][] = [
  ['AAPL', 13, 1.64, 'AMC'],
  ['MSFT', 20, 3.12, 'AMC'],
  ['NVDA', 34, 0.74, 'AMC'],
];

/** [symbol, days ahead, from factor, to factor]: one upcoming split of a holding and one irregular share adjustment. */
const SPLITS: [string, number, number, number][] = [
  ['MSFT', 36, 1, 2],
  ['NVDA', 52, 100, 104],
];

/** Earnings and split items (as written by services/prices `calendar_handlers.py`) for local development. */
export function calendarSeedItems(today: string, updatedAt: string): Record<string, unknown>[] {
  const earnings = EARNINGS.map(([symbol, days, eps, timeOfDay]): Record<string, unknown> => {
    const date = weekday(addIsoDays(today, days));
    const item: StoredEarningsEvent = { symbol, date, name: symbol, epsEstimate: eps, currency: 'USD', timeOfDay, source: 'seed', updatedAt };
    return { ...calendarKeys.earnings(symbol, date), entityType: CALENDAR_ENTITY.earnings, ...item };
  });
  const splits = SPLITS.map(([symbol, days, fromFactor, toFactor]): Record<string, unknown> => {
    const date = weekday(addIsoDays(today, days));
    const item: StoredSplitEvent = { symbol, date, fromFactor, toFactor, source: 'seed', updatedAt };
    return { ...calendarKeys.split(symbol, date), entityType: CALENDAR_ENTITY.split, ...item };
  });
  return [...earnings, ...splits];
}
