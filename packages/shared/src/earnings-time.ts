/**
 * When a company releases its results, in the company's market time and in the owner's (Europe/Amsterdam). Pure; uses `Intl` with explicit IANA
 * zones, so the gap between the two follows both daylight-saving calendars (the US switches a week after Europe: for one week in autumn and one
 * in spring the gap is 5 hours instead of 6).
 *
 * Time sources, best first:
 * 1. `releaseAt`, an exact instant that a source gave (shown as exact);
 * 2. the category of the provider: before the open, after the close or during market hours. Before the open maps to a typical clock time, after
 *    the close to the exchange's close plus five minutes; both are shown with a tilde and the word "typically", never as exact;
 * 3. nothing: "time not announced".
 */
import type { CalendarEarningsTime } from './calendar.js';

export const OWNER_TIME_ZONE = 'Europe/Amsterdam';
export const OWNER_TIME_LABEL = 'Amsterdam';

const DEFAULT_ZONE = 'America/New_York';
/** Typical clock time (local to the exchange) of a release before the open. */
const BEFORE_OPEN_MINUTES = 7 * 60;
/** A release after the close comes this long after the closing bell. */
const AFTER_CLOSE_DELAY_MINUTES = 5;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** IANA zone of the exchange a symbol suffix names (`ASML.AS`, `SAP.DE`); a symbol without a known suffix is a US listing. */
const SUFFIX_ZONES: Readonly<Record<string, string>> = {
  AS: 'Europe/Amsterdam',
  BR: 'Europe/Brussels',
  PA: 'Europe/Paris',
  LS: 'Europe/Lisbon',
  MI: 'Europe/Rome',
  MC: 'Europe/Madrid',
  DE: 'Europe/Berlin',
  F: 'Europe/Berlin',
  XETRA: 'Europe/Berlin',
  SW: 'Europe/Zurich',
  VI: 'Europe/Vienna',
  ST: 'Europe/Stockholm',
  CO: 'Europe/Copenhagen',
  HE: 'Europe/Helsinki',
  OL: 'Europe/Oslo',
  IR: 'Europe/Dublin',
  L: 'Europe/London',
  LSE: 'Europe/London',
  TO: 'America/Toronto',
  AX: 'Australia/Sydney',
  T: 'Asia/Tokyo',
  HK: 'Asia/Hong_Kong',
};

/** Closing time (minutes after midnight, local) of the exchange of a zone; zones not listed close at 16:00. */
const CLOSE_MINUTES: Readonly<Record<string, number>> = {
  'America/New_York': 16 * 60,
  'America/Toronto': 16 * 60,
  'Europe/London': 16 * 60 + 30,
  'Europe/Dublin': 16 * 60 + 30,
  'Asia/Tokyo': 15 * 60 + 30,
  'Asia/Hong_Kong': 16 * 60,
  'Australia/Sydney': 16 * 60,
};
const EUROPE_CLOSE_MINUTES = 17 * 60 + 30;
const DEFAULT_CLOSE_MINUTES = 16 * 60;

const ZONE_LABELS: Readonly<Record<string, string>> = { 'America/New_York': 'ET', 'America/Toronto': 'ET', [OWNER_TIME_ZONE]: OWNER_TIME_LABEL };
/** The usual spread of before-the-open releases on the US exchanges, shown next to the typical time. */
const US_BEFORE_OPEN_RANGE = '06:00-08:30';

/** The IANA zone of the exchange a symbol trades on (best effort from the suffix). */
export function exchangeZoneOf(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  if (dot < 0) return DEFAULT_ZONE;
  return SUFFIX_ZONES[symbol.slice(dot + 1).toUpperCase()] ?? DEFAULT_ZONE;
}

/** Short name of a zone for running text: `ET` for the US exchanges, else the city (`Berlin`, `London`). */
export function zoneLabel(zone: string): string {
  return ZONE_LABELS[zone] ?? zone.slice(zone.indexOf('/') + 1).replaceAll('_', ' ');
}

const closeMinutesOf = (zone: string): number => CLOSE_MINUTES[zone] ?? (zone.startsWith('Europe/') ? EUROPE_CLOSE_MINUTES : DEFAULT_CLOSE_MINUTES);

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(zone, formatter);
  }
  return formatter;
}

