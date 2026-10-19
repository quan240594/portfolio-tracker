/** Date and time-zone helpers on Web-standard APIs only (`Intl` is available in Workers and Node). */

export const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` of the UTC calendar day. */
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Adds whole days to a `YYYY-MM-DD` date. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

/** Whole days from `from` to `to`. */
export const daysBetweenDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/** Day of week of a `YYYY-MM-DD` date, 0 = Sunday. */
export const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

export const isWeekday = (day: string): boolean => {
  const weekday = weekdayOf(day);
  return weekday !== 0 && weekday !== 6;
};

/** Date from epoch seconds, or `fallback` when the value is not a usable timestamp. */
export function fromEpochSeconds(seconds: number | null, fallback: Date): Date {
  if (seconds === null || seconds === 0) return fallback;
  const date = new Date(Math.trunc(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return parts;
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.trunc(date.getTime() / 1000) * 1000;
}

/** Local wall-clock hour (0-23) of `date` in `timeZone`. */
export const hourIn = (date: Date, timeZone: string): number => zonedParts(date, timeZone).hour!;

export const amsterdamHour = (date: Date): number => hourIn(date, 'Europe/Amsterdam');

/** The instant at which the wall clock of `timeZone` reads `hour:00` on `day`. */
export function zonedTimeToUtc(day: string, hour: number, timeZone: string): Date {
  const naive = new Date(`${day}T00:00:00Z`).getTime() + hour * 3_600_000;
  const first = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  // Re-evaluate at the first guess so that days with a daylight-saving switch resolve correctly.
  return new Date(naive - zoneOffsetMs(first, timeZone));
}
