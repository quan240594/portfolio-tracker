import { describe, expect, it } from 'vitest';
import { buildValueHistory, buildValueSeries, calculatePortfolio } from './portfolio.js';
import type { EodPrice, FxRates, Quote, Transaction } from './types.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-10-23T00:00:00Z' };
let seq = 0;
const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'u',
  portfolioId: 'p',
  date: '2026-10-01',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 10,
  price: 10,
  fee: 0,
  currency: 'EUR',
  createdAt: `2026-10-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...over,
});
const close = (symbol: string, date: string, value: number, currency = 'EUR'): EodPrice => ({ symbol, date, close: value, currency });
const quote = (symbol: string, price: number, asOf: string, currency = 'EUR'): Quote => ({ symbol, price, previousClose: price, currency, asOf, source: 't212' });

const TRANSACTIONS = [tx({ symbol: 'AAA', quantity: 10, price: 10 }), tx({ symbol: 'BBB', quantity: 4, price: 50, currency: 'USD' }), tx({ symbol: 'CCC', quantity: 2, price: 100 })];

describe('buildValueSeries: the last day uses the stored quote of the headline', () => {
  const eod = { AAA: [close('AAA', '2026-10-01', 11), close('AAA', '2026-10-20', 12)], BBB: [close('BBB', '2026-10-22', 60, 'USD')] };
  const quotes = { AAA: quote('AAA', 13, '2026-10-23T08:00:00Z'), BBB: quote('BBB', 70, '2026-10-23T08:00:00Z', 'USD'), CCC: quote('CCC', 120, '2026-10-23T08:00:00Z') };

  it('ends at the same value as the headline total, including a symbol without any stored close', () => {
    const { points } = buildValueSeries({ transactions: TRANSACTIONS, eod, fx, from: '2026-10-01', to: '2026-10-23', quotes });
    const { summary } = calculatePortfolio({ transactions: TRANSACTIONS, quotes, profiles: {}, fx, now: new Date('2026-10-23T09:00:00Z') });
    expect(points.at(-1)!.value).toBeCloseTo(summary.totalValue, 1);
    expect(summary.totalValue).toBeCloseTo(10 * 13 + (4 * 70) / 1.25 + 2 * 120, 1);
    expect(points.at(-1)!.invested).toBeCloseTo(summary.totalCost, 1);
  });

  it('leaves the days before the last one unchanged', () => {
    const withQuotes = buildValueSeries({ transactions: TRANSACTIONS, eod, fx, from: '2026-10-01', to: '2026-10-23', quotes }).points;
    const without = buildValueHistory(TRANSACTIONS, eod, fx, '2026-10-01', '2026-10-23');
    expect(withQuotes.slice(0, -1)).toEqual(without.slice(0, -1));
    expect(withQuotes.at(-1)!.value).not.toBe(without.at(-1)!.value);
  });

  it('values at the last close when there is no quote, like before', () => {
    const { points } = buildValueSeries({ transactions: TRANSACTIONS, eod, fx, from: '2026-10-22', to: '2026-10-23' });
    expect(points.at(-1)!.value).toBeCloseTo(10 * 12 + (4 * 60) / 1.25 + 2 * 100, 1);
  });

  it('keeps a close that is newer than the quote', () => {
    const newer = { AAA: [close('AAA', '2026-10-23', 14)] };
    const { points } = buildValueSeries({ transactions: [TRANSACTIONS[0]!], eod: newer, fx, from: '2026-10-22', to: '2026-10-23', quotes: { AAA: quote('AAA', 13, '2026-10-22T20:00:00Z') } });
    expect(points.at(-1)!.value).toBe(140);
  });

  it('ignores a quote for a symbol that is no longer held on the last day', () => {
    const sold = [tx({ symbol: 'AAA', quantity: 10, price: 10 }), tx({ symbol: 'AAA', type: 'SELL', quantity: 10, price: 12, date: '2026-10-10' })];
    const { points } = buildValueSeries({ transactions: sold, eod, fx, from: '2026-10-01', to: '2026-10-23', quotes });
    expect(points.at(-1)!.value).toBe(0);
  });

  it('applies the split ratio only to the days before the split, the quote already being on today\'s basis', () => {
    const split = [tx({ symbol: 'AAA', quantity: 10, price: 10 }), tx({ symbol: 'AAA', type: 'SPLIT', quantity: 2, price: 0, date: '2026-10-15' })];
    const { points } = buildValueSeries({ transactions: split, eod: { AAA: [close('AAA', '2026-10-10', 6)] }, fx, from: '2026-10-10', to: '2026-10-23', quotes: { AAA: quote('AAA', 7, '2026-10-23T08:00:00Z') } });
    expect(points[0]!.value).toBe(120);
    expect(points.at(-1)!.value).toBe(140);
  });
});

describe('buildValueSeries: the days valued at cost', () => {
  it('reports each symbol without a close with its first and last day at cost, and how many are held', () => {
    const eod = { AAA: [close('AAA', '2026-10-01', 11)], CCC: [close('CCC', '2026-10-05', 100)] };
    const series = buildValueSeries({ transactions: TRANSACTIONS, eod, fx, from: '2026-10-01', to: '2026-10-07' });
    expect(series.held).toBe(3);
    expect(series.costValued).toEqual([
      { symbol: 'BBB', from: '2026-10-01', to: '2026-10-07' },
      { symbol: 'CCC', from: '2026-10-01', to: '2026-10-04' },
    ]);
  });

  it('a live quote ends the cost valuation on the last day', () => {
    const series = buildValueSeries({ transactions: TRANSACTIONS, eod: {}, fx, from: '2026-10-01', to: '2026-10-03', quotes: { BBB: quote('BBB', 55, '2026-10-03T08:00:00Z', 'USD') } });
    expect(series.costValued.find((span) => span.symbol === 'BBB')?.to).toBe('2026-10-02');
    expect(series.costValued.find((span) => span.symbol === 'AAA')?.to).toBe('2026-10-03');
  });

  it('is empty, with nothing held, for no transactions or an inverted range', () => {
    expect(buildValueSeries({ transactions: [], eod: {}, fx, from: '2026-10-01', to: '2026-10-03' })).toEqual({ points: [], costValued: [], held: 0 });
    expect(buildValueSeries({ transactions: TRANSACTIONS, eod: {}, fx, from: '2026-10-05', to: '2026-10-03' }).points).toEqual([]);
  });

  it('seeds the carry-forward from a close before the range and does not count the symbol as at cost', () => {
    const series = buildValueSeries({ transactions: [TRANSACTIONS[0]!], eod: { AAA: [close('AAA', '2026-09-28', 9)] }, fx, from: '2026-10-02', to: '2026-10-03' });
    expect(series.costValued).toEqual([]);
    expect(series.points[0]!.value).toBe(90);
  });
});
