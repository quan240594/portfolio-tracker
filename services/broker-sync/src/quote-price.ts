import { T212_QUOTE_SOURCE, normalizeCurrency, roundTo, type Quote } from '@portfolio/shared';
import type { OpenPosition } from './t212/schemas.js';

/** Units per 1 EUR (the stored ECB rates; EUR itself is implicit). */
export type EuroRates = Readonly<Record<string, number>>;

export interface ResolvedPrice {
  /** In major units of `currency` (London pence become pounds). */
  price: number;
  /** ISO-4217 major currency. */
  currency: string;
}

const isPositive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/** Units of `currency` per 1 EUR, or undefined when that rate is not stored. */
function rateOf(currency: string, rates: EuroRates): number | undefined {
  const upper = currency.toUpperCase();
  const rate = upper === 'EUR' ? 1 : rates[upper];
  return isPositive(rate) ? rate : undefined;
}

/**
 * The price Trading 212 implies for one share in pounds, from the account-currency value of the position
 * (`walletImpact.currentValue / quantity`, converted at the stored ECB rates), or undefined when it cannot be derived.
 */
function impliedPounds({ quantity, walletImpact }: OpenPosition, rates: EuroRates): number | undefined {
  if (!isPositive(quantity) || !isPositive(walletImpact?.currentValue) || !walletImpact.currency) return undefined;
  const account = rateOf(walletImpact.currency, rates);
  const pound = rateOf('GBP', rates);
  if (account === undefined || pound === undefined) return undefined;
  return ((walletImpact.currentValue / quantity) * pound) / account;
}

/** A price within this factor of exactly 100 times (or 1/100 of) the implied one is a pence/pounds mix-up; the margin covers FX moves and rounding. */
const SCALE_MARGIN = 2;

/**
 * London listings are quoted in pence (`GBX`), but the label cannot always be trusted: Trading 212 has been seen to say `GBP`
 * for a price in pence. The value of the position in the account currency settles it, so a price 100 times too high is divided
 * and one 100 times too low (a `GBX` label on a price already in pounds) is multiplied. Without that value (or the stored
 * rates to use it) the currency label alone decides.
 */
function pounds(price: number, position: OpenPosition, rates: EuroRates): number {
  const implied = impliedPounds(position, rates);
  if (implied === undefined) return price;
  const ratio = price / implied;
  if (ratio >= 100 / SCALE_MARGIN && ratio <= 100 * SCALE_MARGIN) return price / 100;
  if (ratio >= 0.01 / SCALE_MARGIN && ratio <= 0.01 * SCALE_MARGIN) return price * 100;
  return price;
}

/**
 * The last price of an open position in an ISO-4217 major currency, or undefined when Trading 212 reported none. `GBX` (pence) is
 * divided by 100 like everywhere else in the app (`normalizeCurrency`); see `pounds` for the mislabelled-pence safeguard.
 */
export function resolvePrice(position: OpenPosition, rates: EuroRates): ResolvedPrice | undefined {
  const { currentPrice, instrument } = position;
  if (!isPositive(currentPrice)) return undefined;
  const { currency, divisor } = normalizeCurrency(instrument.currency);
  const price = currency === 'GBP' ? pounds(currentPrice / divisor, position, rates) : currentPrice / divisor;
  return { price: roundTo(price, 6), currency };
}

const sameDay = (a: string, b: string): boolean => a.slice(0, 10) === b.slice(0, 10);

export interface QuoteCandidate extends ResolvedPrice {
  symbol: string;
  /** ISO time of the refresh. */
  asOf: string;
}

/**
 * The quote to store for `candidate`, or undefined when the stored one must stay: a quote (of any source, a market-data provider
 * included) with the same or a newer `asOf` wins. The previous close is never invented: within a UTC day the stored one is kept;
 * on the first quote of a new day it is the last price the stored quote had (the close of the day before, as the last run of a day
 * is after the closes); with nothing stored, or in another currency, it equals the price, i.e. the day change is 0.
 */
export function mergeQuote(candidate: QuoteCandidate, stored: Quote | undefined): Quote | undefined {
  const { symbol, price, currency, asOf } = candidate;
  const fresh = (previousClose: number): Quote => ({ symbol, price, previousClose, currency, asOf, source: T212_QUOTE_SOURCE });
  if (stored && Date.parse(stored.asOf) >= Date.parse(asOf)) return undefined;
  if (stored?.currency !== currency) return fresh(price);
  return fresh(sameDay(stored.asOf, asOf) ? stored.previousClose : stored.price);
}
