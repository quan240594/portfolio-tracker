/**
 * Dates as a press release prints them ("January 15, 2027", "15 Jan 2027", "2027-01-15", "1/15/2027", "January 15") as ISO dates.
 * A date without a year takes the year that puts it closest after the release date (a dividend payable in January is next year's when the
 * release is from October). Anything that is not exactly one date is `undefined`: the value is dropped, never guessed.
 */
import { addDays } from './util.js';

const MONTHS: ReadonlyMap<string, number> = new Map([
  ['january', 1],
  ['jan', 1],
  ['february', 2],
  ['feb', 2],
  ['march', 3],
  ['mar', 3],
  ['april', 4],
  ['apr', 4],
  ['may', 5],
  ['june', 6],
  ['jun', 6],
  ['july', 7],
  ['jul', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['sept', 9],
  ['sep', 9],
  ['october', 10],
  ['oct', 10],
  ['november', 11],
  ['nov', 11],
  ['december', 12],
  ['dec', 12],
]);

/** Words a release puts around a date that carry no part of it. */
const FILLER: ReadonlySet<string> = new Set(['on', 'the', 'of']);
const ORDINALS = ['st', 'nd', 'rd', 'th'];
/** A year-less date more than this many days before the release date is read as next year's. */
const YEARLESS_LOOKBACK_DAYS = 60;

const pad = (value: number): string => String(value).padStart(2, '0');

/** `year-month-day` when it is a real calendar date. */
function isoOf(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}` : undefined;
}

const isNumber = (token: string): boolean => token !== '' && [...token].every((char) => char >= '0' && char <= '9');

/** `15th` as `15`, a number as itself, anything else `undefined`. */
function dayNumber(token: string): number | undefined {
  const suffix = ORDINALS.find((ordinal) => token.endsWith(ordinal));
  const digits = suffix === undefined ? token : token.slice(0, -suffix.length);
  return isNumber(digits) && digits.length <= 2 ? Number(digits) : undefined;
}

/** `2027-01-15`, `1/15/2027` (US order; a first number above 12 is the day), or `undefined`. */
function numericDate(text: string): string | undefined {
  const parts = text.split(/[/.-]/);
  if (parts.length !== 3 || !parts.every((part) => isNumber(part))) return undefined;
  const [first, second, third] = parts.map(Number) as [number, number, number];
  if (parts[0]!.length === 4) return isoOf(first, second, third);
  if (parts[2]!.length !== 4) return undefined;
  return first > 12 ? isoOf(third, second, first) : isoOf(third, first, second);
}

interface TextualParts {
  month: number;
  day: number;
  year?: number;
}

/** The month, day and (optional) year of a date written with a month name, in either order. */
function textualParts(text: string): TextualParts | undefined {
  const tokens = text
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => (token.endsWith('.') ? token.slice(0, -1) : token))
    .filter((token) => token !== '' && !FILLER.has(token));
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  for (const token of tokens) {
    const named = MONTHS.get(token);
    if (named !== undefined && month === undefined) month = named;
    else if (isNumber(token) && token.length === 4 && year === undefined) year = Number(token);
    else if (day === undefined && dayNumber(token) !== undefined) day = dayNumber(token);
    else return undefined;
  }
  return month === undefined || day === undefined ? undefined : { month, day, ...(year === undefined ? {} : { year }) };
}

/** The ISO date of a printed date, or `undefined`. `reportDate` (YYYY-MM-DD) places a date that has no year. */
export function parsePrintedDate(raw: string, reportDate: string): string | undefined {
  const text = raw.trim();
  const numeric = numericDate(text);
  if (numeric !== undefined) return numeric;
  const parts = textualParts(text);
  if (parts === undefined) return undefined;
  if (parts.year !== undefined) return isoOf(parts.year, parts.month, parts.day);
  const releaseYear = Number(reportDate.slice(0, 4));
  const sameYear = isoOf(releaseYear, parts.month, parts.day);
  if (sameYear === undefined) return undefined;
  return sameYear < addDays(reportDate, -YEARLESS_LOOKBACK_DAYS) ? isoOf(releaseYear + 1, parts.month, parts.day) : sameYear;
}

/** Whether `iso` lies within `days` days of `reportDate` (a dividend date far from the release belongs to something else). */
export function withinDays(iso: string, reportDate: string, days: number): boolean {
  return iso >= addDays(reportDate, -days) && iso <= addDays(reportDate, days);
}
