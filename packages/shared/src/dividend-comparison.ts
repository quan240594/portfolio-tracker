/**
 * How a dividend per share compares with the payment before it and with the one a year ago. Pure: the notification
 * messages, and anything else that wants "+2.4 % vs last quarter", build on it.
 *
 * Everything is per share and in the payment's own currency. Without an FX rate a reference in another currency
 * cannot be compared, so that comparison is omitted rather than guessed. Special dividends are not treated specially:
 * a payment is a payment. A reference that is zero (or not a number) never produces a percentage.
 */
import { daysBetween } from './analytics.js';

/** One dividend payment of a security: the date (ex-date or pay date, consistently within one history), the amount per share and its currency. */
export interface PerSharePayment {
  date: string;
  perShare: number;
  currency: string;
}

export interface DividendVsPrevious {
  /** Change of the per-share amount in percent, one decimal (5.8 = +5.8 %). */
  pct: number;
  previousPerShare: number;
  previousDate: string;
}

export interface DividendVsYearAgo {
  pct: number;
  yearAgoPerShare: number;
  yearAgoDate: string;
}

export interface DividendComparison {
  vsPrevious?: DividendVsPrevious;
  vsYearAgo?: DividendVsYearAgo;
}

/** The payment a year ago is the one closest to 12 months earlier, but at most this many days away from that date. */
export const YEAR_AGO_TOLERANCE_DAYS = 45;

/** Percent change from `reference` to `value`, rounded to one decimal; undefined when the reference is zero, negative or not finite. */
export function percentChange(value: number, reference: number): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference <= 0) return undefined;
  const pct = Math.round((value / reference - 1) * 1000) / 10;
  return pct === 0 ? 0 : pct;
}

/** The same calendar day one year earlier (29 February becomes 28 February). */
export function yearBefore(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${String(year - 1).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

const usable = (payment: PerSharePayment): boolean => Number.isFinite(payment.perShare) && payment.perShare > 0;

function previousOf(history: readonly PerSharePayment[], event: PerSharePayment): PerSharePayment | undefined {
  let best: PerSharePayment | undefined;
  for (const payment of history) {
    if (payment.date >= event.date) continue;
    if (best === undefined || payment.date >= best.date) best = payment;
  }
  return best;
}

function yearAgoOf(history: readonly PerSharePayment[], event: PerSharePayment): PerSharePayment | undefined {
  const target = yearBefore(event.date);
  let best: PerSharePayment | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const payment of history) {
    if (payment.date >= event.date) continue;
    const gap = Math.abs(daysBetween(target, payment.date));
    if (gap > YEAR_AGO_TOLERANCE_DAYS) continue;
    // Closest wins; on a tie the earlier payment (deterministic, whatever the order of the history).
    if (gap < bestGap || (gap === bestGap && best !== undefined && payment.date < best.date)) {
      best = payment;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Compares `event` with `history` (which may contain the event itself: payments on or after the event's date are ignored).
 * `vsPrevious`: the last payment before this one. `vsYearAgo`: the payment closest to 12 months earlier within
 * +-45 days, so monthly, quarterly, semi-annual and annual payers all find theirs.
 */
export function dividendComparison(history: readonly PerSharePayment[], event: PerSharePayment): DividendComparison {
  if (!usable(event)) return {};
  const comparison: DividendComparison = {};
  const previous = previousOf(history, event);
  if (previous && usable(previous) && previous.currency === event.currency) {
    const pct = percentChange(event.perShare, previous.perShare);
    if (pct !== undefined) comparison.vsPrevious = { pct, previousPerShare: previous.perShare, previousDate: previous.date };
  }
  const yearAgo = yearAgoOf(history, event);
  if (yearAgo && usable(yearAgo) && yearAgo.currency === event.currency) {
    const pct = percentChange(event.perShare, yearAgo.perShare);
    if (pct !== undefined) comparison.vsYearAgo = { pct, yearAgoPerShare: yearAgo.perShare, yearAgoDate: yearAgo.date };
  }
  return comparison;
}
