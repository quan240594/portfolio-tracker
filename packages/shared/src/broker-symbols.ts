import { normalizeCurrency } from './broker-fx.js';

/**
 * Trading 212 instrument -> canonical Yahoo-style symbol (see docs/architecture.md "Symbols").
 *
 * Never guesses: when the listing cannot be established the instrument is reported as unmapped (with a reason) so
 * it can be skipped and listed instead of silently mapping to a wrong symbol. Resolution order:
 *   1. explicit override (by T212 ticker or ISIN; also bypasses the built-in rename table)
 *   2. ticker shape: `AAPL_US_EQ` (country code), `ASMLa_EQ` / `VUSAl_EQ` (venue letter)
 *   3. exchange name from the instruments metadata (bare `SAP_EQ` tickers only)
 *   4. ISIN country prefix (bare tickers only; ETF-typical IE/LU prefixes are never used)
 * and the result must be a plausible currency for that venue.
 */

/** Yahoo exchange suffix by ISO country code ('' = bare US ticker). */
const COUNTRY_SUFFIX: Readonly<Record<string, string>> = {
  US: '',
  GB: '.L',
  NL: '.AS',
  NA: '.AS',
  DE: '.DE',
  FR: '.PA',
  IT: '.MI',
  ES: '.MC',
  CH: '.SW',
  BE: '.BR',
  PT: '.LS',
  AT: '.VI',
  FI: '.HE',
  SE: '.ST',
  DK: '.CO',
  NO: '.OL',
  IE: '.IR',
  CA: '.TO',
  AU: '.AX',
};

/** Trading 212 venue letter appended to the ticker of non-US instruments (`ASMLa_EQ`). */
const VENUE_LETTER_SUFFIX: Readonly<Record<string, string>> = {
  l: '.L',
  d: '.DE',
  a: '.AS',
  p: '.PA',
  m: '.MI',
  e: '.MC',
  s: '.SW',
};

/**
 * Symbols Trading 212 still reports under the old name of a renamed listing; Yahoo only serves the new one.
 * A closed list of well-known corporate renames, not a guess: add others via the override map.
 */
const RENAMED_SYMBOLS: Readonly<Record<string, string>> = {
  FB: 'META',
  'DAI.DE': 'MBG.DE',
};

/** ETFs are commonly IE/LU domiciled but listed elsewhere, so those prefixes say nothing about the venue. */
const ISIN_COUNTRY_EXCLUDED = new Set(['IE', 'LU']);

/** Currencies (major units) a security on that venue can plausibly trade in. */
const VENUE_CURRENCIES: Readonly<Record<string, readonly string[]>> = {
  '': ['USD'],
  '.L': ['GBP', 'USD', 'EUR'],
  '.AS': ['EUR'],
  '.DE': ['EUR'],
  '.PA': ['EUR'],
  '.MI': ['EUR'],
  '.MC': ['EUR'],
  '.SW': ['CHF', 'USD', 'EUR'],
  '.BR': ['EUR'],
  '.LS': ['EUR'],
  '.VI': ['EUR'],
  '.HE': ['EUR'],
  '.ST': ['SEK'],
  '.CO': ['DKK'],
  '.OL': ['NOK'],
  '.IR': ['EUR'],
  '.TO': ['CAD'],
  '.AX': ['AUD'],
};

/** Keyword (lower-case, matched in the exchange name) -> suffix. Order matters: first match wins. */
const EXCHANGE_KEYWORDS: readonly (readonly [RegExp, string])[] = [
  [/\b(nyse|nasdaq|new york|cboe|arca|amex)\b/, ''],
  [/\b(london|lse)\b/, '.L'],
  [/\b(xetra|deutsche|frankfurt)\b/, '.DE'],
  [/\bamsterdam\b/, '.AS'],
  [/\bparis\b/, '.PA'],
  [/\b(milan|borsa italiana)\b/, '.MI'],
  [/\b(madrid|bolsa)\b/, '.MC'],
  [/\b(swiss|six)\b/, '.SW'],
  [/\bbrussels\b/, '.BR'],
  [/\blisbon\b/, '.LS'],
  [/\bvienna\b/, '.VI'],
  [/\bhelsinki\b/, '.HE'],
  [/\bstockholm\b/, '.ST'],
  [/\bcopenhagen\b/, '.CO'],
  [/\boslo\b/, '.OL'],
  [/\bdublin\b/, '.IR'],
  [/\btoronto\b/, '.TO'],
  [/\b(sydney|asx)\b/, '.AX'],
];

/** Yahoo suffix for an exchange name from the Trading 212 metadata, or undefined when not recognised. */
export function exchangeSuffix(exchangeName: string): string | undefined {
  const name = exchangeName.toLowerCase();
  return EXCHANGE_KEYWORDS.find(([re]) => re.test(name))?.[1];
}

