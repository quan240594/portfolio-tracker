import type { CalendarEvent, CalendarEarningsTime } from '@portfolio/shared';
import { formatMoney, formatQuantity } from '../../lib/format';
import { EVENT_META } from './calendarModel';

/** The user's expected (or received) net amount in the base currency, e.g. "€ 3,74". */
export const expectedLabel = (e: CalendarEvent, baseCurrency: string): string | undefined =>
  e.expectedAmount === undefined ? undefined : formatMoney(e.expectedAmount, baseCurrency);

export const perShareLabel = (e: CalendarEvent): string | undefined =>
  e.amountPerShare === undefined || !e.currency ? undefined : formatMoney(e.amountPerShare, e.currency, { maxDigits: 4 });

export const TIME_OF_DAY_LABELS: Readonly<Record<CalendarEarningsTime, string>> = {
  BMO: 'Before market open',
  AMC: 'After market close',
  unknown: 'Not specified',
};

/** "Reported · Q3 2026" for released results, "Projected date" for a projection; nothing for a date the provider announced. */
export function earningsPhaseLabel(e: Pick<CalendarEvent, 'earningsPhase' | 'period'>): string | undefined {
  if (e.earningsPhase === 'reported') return ['Reported', e.period].filter(Boolean).join(' ');
  return e.earningsPhase === 'projected' ? 'Projected date' : undefined;
}

/** Second line of a row: what the event is about. */
export function eventDetailLine(e: CalendarEvent): string {
  const type = EVENT_META[e.type].label;
  if (e.type === 'EX_DIVIDEND' || e.type === 'DIVIDEND_PAY') {
    const perShare = perShareLabel(e);
    const shares = e.quantity === undefined ? undefined : `${formatQuantity(e.quantity)} shares`;
    return [type, perShare && `${perShare} per share`, shares].filter(Boolean).join(' · ');
  }
  if (e.type === 'EARNINGS') {
    const time = e.timeOfDay && e.timeOfDay !== 'unknown' ? TIME_OF_DAY_LABELS[e.timeOfDay] : undefined;
    return [type, earningsPhaseLabel(e), time].filter(Boolean).join(' · ');
  }
  return e.description;
}
