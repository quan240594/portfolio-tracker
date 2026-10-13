import type { Currency, FxDay, FxRates, IsoDate } from './types.js';

export class MissingFxRateError extends Error {
  constructor(public readonly currency: Currency, public readonly base: Currency) {
    super(`No FX rate for ${currency} against base ${base}`);
    this.name = 'MissingFxRateError';
  }
}

/** Converts `amount` in `currency` into `fx.base` at the latest rate. */
export function toBase(amount: number, currency: Currency, fx: FxRates): number {
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
  readonly base: Currency;
  private readonly series = new Map<Currency, { dates: IsoDate[]; rates: number[] }>();

  constructor(private readonly latest: FxRates, days: readonly FxDay[] = []) {
    this.base = latest.base;
    const sorted = days.filter((d) => d.base === latest.base).sort((a, b) => a.date.localeCompare(b.date));
    for (const day of sorted) {
      for (const [currency, rate] of Object.entries(day.rates)) {
        if (!(rate > 0)) continue;
        let s = this.series.get(currency);
        if (!s) this.series.set(currency, (s = { dates: [], rates: [] }));
        s.dates.push(day.date);
        s.rates.push(rate);
      }
    }
  }

  rate(currency: Currency, date?: IsoDate): number {
    if (currency === this.base) return 1;
    const s = date ? this.series.get(currency) : undefined;
    if (s && date) {
      let lo = 0;
      let hi = s.dates.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (s.dates[mid]! <= date) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return s.rates[Math.max(found, 0)]!;
    }
    const latest = this.latest.rates[currency];
    if (!latest || latest <= 0) throw new MissingFxRateError(currency, this.base);
    return latest;
  }

  toBase(amount: number, currency: Currency, date?: IsoDate): number {
    return amount / this.rate(currency, date);
  }
}
