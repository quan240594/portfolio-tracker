import type { FxDay, FxRates } from './types.js';

/** Why a rate is not the fixing of the day asked for (see `FxTimeline.lookup`). */
export type FxFallback = 'none' | 'before' | 'after' | 'latest';

export interface FxLookup {
  rate: number;
  /** The fixing the rate comes from; null for the latest rate (no history) and for the base currency without a date. */
  date: string | null;
  fallback: FxFallback;
}

/** A newest fixing older than this many days (a long weekend plus a holiday) no longer stands in for a later day. */
export const FIXING_GAP_DAYS = 5;

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Index of the last of the ascending `dates` that is on or before `date`, or -1. */
function lastOnOrBefore(dates: readonly string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Why the fixing at `found` (see `lastOnOrBefore`) is not the one of `date`. */
function fallbackOf(dates: readonly string[], found: number, date: string): FxFallback {
  if (found < 0) return 'before';
  const newest = found === dates.length - 1;
  return newest && date > dates[found]! && daysBetween(dates[found]!, date) > FIXING_GAP_DAYS ? 'after' : 'none';
}

export class MissingFxRateError extends Error {
  constructor(public readonly currency: string, public readonly base: string) {
    super(`No FX rate for ${currency} against base ${base}`);
    this.name = 'MissingFxRateError';
  }
}

/** Converts `amount` in `currency` into `fx.base` at the latest rate. */
export function toBase(amount: number, currency: string, fx: FxRates): number {
  if (currency === fx.base) return amount;
  const rate = fx.rates[currency];
  if (!rate || rate <= 0) throw new MissingFxRateError(currency, fx.base);
  return amount / rate;
}

/**
 * Historical FX lookup. `rate(currency, date)` returns the ECB rate of the latest business day on
 * or before `date` (weekends/holidays carry the previous fixing). Dates before the first stored
 * fixing use that earliest fixing (closest in time); without a date or without any history for the
 * currency it falls back to the latest rates. Rates are units of `currency` per 1 base.
 */
export class FxTimeline {
  readonly base: string;
  private readonly series = new Map<string, { dates: string[]; rates: number[] }>();

  constructor(private readonly latest: FxRates, days: readonly FxDay[] = []) {
    this.base = latest.base;
    const sorted = days.filter((d) => d.base === latest.base).sort((a, b) => a.date.localeCompare(b.date));
    for (const day of sorted) {
      for (const [currency, rate] of Object.entries(day.rates)) {
        if (rate <= 0 || Number.isNaN(rate)) continue;
        let s = this.series.get(currency);
        if (!s) {
          s = { dates: [], rates: [] };
          this.series.set(currency, s);
        }
        s.dates.push(day.date);
        s.rates.push(rate);
      }
    }
  }

  /**
   * The rate for `currency` on `date` and where it comes from: the fixing of that day or the latest one before it (`none`), the
   * earliest stored fixing for a date before the history (`before`), the newest stored fixing for a date after it (`after`), or
   * the latest rate because there is no history for the currency (`latest`); without a date the latest rate is what was asked for (`none`).
   */
  lookup(currency: string, date?: string): FxLookup {
    if (currency === this.base) return { rate: 1, date: date ?? null, fallback: 'none' };
    const s = date ? this.series.get(currency) : undefined;
    if (s && date) {
      const found = lastOnOrBefore(s.dates, date);
      const index = Math.max(found, 0);
      return { rate: s.rates[index]!, date: s.dates[index]!, fallback: fallbackOf(s.dates, found, date) };
    }
    const latest = this.latest.rates[currency];
    if (!latest || latest <= 0) throw new MissingFxRateError(currency, this.base);
    return { rate: latest, date: null, fallback: date ? 'latest' : 'none' };
  }

  rate(currency: string, date?: string): number {
    return this.lookup(currency, date).rate;
  }

  /** The first and last stored fixing of `currency` and how many there are, or null without history. */
  span(currency: string): { first: string; last: string; fixings: number } | null {
    const s = this.series.get(currency);
    return s ? { first: s.dates[0]!, last: s.dates.at(-1)!, fixings: s.dates.length } : null;
  }

  toBase(amount: number, currency: string, date?: string): number {
    return amount / this.rate(currency, date);
  }
}
