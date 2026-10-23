/**
 * Minor-unit currencies (GBX/GBp pence, ZAc, ILA) in stored market data.
 *
 * Invariant: stored prices are always in major units, so a minor-unit code never reaches a valuation. The price
 * providers rescale at the source (`makeEod` and friends in `@portfolio/prices`); these helpers rescale again when
 * stored rows are read, so rows written before the providers did so can never be valued a hundred times too high.
 * Every helper is idempotent: a row already in a major currency is returned as it is (the same object).
 */
import { normalizeCurrency } from './broker-fx.js';
import type { DividendEvent, EodPrice, Quote } from './types.js';

/** The ISO major currency of a minor-unit code and the divisor to apply, or null for any other code. */
export function minorUnit(code: unknown): { currency: string; divisor: number } | null {
  if (typeof code !== 'string') return null;
  const normalized = normalizeCurrency(code);
  return normalized.divisor === 1 ? null : normalized;
}

/** Whether `code` is a minor-unit code (GBX, GBp, ZAc, ILA). */
export const isMinorUnitCurrency = (code: unknown): boolean => minorUnit(code) !== null;

export function majorEod(eod: EodPrice): EodPrice {
  const minor = minorUnit(eod.currency);
  return minor === null ? eod : { ...eod, close: eod.close / minor.divisor, currency: minor.currency };
}

export function majorQuote(quote: Quote): Quote {
  const minor = minorUnit(quote.currency);
  return minor === null ? quote : { ...quote, price: quote.price / minor.divisor, previousClose: quote.previousClose / minor.divisor, currency: minor.currency };
}

export function majorDividend(event: DividendEvent): DividendEvent {
  const minor = minorUnit(event.currency);
  return minor === null ? event : { ...event, amount: event.amount / minor.divisor, currency: minor.currency };
}

/** The ISO major currency code of `code` (a profile's currency is a label: its prices are never rescaled). */
export const majorCurrencyCode = (code: string): string => minorUnit(code)?.currency ?? code;
