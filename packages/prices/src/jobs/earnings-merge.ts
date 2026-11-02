import { daysBetween, earningsConfirmation, type EarningsConflict, type EarningsSourceName, type StoredEarningsEvent } from '@portfolio/shared';
import { byText, definedOnly } from '../parse.js';

/** Stored events of the symbols, as they were before this run (only today and later). */
export type StoredAhead = ReadonlyMap<string, readonly StoredEarningsEvent[]>;

/** Dates of two sources for one company this close (days) are the same quarter's report, so they conflict. */
const SAME_QUARTER_DAYS = 45;

const keyOf = (event: Pick<StoredEarningsEvent, 'symbol' | 'date'>): string => `${event.symbol}\u0000${event.date}`;

function bySymbol(events: readonly StoredEarningsEvent[]): Map<string, StoredEarningsEvent[]> {
  const grouped = new Map<string, StoredEarningsEvent[]>();
  for (const event of events) grouped.set(event.symbol, [...(grouped.get(event.symbol) ?? []), event]);
  return grouped;
}

const sourceOf = (event: StoredEarningsEvent): EarningsSourceName => (event.source === 'finnhub' ? 'finnhub' : 'alphavantage');

/** The two sources list the same date: one event; Finnhub's time of day and estimate fill what Alpha Vantage leaves out, and Finnhub is the source. */
function combine(alpha: StoredEarningsEvent, finnhub: StoredEarningsEvent): StoredEarningsEvent {
  const useFinnhubTime = alpha.timeOfDay === undefined || alpha.timeOfDay === 'unknown';
  return definedOnly<StoredEarningsEvent>({
    ...alpha,
    epsEstimate: alpha.epsEstimate ?? finnhub.epsEstimate,
    timeOfDay: useFinnhubTime ? (finnhub.timeOfDay ?? alpha.timeOfDay) : alpha.timeOfDay,
    timeSource: useFinnhubTime && finnhub.timeOfDay !== undefined && finnhub.timeOfDay !== 'unknown' ? 'finnhub' : alpha.timeSource,
    source: 'finnhub',
  });
}

/** A stored event that already counts as confirmed (listed on enough separate days, close enough) outranks a new listing of another date. */
function alreadyConfirmed(ahead: readonly StoredEarningsEvent[], event: StoredEarningsEvent, today: string): boolean {
  const prior = ahead.find((stored) => keyOf(stored) === keyOf(event));
  return prior !== undefined && prior.date > today && earningsConfirmation(prior, today).confirmed;
}

/**
 * Resolves one company's dates from two sources. The same date is one event; a different date of the same quarter is a conflict: the date
 * that is already confirmed in the store wins, otherwise Finnhub's (its calendar is the near-term one; Alpha Vantage lists the next report
 * up to twelve months out, much of it an estimate). The loser is not stored and is named in the run record.
 */
function resolveSymbol(alpha: readonly StoredEarningsEvent[], finnhub: readonly StoredEarningsEvent[], ahead: readonly StoredEarningsEvent[], today: string): { events: StoredEarningsEvent[]; conflicts: EarningsConflict[] } {
  const events: StoredEarningsEvent[] = [];
  const conflicts: EarningsConflict[] = [];
  const finnhubDates = new Map(finnhub.map((event) => [event.date, event]));
  const kept = new Set<string>();
  for (const event of alpha) {
    const same = finnhubDates.get(event.date);
    if (same !== undefined) {
      events.push(combine(event, same));
      kept.add(event.date);
      continue;
    }
    const rival = finnhub.find((other) => Math.abs(daysBetween(event.date, other.date)) < SAME_QUARTER_DAYS);
    if (rival === undefined) {
      events.push(event);
    } else if (alreadyConfirmed(ahead, event, today)) {
      events.push(event);
      kept.add(rival.date);
      conflicts.push({ symbol: event.symbol, kept: { source: sourceOf(event), date: event.date }, dropped: { source: sourceOf(rival), date: rival.date } });
    } else {
      conflicts.push({ symbol: event.symbol, kept: { source: sourceOf(rival), date: rival.date }, dropped: { source: sourceOf(event), date: event.date } });
    }
  }
  const droppedFinnhub = new Set(conflicts.filter((conflict) => conflict.dropped.source === 'finnhub').map((conflict) => conflict.dropped.date));
  for (const event of finnhub) {
    if (!kept.has(event.date) && !droppedFinnhub.has(event.date)) events.push(event);
  }
  return { events, conflicts };
}

export interface MergedEarnings {
  events: StoredEarningsEvent[];
  conflicts: EarningsConflict[];
}

/** The events of both sources as one list (sorted by symbol and date) and the conflicts between them. */
export function mergeEarningsSources(alpha: readonly StoredEarningsEvent[], finnhub: readonly StoredEarningsEvent[], ahead: StoredAhead, today: string): MergedEarnings {
  const alphaBySymbol = bySymbol(alpha);
  const finnhubBySymbol = bySymbol(finnhub);
  const symbols = [...new Set([...alphaBySymbol.keys(), ...finnhubBySymbol.keys()])].toSorted(byText);
  const events: StoredEarningsEvent[] = [];
  const conflicts: EarningsConflict[] = [];
  for (const symbol of symbols) {
    const resolved = resolveSymbol(alphaBySymbol.get(symbol) ?? [], finnhubBySymbol.get(symbol) ?? [], ahead.get(symbol) ?? [], today);
    events.push(...resolved.events);
    conflicts.push(...resolved.conflicts);
  }
  return { events: events.toSorted((a, b) => byText(keyOf(a), keyOf(b))), conflicts };
}

/**
 * Adds the reading history to the events of this run: `firstSeenOn`, `lastSeenOn` and `reads` (separate days a provider listed this very
 * date). A second read on the same day does not count, and a date the store has not seen starts at one read: a changed date is a new item.
 */
export function trackSeen(events: readonly StoredEarningsEvent[], ahead: StoredAhead, today: string): StoredEarningsEvent[] {
  return events.map((event) => {
    const prior = ahead.get(event.symbol)?.find((stored) => stored.date === event.date);
    if (prior === undefined) return { ...event, firstSeenOn: today, lastSeenOn: today, reads: 1 };
    const lastSeen = prior.lastSeenOn ?? prior.updatedAt?.slice(0, 10) ?? today;
    const reads = Math.max(prior.reads ?? 1, 1) + (lastSeen < today ? 1 : 0);
    return { ...event, firstSeenOn: prior.firstSeenOn ?? lastSeen, lastSeenOn: lastSeen.localeCompare(today) < 0 ? today : lastSeen, reads };
  });
}
