import type { CalendarEvent, CalendarEarningsTime } from '@portfolio/shared';
import { formatMoney, formatQuantity } from '../../lib/format';
import { EVENT_META, releaseText } from './calendarModel';

/** The user's expected (or received) net amount in the base currency, e.g. "€ 3,74". */
export const expectedLabel = (e: CalendarEvent, baseCurrency: string): string | undefined =>
  e.expectedAmount === undefined ? undefined : formatMoney(e.expectedAmount, baseCurrency);

export const perShareLabel = (e: CalendarEvent): string | undefined =>
  e.amountPerShare === undefined || e.amountPerShare <= 0 || !e.currency ? undefined : formatMoney(e.amountPerShare, e.currency, { maxDigits: 4 });

export const TIME_OF_DAY_LABELS: Readonly<Record<CalendarEarningsTime, string>> = {
  BMO: 'Before market open',
  AMC: 'After market close',
  DMH: 'During market hours',
  unknown: 'Not specified',
};


/** "Reported · Q3 2026" for released results, "Projected date" for a projection, "Confirmed date" or "Scheduled (provider date)" for a date a provider listed. */
export function earningsPhaseLabel(e: Pick<CalendarEvent, 'earningsPhase' | 'period' | 'status'>): string | undefined {
  if (e.earningsPhase === 'reported') return ['Reported', e.period].filter(Boolean).join(' ');
  if (e.earningsPhase === 'projected') return 'Projected date';
  if (e.earningsPhase !== 'scheduled') return undefined;
  return e.status === 'ESTIMATED' ? 'Scheduled (provider date)' : 'Confirmed date';
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
    return [type, earningsPhaseLabel(e), releaseText(e)].filter(Boolean).join(' · ');
  }
  return e.description;
}