export interface T212InstrumentRef {
  /** `AAPL_US_EQ`, `VUSAl_EQ`, `SAP_EQ`, or the bare `AAPL` of the CSV export. */
  ticker: string;
  isin?: string;
  /** Instrument currency as quoted by Trading 212 (may be minor units such as GBX). */
  currency: string;
  /** Exchange name resolved from the instruments metadata, when available. */
  exchange?: string;
}

export type SymbolMappingVia = 'override' | 'ticker' | 'exchange' | 'isin';
export const UNMAPPED_REASONS = ['NO_PATTERN', 'AMBIGUOUS_LISTING', 'CURRENCY_MISMATCH', 'INVALID_SYMBOL'] as const;
export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];

export type SymbolMapping =
  | { ok: true; symbol: string; via: SymbolMappingVia }
  | { ok: false; reason: UnmappedReason };

const SYMBOL_RE = /^[A-Z0-9.\-:^=]{1,20}$/;
const COUNTRY_TICKER = /^([A-Z0-9./-]+)_([A-Z]{2})_EQ$/;
const LETTER_TICKER = /^([A-Z0-9./-]+)([a-z])_EQ$/;
const BARE_TICKER = /^([A-Z0-9./-]+?)(?:_EQ)?$/;

/** Share classes: Trading 212 writes `BRK/A` / `BF.B`, Yahoo writes `BRK-A` / `BF-B`. */
const baseSymbol = (base: string) => base.replaceAll(/[./]/g, '-');

interface Listing {
  suffix: string;
  via: SymbolMappingVia;
}
type ListingResult = { base: string; listing: Listing } | { base: string; listing?: undefined; reason: UnmappedReason };

function knownListing(base: string, suffix: string | undefined, ref: T212InstrumentRef): ListingResult {
  if (suffix !== undefined) return { base, listing: { suffix, via: 'ticker' } };
  // Unknown country/venue letter: only the exchange metadata can say where it trades.
  const fromExchange = ref.exchange ? exchangeSuffix(ref.exchange) : undefined;
  return fromExchange === undefined ? { base, reason: 'NO_PATTERN' } : { base, listing: { suffix: fromExchange, via: 'exchange' } };
}

function listingFromTicker(ref: T212InstrumentRef): ListingResult | undefined {
  const byCountry = COUNTRY_TICKER.exec(ref.ticker);
  if (byCountry) return knownListing(byCountry[1]!, COUNTRY_SUFFIX[byCountry[2]!], ref);
  const byLetter = LETTER_TICKER.exec(ref.ticker);
  if (byLetter) return knownListing(byLetter[1]!, VENUE_LETTER_SUFFIX[byLetter[2]!], ref);
  return undefined;
}

function listingForBare(base: string, ref: T212InstrumentRef): ListingResult {
  const fromExchange = ref.exchange ? exchangeSuffix(ref.exchange) : undefined;
  if (fromExchange !== undefined) return { base, listing: { suffix: fromExchange, via: 'exchange' } };
  const country = ref.isin?.slice(0, 2).toUpperCase() ?? '';
  const fromIsin = ISIN_COUNTRY_EXCLUDED.has(country) ? undefined : COUNTRY_SUFFIX[country];
  if (fromIsin !== undefined) return { base, listing: { suffix: fromIsin, via: 'isin' } };
  return { base, reason: 'AMBIGUOUS_LISTING' };
}

/** `overrides` maps a T212 ticker or an ISIN to a canonical symbol. */
export function mapT212Symbol(ref: T212InstrumentRef, overrides: Readonly<Record<string, string>> = {}): SymbolMapping {
  const override = overrides[ref.ticker] ?? (ref.isin ? overrides[ref.isin] : undefined);
  if (override !== undefined) {
    const symbol = override.trim().toUpperCase();
    return SYMBOL_RE.test(symbol) ? { ok: true, symbol, via: 'override' } : { ok: false, reason: 'INVALID_SYMBOL' };
  }

  let resolved = listingFromTicker(ref);
  if (!resolved) {
    const bare = BARE_TICKER.exec(ref.ticker);
    if (!bare) return { ok: false, reason: 'NO_PATTERN' };
    resolved = listingForBare(bare[1]!, ref);
  }
  if (!resolved.listing) return { ok: false, reason: resolved.reason };

  const listed = `${baseSymbol(resolved.base)}${resolved.listing.suffix}`;
  const symbol = RENAMED_SYMBOLS[listed] ?? listed;
  if (!SYMBOL_RE.test(symbol)) return { ok: false, reason: 'INVALID_SYMBOL' };
  const allowed = VENUE_CURRENCIES[resolved.listing.suffix];
  if (allowed && !allowed.includes(normalizeCurrency(ref.currency).currency)) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  return { ok: true, symbol, via: resolved.listing.via };
}
