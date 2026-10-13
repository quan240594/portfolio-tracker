const LOCALE = 'en-GB';
const MINUS = '\u2212';

const moneyCache = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, compact: boolean, maxDigits: number): Intl.NumberFormat {
  const key = `${currency}|${compact}|${maxDigits}`;
  let f = moneyCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      minimumFractionDigits: compact ? 0 : Math.min(2, maxDigits),
      maximumFractionDigits: compact ? 1 : maxDigits,
    });
    moneyCache.set(key, f);
  }
  return f;
}

/** Replace the ASCII hyphen-minus produced by Intl with a typographic minus sign. */
const typographicMinus = (s: string) => s.replace(/^-/, MINUS).replace(/-(?=\d)/, MINUS);

export interface MoneyOptions {
  /** Prefix positive values with "+". */
  signed?: boolean;
  compact?: boolean;
  /** Max fraction digits (defaults to 2). Useful for crypto/unit prices. */
  maxDigits?: number;
}

export function formatMoney(value: number, currency: string, opts: MoneyOptions = {}): string {
  const { signed = false, compact = false, maxDigits = 2 } = opts;
  const v = Object.is(value, -0) || Math.abs(value) < 0.005 ? 0 : value;
  const out = typographicMinus(moneyFormatter(currency, compact, maxDigits).format(v));
  return signed && v > 0 ? `+${out}` : out;
}

/** `value` is already a percentage (e.g. 12.5 → "12.50%"), matching the API's *Pct fields. */
export function formatPercent(value: number, opts: { signed?: boolean; digits?: number } = {}): string {
  const { signed = false, digits = 2 } = opts;
  const v = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
  const out = typographicMinus(
    new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v),
  );
  return `${signed && v > 0 ? '+' : ''}${out}%`;
}

/** `ratio` in 0..1 (e.g. Holding.weight) → "12.3%". */
export function formatWeight(ratio: number, digits = 1): string {
  return formatPercent(ratio * 100, { digits });
}

export function formatQuantity(value: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 8 }).format(value);
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  // Calendar dates (YYYY-MM-DD) are rendered as-is; timestamps in the user's local time zone.
  const dateOnly = iso.length === 10;
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  return new Intl.DateTimeFormat(LOCALE, { ...(dateOnly ? { timeZone: 'UTC' } : {}), ...opts }).format(d);
}

export function formatMonth(yyyyMm: string): string {
  return formatDate(`${yyyyMm}-01`, { month: 'short', year: '2-digit' });
}

export type Trend = 'up' | 'down' | 'flat';
export const trendOf = (value: number): Trend => (value > 0.000001 ? 'up' : value < -0.000001 ? 'down' : 'flat');
