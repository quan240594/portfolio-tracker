import type { InstrumentProfile } from '@portfolio/shared';
import { definedOnly } from './parse.js';

/** Canonical (Yahoo-style) symbol helpers: classification, currency, exchange and country by suffix. */
const CRYPTO = /^[A-Z0-9]+-[A-Z]{3}$/;
const SUFFIX = /^[A-Z0-9][A-Z0-9&-]*\.([A-Z]{1,4})$/;

interface ExchangeInfo {
  currency: string;
  exchange: string;
  country: string;
  /** EODHD exchange code. */
  code: string;
}

const exchange = (currency: string, name: string, country: string, code: string): ExchangeInfo => ({ currency, exchange: name, country, code });

export const EXCHANGES: Readonly<Record<string, ExchangeInfo>> = {
  AS: exchange('EUR', 'Euronext Amsterdam', 'Netherlands', 'AS'),
  DE: exchange('EUR', 'XETRA', 'Germany', 'XETRA'),
  F: exchange('EUR', 'Frankfurt', 'Germany', 'F'),
  PA: exchange('EUR', 'Euronext Paris', 'France', 'PA'),
  BR: exchange('EUR', 'Euronext Brussels', 'Belgium', 'BR'),
  LS: exchange('EUR', 'Euronext Lisbon', 'Portugal', 'LS'),
  IR: exchange('EUR', 'Euronext Dublin', 'Ireland', 'IR'),
  MI: exchange('EUR', 'Borsa Italiana', 'Italy', 'MI'),
  MC: exchange('EUR', 'BME Madrid', 'Spain', 'MC'),
  HE: exchange('EUR', 'Nasdaq Helsinki', 'Finland', 'HE'),
  VI: exchange('EUR', 'Vienna', 'Austria', 'VI'),
  L: exchange('GBP', 'London Stock Exchange', 'United Kingdom', 'LSE'),
  SW: exchange('CHF', 'SIX Swiss', 'Switzerland', 'SW'),
  ST: exchange('SEK', 'Nasdaq Stockholm', 'Sweden', 'ST'),
  CO: exchange('DKK', 'Nasdaq Copenhagen', 'Denmark', 'CO'),
  OL: exchange('NOK', 'Oslo Bors', 'Norway', 'OL'),
  TO: exchange('CAD', 'Toronto', 'Canada', 'TO'),
};

export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();

export const isCrypto = (symbol: string): boolean => CRYPTO.test(symbol);

/** `AS` for `ASML.AS`; null for bare US tickers and crypto. */
export function exchangeSuffix(symbol: string): string | null {
  if (isCrypto(symbol)) return null;
  return SUFFIX.exec(symbol)?.[1] ?? null;
}

export const hasExchangeSuffix = (symbol: string): boolean => exchangeSuffix(symbol) !== null;

export function baseTicker(symbol: string): string {
  const suffix = exchangeSuffix(symbol);
  return suffix === null ? symbol : symbol.slice(0, -(suffix.length + 1));
}

/** `BTC-EUR` -> ["BTC", "EUR"]. */
export function cryptoParts(symbol: string): [string, string] {
  const at = symbol.lastIndexOf('-');
  return [symbol.slice(0, at), symbol.slice(at + 1)];
}

export function currencyFor(symbol: string): string {
  if (isCrypto(symbol)) return cryptoParts(symbol)[1];
  const suffix = exchangeSuffix(symbol);
  if (suffix === null) return 'USD';
  return EXCHANGES[suffix]?.currency ?? 'EUR';
}

/** Currency raw provider prices are quoted in when the API omits it (London quotes in pence). */
export const priceCurrencyFor = (symbol: string): string => (exchangeSuffix(symbol) === 'L' ? 'GBX' : currencyFor(symbol));

export function exchangeFor(symbol: string): string | undefined {
  const suffix = exchangeSuffix(symbol);
  return suffix === null ? undefined : EXCHANGES[suffix]?.exchange;
}

export function countryFor(symbol: string): string | undefined {
  const suffix = exchangeSuffix(symbol);
  if (suffix === null) return isCrypto(symbol) ? undefined : 'United States';
  return EXCHANGES[suffix]?.country;
}

/** Fallback profile derived only from the symbol, for when no provider knows the instrument. */
export function minimalProfile(symbol: string): InstrumentProfile {
  if (isCrypto(symbol)) return { symbol, name: cryptoParts(symbol)[0], assetClass: 'CRYPTO', currency: currencyFor(symbol) };
  return definedOnly({ symbol, name: symbol, assetClass: 'OTHER', currency: currencyFor(symbol), country: countryFor(symbol), exchange: exchangeFor(symbol) } as InstrumentProfile);
}

export type Route = 'crypto' | 'listed' | 'us';

export function routeOf(symbol: string): Route {
  if (isCrypto(symbol)) return 'crypto';
  return hasExchangeSuffix(symbol) ? 'listed' : 'us';
}
