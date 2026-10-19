import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { definedOnly, ownValue } from './parse.js';

/** Prices quoted in minor units (pence) become the major currency, so FX lookups work. */
const MINOR_UNIT_CURRENCIES: Readonly<Record<string, string>> = { GBX: 'GBP', GBp: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };

/** Upper-cases ISO codes but keeps minor-unit codes (e.g. "GBp") so the models can rescale them. */
export function normalizeCurrency(code: unknown, fallback: string): string {
  if (typeof code !== 'string' || code === '') return fallback;
  return ownValue(MINOR_UNIT_CURRENCIES, code) === undefined ? code.toUpperCase() : code;
}

const rescale = (currency: string, ...values: number[]): { currency: string; values: number[] } => {
  const major = ownValue(MINOR_UNIT_CURRENCIES, currency);
  return major === undefined ? { currency, values } : { currency: major, values: values.map((value) => value / 100) };
};

export function makeQuote(quote: Quote): Quote {
  const { currency, values } = rescale(quote.currency, quote.price, quote.previousClose);
  return { ...quote, price: values[0]!, previousClose: values[1]!, currency };
}

export function makeEod(eod: EodPrice): EodPrice {
  const { currency, values } = rescale(eod.currency, eod.close);
  return { ...eod, close: values[0]!, currency };
}

export function makeDividend(dividend: DividendEvent): DividendEvent {
  const { currency, values } = rescale(dividend.currency, dividend.amount);
  return definedOnly({ ...dividend, amount: values[0]!, currency });
}

export const makeProfile = (profile: InstrumentProfile): InstrumentProfile => definedOnly(profile);

/** The optional company details of a profile (the fields a lazy refresh may overwrite). */
export const PROFILE_DETAIL_FIELDS = ['description', 'isin', 'marketCap', 'eps', 'beta', 'peRatio'] as const;

export function profileDetails(profile: InstrumentProfile | null): Partial<InstrumentProfile> {
  const out: Record<string, unknown> = {};
  if (profile === null) return out;
  for (const field of PROFILE_DETAIL_FIELDS) if (profile[field] !== undefined) out[field] = profile[field];
  return out;
}

/** An ISO-8601 UTC timestamp with milliseconds and `Z`, as `Date#toISOString` writes it. */
export const isoDateTime = (date: Date): string => date.toISOString();
