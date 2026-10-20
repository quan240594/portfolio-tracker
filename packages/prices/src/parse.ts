import { normalizeDomain } from '@portfolio/shared';

/** Defensive value parsing shared by the providers (mirrors `prices/providers/base.py`). */

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export const MAX_DESCRIPTION_CHARS = 2000;
const ISIN = /^[A-Z0-9]{12}$/;
const PLACEHOLDERS = new Set(['NONE', 'N/A', 'NA', '-']);

/** The value stored under `key` itself: provider text must never reach `Object.prototype` members such as `constructor`. */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number from a JSON number or a numeric string; "", "NA", "None", NaN, infinities and garbage give null. */
export function asFloat(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === 'NA' || !DECIMAL.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Strictly positive finite number (P/E, market cap); everything else means "no usable value". */
export function positiveNumber(value: unknown): number | null {
  const parsed = asFloat(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** Non-empty string or undefined. */
/** Provider text of a field that should be a string or a number; anything else (objects, null) is ''. */
export const asText = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

export const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** A provider's company website as a bare public domain (`https://www.apple.com` -> `apple.com`); anything that is not one is absent. */
export const websiteDomain = (value: unknown): string | undefined => (typeof value === 'string' ? normalizeDomain(value) : undefined);

/** Provider free text: trimmed, whitespace collapsed, capped at `limit`; placeholders like "None" or "-" mean absent. */
export function cleanText(value: unknown, limit = MAX_DESCRIPTION_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed === '' || PLACEHOLDERS.has(collapsed.toUpperCase())) return undefined;
  const chars = Array.from(collapsed);
  if (chars.length <= limit) return collapsed;
  return `${chars
    .slice(0, limit - 1)
    .join('')
    .trimEnd()}…`;
}

/** 12 upper-case letters/digits, or undefined. */
export function validIsin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const isin = value.trim().toUpperCase();
  return ISIN.test(isin) ? isin : undefined;
}

export const byText = (a: string, b: string): number => a.localeCompare(b);

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The object without its undefined attributes (stored items never carry them). */
export function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Title case as Python's `str.title()`: the first letter of every run of letters upper case, the rest lower case. */
export const titleCase = (value: string): string => value.toLowerCase().replaceAll(/(^|[^\p{L}])(\p{L})/gu, (_all, sep: string, letter: string) => sep + letter.toUpperCase());

/** First 10 characters of a provider date/timestamp (`YYYY-MM-DD`). */
export const dayOf = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 10) : '');

/** A valid `YYYY-MM-DD` (calendar-checked) or null. */
export function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate ? null : candidate;
}
