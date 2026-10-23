/**
 * Baseline profile of a held instrument from Trading 212's instrument metadata (`GET /api/v0/equity/metadata/instruments`) and
 * the instrument of an open position: a real name, a STOCK/ETF type, the ISIN and the currency, with no market-data key.
 * It is the lowest quality a stored profile can have after `minimal`: a provider profile (sector, country of the company) always wins.
 *
 * The country is only a default derived from the ISIN prefix (the issuer's country for a share). For an ETF or ETC the prefix is
 * the fund's DOMICILE (Ireland, Luxembourg, Jersey ...), not where it invests, so a fund's country is only as good as that.
 */
import { normalizeCurrency } from './broker-fx.js';
import { isT212Ticker } from './t212-ticker.js';
import type { AssetClass, InstrumentProfile } from './types.js';

/** ISO 3166 alpha-2 prefix of an ISIN -> English country name (the names the market-data providers use). */
export const ISIN_COUNTRIES: Readonly<Record<string, string>> = {
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BM: 'Bermuda',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CN: 'China',
  CO: 'Colombia',
  CZ: 'Czech Republic',
  DE: 'Germany',
  DK: 'Denmark',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GG: 'Guernsey',
  GR: 'Greece',
  HK: 'Hong Kong',
  HU: 'Hungary',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IN: 'India',
  IT: 'Italy',
  JE: 'Jersey',
  JP: 'Japan',
  KR: 'South Korea',
  KY: 'Cayman Islands',
  LU: 'Luxembourg',
  MX: 'Mexico',
  MY: 'Malaysia',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PE: 'Peru',
  PH: 'Philippines',
  PL: 'Poland',
  PT: 'Portugal',
  RU: 'Russia',
  SE: 'Sweden',
  SG: 'Singapore',
  TH: 'Thailand',
  TR: 'Turkey',
  TW: 'Taiwan',
  US: 'United States',
  ZA: 'South Africa',
};

/** The country named by the ISIN prefix, or undefined for an unknown prefix or a malformed ISIN (`XS` international securities, ...). */
export function isinCountry(isin: string | undefined): string | undefined {
  if (isin === undefined || !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return undefined;
  return ISIN_COUNTRIES[isin.slice(0, 2)];
}

/** Trading 212 instrument `type` -> asset class (the API's values; a new one is `OTHER`, never an error). */
const T212_TYPES: Readonly<Record<string, AssetClass>> = {
  STOCK: 'STOCK',
  ETF: 'ETF',
  CRYPTOCURRENCY: 'CRYPTO',
  CRYPTO: 'CRYPTO',
};

export function assetClassFromTrading212Type(type: string | undefined): AssetClass {
  return (type === undefined ? undefined : T212_TYPES[type.trim().toUpperCase()]) ?? 'OTHER';
}

export interface Trading212Instrument {
  ticker: string;
  name?: string;
  shortName?: string;
  type?: string;
  isin?: string;
  currency?: string;
}

const clean = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

/** The baseline profile of `symbol` (the app's symbol for the Trading 212 instrument), `profileSource: 'trading212'`. */
export function trading212Profile(symbol: string, instrument: Trading212Instrument, fallbackCurrency: string): InstrumentProfile {
  const isin = clean(instrument.isin)?.toUpperCase();
  const country = isinCountry(isin);
  const currency = clean(instrument.currency);
  return {
    symbol,
    name: clean(instrument.name) ?? clean(instrument.shortName) ?? symbol,
    assetClass: assetClassFromTrading212Type(instrument.type),
    currency: currency === undefined ? fallbackCurrency : normalizeCurrency(currency).currency,
    ...(isin === undefined ? {} : { isin }),
    ...(country === undefined ? {} : { country }),
    ...(isT212Ticker(instrument.ticker) ? { t212Ticker: instrument.ticker } : {}),
    profileSource: 'trading212',
  };
}
