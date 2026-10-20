import type { Quote } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { mergeQuote, resolvePrice, type QuoteCandidate } from './quote-price.js';
import { position } from './testing/fixtures.js';

const RATES = { USD: 1.1, GBP: 0.87, CHF: 0.95 };

describe('resolvePrice', () => {
  it('uses the price and the currency of the instrument', () => {
    expect(resolvePrice(position({ currentPrice: 211.37 }), RATES)).toEqual({ price: 211.37, currency: 'USD' });
  });

  it('returns nothing when Trading 212 reported no usable price', () => {
    expect(resolvePrice(position({ noPrice: true }), RATES)).toBeUndefined();
    expect(resolvePrice(position({ currentPrice: 0 }), RATES)).toBeUndefined();
    expect(resolvePrice(position({ currentPrice: Number.NaN }), RATES)).toBeUndefined();
    expect(resolvePrice(position({ currentPrice: -3 }), RATES)).toBeUndefined();
  });

  it('turns pence (GBX, also written GBp) into pounds, like the rest of the app', () => {
    const london = { ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currentPrice: 9650 };
    expect(resolvePrice(position({ ...london, currency: 'GBX' }), RATES)).toEqual({ price: 96.5, currency: 'GBP' });
    expect(resolvePrice(position({ ...london, currency: 'GBp' }), RATES)).toEqual({ price: 96.5, currency: 'GBP' });
  });

  it('divides a price in pence that is labelled GBP when the value of the position proves it', () => {
    // 10 shares at 96.50 GBP = 965 GBP = 1109.2 EUR; the reported "9650 GBP" is 100 times too high.
    const mislabelled = position({ ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBP', quantity: 10, currentPrice: 9650, currentValue: 1109.2 });
    expect(resolvePrice(mislabelled, RATES)).toEqual({ price: 96.5, currency: 'GBP' });
  });

  it('leaves a GBP price in pounds alone, with or without the value of the position', () => {
    const pounds = position({ ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBP', quantity: 10, currentPrice: 96.5, currentValue: 1109.2 });
    expect(resolvePrice(pounds, RATES)).toEqual({ price: 96.5, currency: 'GBP' });
    expect(resolvePrice({ ...pounds, walletImpact: undefined }, RATES)).toEqual({ price: 96.5, currency: 'GBP' });
  });

  it('multiplies back a GBX label on a price that is already in pounds', () => {
    const pounds = position({ ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBX', quantity: 10, currentPrice: 96.5, currentValue: 1109.2 });
    expect(resolvePrice(pounds, RATES)).toEqual({ price: 96.5, currency: 'GBP' });
  });

  it('works with an account in another currency, including GBP', () => {
    const usd = position({ currency: 'GBP', quantity: 10, currentPrice: 9650, currentValue: 1165, walletCurrency: 'USD' });
    expect(resolvePrice(usd, RATES)?.price).toBe(96.5);
    const gbp = position({ currency: 'GBP', quantity: 10, currentPrice: 9650, currentValue: 965, walletCurrency: 'GBP' });
    expect(resolvePrice(gbp, RATES)?.price).toBe(96.5);
  });

  it('trusts the label when the value or the rates needed to check it are missing', () => {
    const base = { currency: 'GBP', quantity: 10, currentPrice: 9650 };
    expect(resolvePrice(position({ ...base, currentValue: 1109.2 }), { USD: 1.1 })).toMatchObject({ price: 9650 });
    expect(resolvePrice(position({ ...base, currentValue: 1109.2, walletCurrency: 'XYZ' }), RATES)).toMatchObject({ price: 9650 });
    expect(resolvePrice(position({ ...base, currentValue: 0 }), RATES)).toMatchObject({ price: 9650 });
    expect(resolvePrice(position({ ...base, quantity: 0, currentValue: 1109.2 }), RATES)).toMatchObject({ price: 9650 });
    expect(resolvePrice({ ...position({ ...base, currentValue: 1109.2 }), walletImpact: { currentValue: 1109.2 } }, RATES)).toMatchObject({ price: 9650 });
  });

  it('does not rescale prices that merely differ from the value of the position', () => {
    const drifted = position({ currency: 'GBP', quantity: 10, currentPrice: 100, currentValue: 1109.2 });
    expect(resolvePrice(drifted, RATES)).toEqual({ price: 100, currency: 'GBP' });
  });

  it('never rescales other currencies', () => {
    expect(resolvePrice(position({ currency: 'CHF', quantity: 10, currentPrice: 9650, currentValue: 1109.2 }), RATES)).toEqual({ price: 9650, currency: 'CHF' });
  });
});

describe('mergeQuote', () => {
  const NOW = '2026-10-20T10:15:00.000Z';
  const candidate: QuoteCandidate = { symbol: 'AAPL', price: 212, currency: 'USD', asOf: NOW };
  const stored = (over: Partial<Quote> = {}): Quote => ({ symbol: 'AAPL', price: 200, previousClose: 198, currency: 'USD', asOf: '2026-10-20T08:00:00.000Z', source: 'twelvedata', ...over });

  it('stores a quote with no previous close of its own as a day change of 0', () => {
    expect(mergeQuote(candidate, undefined)).toEqual({ symbol: 'AAPL', price: 212, previousClose: 212, currency: 'USD', asOf: NOW, source: 't212' });
  });

  it('keeps the stored previous close within the same day', () => {
    expect(mergeQuote(candidate, stored())).toMatchObject({ price: 212, previousClose: 198, source: 't212' });
  });

  it('takes the last stored price as the previous close on the first quote of a new day', () => {
    expect(mergeQuote(candidate, stored({ asOf: '2026-10-19T20:05:00.000Z', price: 205 }))).toMatchObject({ price: 212, previousClose: 205 });
    expect(mergeQuote(candidate, stored({ asOf: '2026-10-19' }))).toMatchObject({ previousClose: 200 });
  });

  it('does not compare prices of different currencies', () => {
    expect(mergeQuote(candidate, stored({ currency: 'EUR' }))).toMatchObject({ previousClose: 212 });
  });

  it('leaves a stored quote with the same or a newer time alone, whatever its source', () => {
    expect(mergeQuote(candidate, stored({ asOf: NOW }))).toBeUndefined();
    expect(mergeQuote(candidate, stored({ asOf: '2026-10-20T10:16:00.000Z', source: 'eodhd' }))).toBeUndefined();
    expect(mergeQuote(candidate, stored({ asOf: '2026-10-20T10:16:00.000Z', currency: 'EUR' }))).toBeUndefined();
  });

  it('replaces a provider quote that is older', () => {
    expect(mergeQuote(candidate, stored({ asOf: '2026-10-20T10:14:59.000Z' }))).toMatchObject({ source: 't212', price: 212 });
  });
});
