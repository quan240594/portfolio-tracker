import { DEFAULT_BASE_CURRENCY } from '@portfolio/shared';

/** Numbers and amounts are presented the Dutch way (e.g. "€ 1.234,56", "+12,34%"); dates are not (see below). */
export const LOCALE = 'nl-NL';
export const BASE_CURRENCY = DEFAULT_BASE_CURRENCY;
const MINUS = '\u2212';

const moneyCache = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, compact: boolean, maxDigits: number, signed: boolean): Intl.NumberFormat {
  const key = `${currency}|${compact}|${maxDigits}|${signed}`;
  let f = moneyCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      minimumFractionDigits: compact ? 0 : Math.min(2, maxDigits),
      maximumFractionDigits: compact ? 1 : maxDigits,
      signDisplay: signed ? 'exceptZero' : 'auto',
    });
    moneyCache.set(key, f);
  }
  return f;
}

/** Replace the ASCII hyphen-minus produced by Intl with a typographic minus sign. */
const typographicMinus = (s: string) => s.replace(/^-/, MINUS).replace(/-(?=\d)/, MINUS);

export interface MoneyOptions {
  /** Show an explicit "+" on positive values (placed by the locale: "€ +10,00"). */
  signed?: boolean;
  compact?: boolean;
  /** Max fraction digits (defaults to 2). Useful for crypto/unit prices. */
  maxDigits?: number;
}

/** Formats an amount; `currency` defaults to the portfolio base currency (EUR). */
export function formatMoney(value: number, currency: string = BASE_CURRENCY, opts: MoneyOptions = {}): string {
  const { signed = false, compact = false, maxDigits = 2 } = opts;
  const v = Object.is(value, -0) || Math.abs(value) < 0.005 ? 0 : value;
  return typographicMinus(moneyFormatter(currency || BASE_CURRENCY, compact, maxDigits, signed).format(v));
}

/** `value` is already a percentage (e.g. 12.5 → "12,50%"), matching the API's *Pct fields. */
export function formatPercent(value: number, opts: { signed?: boolean; digits?: number } = {}): string {
  const { signed = false, digits = 2 } = opts;
  const v = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
  const out = typographicMinus(
    new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v),
  );
  return `${signed && v > 0 ? '+' : ''}${out}%`;
}

/** `ratio` in 0..1 (e.g. Holding.weight) → "12,3%". */
export function formatWeight(ratio: number, digits = 1): string {
  return formatPercent(ratio * 100, { digits });
}

export function formatQuantity(value: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 8 }).format(value);
}

/** A plain count or measurement with thousands separators (1500 → "1.500", 12.5 → "12,5"); at most `maxDigits` decimals. */
export function formatCount(value: number, maxDigits = 2): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxDigits }).format(value);
}

/** FX rate in units of the foreign currency per 1 base unit (e.g. 1.0842 → "1,0842"). */
export function formatFxRate(rate: number): string {
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(rate);
}

/*
 * Dates are assembled by hand from English name tables so the output is identical in every browser/ICU build:
 * numeric dates are always dd-mm-yyyy, month and weekday names are always English.
 */
export const MONTH_NAMES_LONG: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** "Jan"…"Dec", also used as the x-axis categories of the dividends month comparison. */
export const MONTH_NAMES_SHORT: readonly string[] = MONTH_NAMES_LONG.map((name) => name.slice(0, 3));
const WEEKDAY_NAMES_LONG: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface DateParts {
  year: number;
  /** 0-based. */
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

/** Calendar dates (YYYY-MM-DD) are read as-is (UTC, so they never shift); timestamps in the user's local time zone. */
function partsOf(iso: string): DateParts {
  const dateOnly = iso.length === 10;
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (dateOnly) {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay(), hour: 0, minute: 0 };
  }
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay(), hour: d.getHours(), minute: d.getMinutes() };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const numericDate = (p: DateParts): string => `${pad2(p.day)}-${pad2(p.month + 1)}-${String(p.year).padStart(4, '0')}`;
const clock = (p: DateParts): string => `${pad2(p.hour)}:${pad2(p.minute)}`;

/** "20-10-2026" (dd-mm-yyyy). */
export function formatDate(iso: string): string {
  return numericDate(partsOf(iso));
}

/** "20-10-2026, 11:27" (24-hour, local time). */
export function formatDateTime(iso: string): string {
  const p = partsOf(iso);
  return `${numericDate(p)}, ${clock(p)}`;
}

/** "11:27" (24-hour, local time). */
export function formatTime(iso: string): string {
  return clock(partsOf(iso));
}

/** "Friday, 02-10-2026". */
export function formatWeekdayDate(iso: string): string {
  const p = partsOf(iso);
  return `${WEEKDAY_NAMES_LONG[p.weekday]}, ${numericDate(p)}`;
}

/** "Monday". */
export function formatWeekdayLong(iso: string): string {
  return WEEKDAY_NAMES_LONG[partsOf(iso).weekday] ?? '';
}

/** "Mon". */
export function formatWeekdayShort(iso: string): string {
  return formatWeekdayLong(iso).slice(0, 3);
}

/** "Mon 02:00": local weekday and time. */
export function formatWeekdayTime(iso: string): string {
  const p = partsOf(iso);
  return `${WEEKDAY_NAMES_LONG[p.weekday]?.slice(0, 3)} ${clock(p)}`;
}

/** "October 2026" for a "YYYY-MM" key (or any ISO date). */
export function formatMonthYear(yyyyMm: string): string {
  const p = partsOf(`${yyyyMm.slice(0, 7)}-01`);
  return `${MONTH_NAMES_LONG[p.month]} ${p.year}`;
}

/** Compact chart label "Oct 26" for a "YYYY-MM" key. */
export function formatMonth(yyyyMm: string): string {
  const p = partsOf(`${yyyyMm.slice(0, 7)}-01`);
  return `${MONTH_NAMES_SHORT[p.month]} ${pad2(p.year % 100)}`;
}

/** "Oct": the short month name of an ISO date. */
export function formatMonthShort(iso: string): string {
  return MONTH_NAMES_SHORT[partsOf(iso).month] ?? '';
}

/** "2 Oct": short day + month for chart axes. */
export function formatDayMonthShort(iso: string): string {
  const p = partsOf(iso);
  return `${p.day} ${MONTH_NAMES_SHORT[p.month]}`;
}

/** The day of the month without padding ("2"). */
export function formatDayOfMonth(iso: string): string {
  return String(partsOf(iso).day);
}

/**
 * Normalises a typed decimal for the shared zod schemas (which expect a "." decimal point): accepts the
 * Dutch "1.234,56" / "0,25" as well as "1234.56". The right-most "," or "." is taken as the decimal mark.
 */
export function normalizeDecimalInput(raw: string): string {
  const s = raw.trim().replaceAll(/\s/g, '');
  const comma = s.lastIndexOf(',');
  if (comma === -1) return s;
  if (comma > s.lastIndexOf('.')) return s.replaceAll('.', '').replaceAll(',', '.');
  return s.replaceAll(',', '');
}

export type Trend = 'up' | 'down' | 'flat';
export const trendOf = (value: number): Trend => {
  if (value > 0.000001) return 'up';
  if (value < -0.000001) return 'down';
  return 'flat';
};
