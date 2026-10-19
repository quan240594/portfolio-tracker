import { DEFAULT_BASE_CURRENCY } from '@portfolio/shared';

/** All numbers, amounts and dates are presented the Dutch way (e.g. "€ 1.234,56", "+12,34%", "13 okt 2026"). */
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

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTIONS): string {
  // Calendar dates (YYYY-MM-DD) are rendered as-is; timestamps in the user's local time zone.
  const dateOnly = iso.length === 10;
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  return new Intl.DateTimeFormat(LOCALE, { ...(dateOnly ? { timeZone: 'UTC' } : {}), ...opts }).format(d);
}

export function formatMonth(yyyyMm: string): string {
  return formatDate(`${yyyyMm}-01`, { month: 'short', year: '2-digit' });
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
