import { T212_QUOTE_SOURCE, majorEod, type EodPrice, type Quote, type T212QuoteStatus } from '@portfolio/shared';

/**
 * The end-of-day snapshot of the Trading 212 quote refresh: at the close slot the quote of every held symbol is also kept as the
 * EOD row of the calendar day, so a symbol no market-data provider covers still builds a real price history from now on.
 */
export const END_OF_DAY_ZONE = 'Europe/Amsterdam';
/** A quote older than this is not a price of "today" (a Friday close is 36 h old on Saturday evening). */
export const MAX_QUOTE_AGE_MS = 36 * 3_600_000;

export interface CalendarDay {
  /** `YYYY-MM-DD` on the clock of the zone. */
  date: string;
  weekend: boolean;
}

/** The calendar day of `at` in `timeZone` (DST-aware), and whether it is a Saturday or Sunday there. */
export function calendarDay(at: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  const weekday = part('weekday');
  return { date: `${part('year')}-${part('month')}-${part('day')}`, weekend: weekday === 'Sat' || weekday === 'Sun' };
}

/** `close`: the close slot, once a day. `seed`: the first run after the feature exists writes today's row too. */
export type SnapshotMode = 'close' | 'seed' | 'none';

export function snapshotMode(trigger: 'scheduled' | 'sync' | 'close', previous: Readonly<Pick<T212QuoteStatus, 'eodSeededAt' | 'eodClosedDay'>> | null, day: CalendarDay): SnapshotMode {
  if (day.weekend) return 'none';
  if (trigger === 'close' && previous?.eodClosedDay !== day.date) return 'close';
  return previous?.eodSeededAt === undefined ? 'seed' : 'none';
}

/** The quotes that came from Trading 212 and are not older than `MAX_QUOTE_AGE_MS`. */
export function freshQuotes(quotes: readonly Quote[], now: Date): Quote[] {
  return quotes.filter((quote) => quote.source === T212_QUOTE_SOURCE && now.getTime() - Date.parse(quote.asOf) <= MAX_QUOTE_AGE_MS);
}

/**
 * The rows to write for `day`: one per quote, in major units, unless a market-data provider already has a row for that symbol and day
 * (`existing` maps a symbol with a row to its `source`, undefined for a provider's). A Trading 212 row of the day is replaced: the later
 * quote is the better close.
 */
export function endOfDayRows(quotes: readonly Quote[], day: string, existing: ReadonlyMap<string, string | undefined>): EodPrice[] {
  return quotes
    .filter((quote) => !existing.has(quote.symbol) || existing.get(quote.symbol) === T212_QUOTE_SOURCE)
    .map((quote) => majorEod({ symbol: quote.symbol, date: day, close: quote.price, currency: quote.currency, source: T212_QUOTE_SOURCE }));
}