interface WallClock {
  day: string;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: Date, zone: string): WallClock {
  const parts = Object.fromEntries(formatterFor(zone).formatToParts(instant).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

const clockText = (clock: Pick<WallClock, 'hour' | 'minute'>): string => `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;

/** Offset of `zone` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(instant: Date, zone: string): number {
  const clock = wallClock(instant, zone);
  const [year, month, day] = clock.day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day, clock.hour, clock.minute, clock.second) - Math.trunc(instant.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock of `zone` reads `minutes` after midnight on `day` (`YYYY-MM-DD`). */
export function zonedInstant(day: string, minutes: number, zone: string): Date {
  const naive = Date.parse(`${day}T00:00:00Z`) + minutes * MS_PER_MINUTE;
  const first = new Date(naive - zoneOffsetMs(new Date(naive), zone));
  // Evaluated again at the first guess so that a day with a daylight-saving switch resolves correctly.
  return new Date(naive - zoneOffsetMs(first, zone));
}

export type EarningsTimeKind = 'exact' | 'typical' | 'unknown';

export interface EarningsReleaseTime {
  kind: EarningsTimeKind;
  category: CalendarEarningsTime;
  /** Who gave the time (`alphavantage`, `finnhub`, ...); absent when none did. */
  source?: string;
  /** The release in the company's market time (absent for `unknown`, and for a category without a clock time). */
  market?: { zone: string; label: string; time: string };
  /** The same instant in the owner's time; `dayOffset` is its calendar day minus the event's date (-1, 0 or 1). */
  owner?: { zone: string; label: string; time: string; dayOffset: number };
  /** The instant (ISO, UTC) of an exact release; absent otherwise. */
  at?: string;
  /** One sentence: `After the close, typically ~16:05 ET = ~22:05 Amsterdam`. */
  text: string;
  /** The clock part only: `~16:05 ET = ~22:05 Amsterdam`; the category when there is no clock time. */
  short: string;
}

export interface EarningsReleaseInput {
  symbol: string;
  /** The report date, `YYYY-MM-DD` (in the company's market). */
  date: string;
  timeOfDay?: CalendarEarningsTime;
  /** An exact release instant a source gave (ISO 8601 with an offset or `Z`). */
  releaseAt?: string;
  timeSource?: string;
}

const CATEGORY_TEXT: Readonly<Record<CalendarEarningsTime, string>> = {
  BMO: 'Before the open',
  AMC: 'After the close',
  DMH: 'During market hours',
  unknown: 'Time not announced',
};

const TYPICAL_LEAD: Readonly<Record<'BMO' | 'AMC', string>> = { BMO: 'Before the open, typically', AMC: 'After the close, typically' };

function dayOffsetOf(ownerDay: string, marketDay: string): number {
  return Math.round((Date.parse(`${ownerDay}T00:00:00Z`) - Date.parse(`${marketDay}T00:00:00Z`)) / MS_PER_DAY);
}

const offsetText = (offset: number): string => {
  if (offset > 0) return ' (next day)';
  return offset < 0 ? ' (previous day)' : '';
};

function bothZones(instant: Date, marketZone: string, ownerZone: string, date: string): Pick<EarningsReleaseTime, 'market' | 'owner'> {
  const market = wallClock(instant, marketZone);
  const owner = wallClock(instant, ownerZone);
  return {
    market: { zone: marketZone, label: zoneLabel(marketZone), time: clockText(market) },
    owner: { zone: ownerZone, label: zoneLabel(ownerZone), time: clockText(owner), dayOffset: dayOffsetOf(owner.day, date) },
  };
}

/** `16:05 ET = 22:05 Amsterdam`; one zone only when the company trades in the owner's zone. */
function clockPair(times: Required<Pick<EarningsReleaseTime, 'market' | 'owner'>>, approximate: boolean): string {
  const tilde = approximate ? '~' : '';
  const owner = `${tilde}${times.owner.time} ${times.owner.label}${offsetText(times.owner.dayOffset)}`;
  if (times.market.zone === times.owner.zone) return owner;
  return `${tilde}${times.market.time} ${times.market.label} = ${owner}`;
}

function withoutClock(category: CalendarEarningsTime, source: string | undefined): EarningsReleaseTime {
  const text = CATEGORY_TEXT[category];
  return { kind: 'unknown', category, ...(source === undefined ? {} : { source }), text, short: text };
}

function exactRelease(input: EarningsReleaseInput, instant: Date, marketZone: string, ownerZone: string): EarningsReleaseTime {
  const times = bothZones(instant, marketZone, ownerZone, input.date) as Required<Pick<EarningsReleaseTime, 'market' | 'owner'>>;
  const short = clockPair(times, false);
  return { kind: 'exact', category: input.timeOfDay ?? 'unknown', ...(input.timeSource === undefined ? {} : { source: input.timeSource }), ...times, at: instant.toISOString(), text: `Released at ${short}`, short };
}

function typicalMinutes(category: 'BMO' | 'AMC', zone: string): number {
  return category === 'BMO' ? BEFORE_OPEN_MINUTES : closeMinutesOf(zone) + AFTER_CLOSE_DELAY_MINUTES;
}

function typicalRelease(input: EarningsReleaseInput, category: 'BMO' | 'AMC', marketZone: string, ownerZone: string): EarningsReleaseTime {
  const instant = zonedInstant(input.date, typicalMinutes(category, marketZone), marketZone);
  const times = bothZones(instant, marketZone, ownerZone, input.date) as Required<Pick<EarningsReleaseTime, 'market' | 'owner'>>;
  const short = clockPair(times, true);
  const range = category === 'BMO' && marketZone === DEFAULT_ZONE ? ` (usually ${US_BEFORE_OPEN_RANGE} ET)` : '';
  return { kind: 'typical', category, ...(input.timeSource === undefined ? {} : { source: input.timeSource }), ...times, text: `${TYPICAL_LEAD[category]} ${short}${range}`, short };
}

/**
 * The release time of one earnings event in the company's market time and the owner's. `ownerZone` defaults to Amsterdam; both zones are
 * explicit IANA names, so daylight saving is applied on the event's own date.
 */
export function earningsReleaseTime(input: EarningsReleaseInput, ownerZone: string = OWNER_TIME_ZONE): EarningsReleaseTime {
  const marketZone = exchangeZoneOf(input.symbol);
  if (input.releaseAt !== undefined) {
    const instant = new Date(input.releaseAt);
    if (!Number.isNaN(instant.getTime())) return exactRelease(input, instant, marketZone, ownerZone);
  }
  const category = input.timeOfDay ?? 'unknown';
  if (category === 'BMO' || category === 'AMC') return typicalRelease(input, category, marketZone, ownerZone);
  return withoutClock(category, input.timeSource);
}
