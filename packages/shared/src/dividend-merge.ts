/**
 * Dividend events come from several sources: the price provider (EODHD), a free fallback (Alpha Vantage `DIVIDENDS`) and the owner
 * (`source: 'manual'`). They are one event per symbol and ex-date; this is the rule for which record wins when two describe the same one.
 * Pure: the price job uses it when it stores events, the API when it adds the owner's own entries to what is stored.
 */
import type { DividendEvent } from './types.js';

export const MANUAL_DIVIDEND_SOURCE = 'manual';

const isManual = (event: DividendEvent): boolean => event.source === MANUAL_DIVIDEND_SOURCE;

/** How much a record says: a pay date weighs most, then a stated declaration. */
const completeness = (event: DividendEvent): number => (event.payDate === undefined ? 0 : 2) + (event.declared === true ? 1 : 0);

/** The record `primary` with what only `other` knows added (a pay date, the declaration), never replacing what `primary` has. */
function fillGaps(primary: DividendEvent, other: DividendEvent): DividendEvent {
  const payDate = primary.payDate ?? other.payDate;
  const declarationDate = primary.declarationDate ?? other.declarationDate;
  const declared = primary.declared === true || other.declared === true;
  return {
    ...primary,
    ...(payDate === undefined ? {} : { payDate }),
    ...(declarationDate === undefined ? {} : { declarationDate }),
    ...(declared ? { declared: true } : {}),
  };
}

/**
 * The record to keep when `incoming` arrives for an ex-date that already has `existing` (same symbol and ex-date).
 * - An entry of the owner is never overwritten by a provider, except by a provider record that has an amount: that one replaces it
 *   (the owner's pay date stays when the provider has none).
 * - A newer record of the same source is a correction and wins. Between sources the more complete record wins (a pay date, a declaration); equally complete,
 *   the newer one. What only the loser knows is kept.
 * - A record of the owner replaces a provider's only when the provider's has no amount.
 */
export function mergeDividendEvent(existing: DividendEvent | undefined, incoming: DividendEvent): DividendEvent {
  if (existing === undefined) return incoming;
  if (isManual(existing) && !isManual(incoming)) return incoming.amount > 0 ? fillGaps(incoming, existing) : existing;
  if (isManual(incoming) && !isManual(existing)) return existing.amount > 0 ? fillGaps(existing, incoming) : incoming;
  const winner = incoming.source === existing.source || completeness(incoming) >= completeness(existing) ? incoming : existing;
  return fillGaps(winner, winner === incoming ? existing : incoming);
}

const keyOf = (event: DividendEvent): string => `${event.symbol}\u0000${event.exDate}`;

/** Events of several sources as one per symbol and ex-date (see `mergeDividendEvent`); `earlier` are the older records, `later` the newer ones. */
export function mergeDividendEvents(earlier: readonly DividendEvent[], later: readonly DividendEvent[]): DividendEvent[] {
  const byKey = new Map<string, DividendEvent>();
  for (const event of [...earlier, ...later]) byKey.set(keyOf(event), mergeDividendEvent(byKey.get(keyOf(event)), event));
  return [...byKey.values()];
}

/** What the calendar works with: the stored (provider) events and the owner's own entries, one per ex-date. */
export const withManualDividends = (stored: readonly DividendEvent[], manual: readonly DividendEvent[]): DividendEvent[] => (manual.length === 0 ? [...stored] : mergeDividendEvents(manual, stored));
