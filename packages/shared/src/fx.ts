import type { Currency, FxRates } from './types.js';

export class MissingFxRateError extends Error {
  constructor(public readonly currency: Currency, public readonly base: Currency) {
    super(`No FX rate for ${currency} against base ${base}`);
    this.name = 'MissingFxRateError';
  }
}

/** Converts `amount` in `currency` into `fx.base`. */
export function toBase(amount: number, currency: Currency, fx: FxRates): number {
  if (currency === fx.base) return amount;
  const rate = fx.rates[currency];
  if (!rate || rate <= 0) throw new MissingFxRateError(currency, fx.base);
  return amount / rate;
}
