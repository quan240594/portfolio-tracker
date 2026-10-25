import { describe, expect, it } from 'vitest';
import { buildValuationReport, reportDates, valuationQuerySchema, valuationReportSchema, type ValuationReportInput } from './valuation-report.js';
import type { EodPrice, Quote, Transaction } from './types.js';

const TODAY = '2026-06-15';
const txn = (over: Partial<Transaction>): Transaction => ({
  id: 't1',
  userId: 'u',
  portfolioId: 'p',
  date: '2026-01-05',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 10,
  price: 10,
  fee: 0,
  currency: 'EUR',
  createdAt: '2026-01-05T10:00:00Z',
  ...over,
});
const quote = (symbol: string, price: number, currency = 'EUR'): Quote => ({ symbol, price, previousClose: price, currency, asOf: `${TODAY}T08:00:00Z`, source: 't212' });
const rows = (symbol: string, from: number, to: number, close: number, currency = 'EUR'): EodPrice[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ symbol, date: `2026-06-${String(from + i).padStart(2, '0')}`, close, currency }));

function input(over: Partial<ValuationReportInput> = {}): ValuationReportInput {
  const eod = { AAA: rows('AAA', 1, 15, 11), BBB: rows('BBB', 1, 10, 20, 'USD') };
  return {
    transactions: [txn({}), txn({ id: 't2', symbol: 'BBB', currency: 'USD', quantity: 5, price: 18 }), txn({ id: 't3', symbol: 'CCC', quantity: 2, price: 100 })],
    eod,
    storedEod: eod,
    fx: { base: 'EUR', rates: { USD: 1.25 }, asOf: `${TODAY}T00:00:00Z` },
    fxHistory: [{ base: 'EUR', date: '2026-03-02', rates: { USD: 1.1 } }],
    quotes: { AAA: quote('AAA', 12), BBB: quote('BBB', 21, 'USD') },
    today: TODAY,
    dates: ['2026-06-10', TODAY],
    headline: 1234.56,
    symbolsTotal: 3,
    rowsRead: 42,
    ...over,
  };
}

describe('reportDates', () => {
  it('defaults to today, yesterday and about six months back, oldest first', () => {
    expect(reportDates(undefined, TODAY)).toEqual(['2025-12-15', '2026-06-14', TODAY]);
  });
  it('drops future days and duplicates and keeps at most three', () => {
    expect(reportDates(['2026-06-16', TODAY, TODAY, '2026-06-01'], TODAY)).toEqual(['2026-06-01', TODAY]);
    expect(reportDates(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'], TODAY)).toHaveLength(3);
  });
});

describe('valuationQuerySchema', () => {
  it('accepts up to three days, in any order, and none', () => {
    expect(valuationQuerySchema.parse({}).dates).toBeUndefined();
    expect(valuationQuerySchema.parse({ dates: ' ' }).dates).toBeUndefined();
    expect(valuationQuerySchema.parse({ dates: '2026-01-02, 2026-01-01,2026-01-02' }).dates).toEqual(['2026-01-02', '2026-01-01']);
  });
  it('refuses a malformed day and more than three days', () => {
    expect(valuationQuerySchema.safeParse({ dates: 'today' }).success).toBe(false);
    expect(valuationQuerySchema.safeParse({ dates: '2026-01-01,2026-01-02,2026-01-03,2026-01-04' }).success).toBe(false);
  });
});

describe('buildValuationReport', () => {
  it('adds the lines up to the chart point, and compares with the live value', () => {
    const report = buildValuationReport(input());
    expect(valuationReportSchema.parse(report)).toEqual(report);
    const [past, today] = report.days;
    expect(past!.date).toBe('2026-06-10');
    expect(past!.chartValue).toBeCloseTo(past!.positionsValue + past!.extraValue, 2);
    expect(past!.extraValue).toBe(0);
    const ccc = past!.lines.find((l) => l.symbol === 'CCC')!;
    expect(ccc).toMatchObject({ source: 'cost', value: 200, flags: ['cost'] });
    expect(past!.lines.map((l) => l.symbol)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(past!.lines.find((l) => l.symbol === 'BBB')).toMatchObject({ source: 'close', fxFallback: 'after', fxDate: '2026-03-02', today: expect.any(Number) });
    expect(today!.lines.every((l) => l.today === l.value)).toBe(true);
    expect(report.headline).toBe(1234.56);
    expect(report).toMatchObject({ symbolsTotal: 3, truncated: false, rowsRead: 42, baseCurrency: 'EUR' });
  });

  it('shows the cost fallback against the live price, and the stored close against the one the chart used', () => {
    const eod = { AAA: rows('AAA', 1, 15, 0.11) };
    const report = buildValuationReport(input({ eod: { AAA: rows('AAA', 1, 15, 11) }, storedEod: eod, quotes: { AAA: quote('AAA', 12), CCC: quote('CCC', 150) } }));
    const aaa = report.days[0]!.lines.find((l) => l.symbol === 'AAA')!;
    expect(aaa).toMatchObject({ value: 110, fair: 1.1, flags: ['scale'] });
    const ccc = report.days[0]!.lines.find((l) => l.symbol === 'CCC')!;
    expect(ccc).toMatchObject({ value: 200, fair: 300, gap: -100 });
    expect(report.days[0]!.lines.map((l) => l.symbol)).toEqual(['AAA', 'CCC', 'BBB']);
    expect(report.days[0]!.gap).toBeCloseTo(report.days[0]!.positionsValue - report.days[0]!.fairValue, 2);
  });

  it('marks stale carried closes, a close in another currency and a rate that is not that day’s', () => {
    const report = buildValuationReport(input({ dates: ['2026-06-15'], quotes: {}, eod: { AAA: rows('AAA', 1, 3, 11, 'USD'), BBB: [] }, storedEod: { AAA: rows('AAA', 1, 3, 11, 'USD') } }));
    const aaa = report.days[0]!.lines.find((l) => l.symbol === 'AAA')!;
    expect(aaa).toMatchObject({ source: 'carried', ageDays: 12, flags: ['carried', 'stale', 'currency', 'fx'] });
    expect(report.fx.find((r) => r.currency === 'USD')).toMatchObject({ fixings: 1, first: '2026-03-02', last: '2026-03-02' });
    expect(report.fx.find((r) => r.currency === 'USD')!.fallbackDays).toBeGreaterThan(0);
  });

  it('has no days without transactions or when no requested day is in range, and flags a truncated symbol list', () => {
    expect(buildValuationReport(input({ transactions: [] })).days).toEqual([]);
    expect(buildValuationReport(input({ dates: ['2026-06-20'] })).days).toEqual([]);
    expect(buildValuationReport(input({ symbolsTotal: 61 })).truncated).toBe(true);
  });

  it('counts cash and custom assets as extra value', () => {
    const report = buildValuationReport(input({ dates: [TODAY], extra: () => ({ value: 500, invested: 500 }) }));
    expect(report.days[0]).toMatchObject({ extraValue: 500 });
    expect(report.days[0]!.chartValue).toBeCloseTo(report.days[0]!.positionsValue + 500, 2);
  });
});
