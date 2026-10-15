import type { AssetMarkerType } from '@portfolio/shared';
import { formatMoney } from '../../lib/format';

/** In-app link to the detail page of a symbol (`BTC-EUR`, `ASML.AS`); the caller appends the portfolio scope. */
export const assetPath = (symbol: string): string => `/assets/${encodeURIComponent(symbol)}`;

/** Shown wherever a figure is not available from the stored data (never an invented value). */
export const DASH = '—';

/** Up to two capital letters from the name (`Apple Inc.` → `AI`, `Bitcoin` → `BI`), else the start of the symbol. */
export function initialsOf(name: string, symbol: string): string {
  const letters = name
    .split(/[\s.&-]+/)
    .filter((w) => /^\p{L}/u.test(w))
    .map((w) => w.charAt(0).toUpperCase());
  const initials = letters.slice(0, 2).join('');
  return initials.length === 2 ? initials : symbol.slice(0, 2).toUpperCase();
}

/** Tailwind colour pairs (light + dark) for the monogram avatars; picked from the symbol so a security keeps its colour. */
export const MONOGRAM_CLASSES = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200',
  'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  'bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-200',
] as const;

export function monogramClass(symbol: string): string {
  let hash = 0;
  for (const ch of symbol) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return MONOGRAM_CLASSES[hash % MONOGRAM_CLASSES.length]!;
}

export const MARKER_LABELS: Record<AssetMarkerType, string> = { BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend' };

/** Market cap and similar large amounts: "US$ 3,5 bln." (nl-NL compact notation). */
export const formatBigMoney = (value: number, currency: string): string => formatMoney(value, currency, { compact: true });

/** Plain number with a fixed number of decimals in the app's locale (P/E, EPS, beta). */
export const formatRatio = (value: number, digits = 2): string =>
  new Intl.NumberFormat('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

/** Unique React keys for items that may repeat (two identical trades on one day): later duplicates get a `#n` suffix. */
export function uniqueKeys<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = keyOf(item);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : key + '#' + n;
  });
}
