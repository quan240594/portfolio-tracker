import { describe, expect, it } from 'vitest';
import { isMinorUnitCurrency, majorCurrencyCode, majorDividend, majorEod, majorQuote, minorUnit } from './minor-units.js';
import type { Quote } from './types.js';

describe('minor-unit currencies', () => {
  it.each([
    ['GBX', 'GBP'],
    ['GBp', 'GBP'],
    ['ZAc', 'ZAR'],
    ['ILA', 'ILS'],
  ])('%s is %s in hundredths', (code, major) => {
    expect(minorUnit(code)).toEqual({ currency: major, divisor: 100 });
    expect(isMinorUnitCurrency(code)).toBe(true);
    expect(majorCurrencyCode(code)).toBe(major);
  });

  it.each(['GBP', 'EUR', 'USD', 'ZAR', 'ILS', '', 'gbp'])('%s is no minor unit', (code) => {
    expect(minorUnit(code)).toBeNull();
    expect(isMinorUnitCurrency(code)).toBe(false);
    expect(majorCurrencyCode(code)).toBe(code);
  });

  it('is no minor unit when the label is missing or not text (a corrupt stored row)', () => {
    expect(minorUnit(undefined)).toBeNull();
    expect(minorUnit(7)).toBeNull();
  });

  it('rescales an EOD row and relabels it', () => {
    expect(majorEod({ symbol: 'VOD.L', date: '2026-10-09', close: 7250, currency: 'GBX' })).toEqual({ symbol: 'VOD.L', date: '2026-10-09', close: 72.5, currency: 'GBP' });
  });

  it('is idempotent: a row in a major currency is returned as it is, so a GBP row is never divided', () => {
    const eod = { symbol: 'VOD.L', date: '2026-10-09', close: 7250, currency: 'GBP' };
    expect(majorEod(eod)).toBe(eod);
    expect(majorEod(majorEod({ ...eod, currency: 'GBp' }))).toEqual({ ...eod, close: 72.5 });
  });

  it('rescales both prices of a quote and the amount of a dividend', () => {
    const quote: Quote = { symbol: 'VOD.L', price: 7260, previousClose: 7250, currency: 'GBp', asOf: 't', source: 's' };
    expect(majorQuote(quote)).toEqual({ ...quote, price: 72.6, previousClose: 72.5, currency: 'GBP' });
    const usd = { ...quote, currency: 'USD' };
    expect(majorQuote(usd)).toBe(usd);
    const dividend = { symbol: 'VOD.L', exDate: '2026-08-01', amount: 4.5, currency: 'GBX' };
    expect(majorDividend(dividend)).toEqual({ ...dividend, amount: 0.045, currency: 'GBP' });
    const euro = { ...dividend, currency: 'EUR' };
    expect(majorDividend(euro)).toBe(euro);
  });
});
