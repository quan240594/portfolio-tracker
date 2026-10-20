import { describe, expect, it } from 'vitest';
import { YEAR_AGO_TOLERANCE_DAYS, dividendComparison, percentChange, yearBefore, type PerSharePayment } from './dividend-comparison.js';

const pay = (date: string, perShare: number, currency = 'USD'): PerSharePayment => ({ date, perShare, currency });

const QUARTERLY: PerSharePayment[] = [pay('2025-08-07', 1.2), pay('2025-11-06', 1.21), pay('2026-02-05', 1.22), pay('2026-05-07', 1.25)];

describe('percentChange', () => {
  it('rounds to one decimal and never returns -0', () => {
    expect(percentChange(1.28, 1.25)).toBe(2.4);
    expect(percentChange(1.25, 1.28)).toBe(-2.3);
    expect(percentChange(1.25, 1.25)).toBe(0);
    expect(Object.is(percentChange(1.2501, 1.25), 0)).toBe(true);
    expect(percentChange(1.2499, 1.25)).toBe(0);
  });

  it.each([[1, 0], [1, -1], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]])('is undefined for %s against %s', (value, reference) => {
    expect(percentChange(value, reference)).toBeUndefined();
  });
});

describe('yearBefore', () => {
  it('keeps month and day, and clamps 29 February', () => {
    expect(yearBefore('2026-11-06')).toBe('2025-11-06');
    expect(yearBefore('2028-02-29')).toBe('2027-02-28');
    expect(yearBefore('2026-01-01')).toBe('2025-01-01');
  });
});

describe('dividendComparison', () => {
  it('quarterly payer: against the last quarter and against a year ago', () => {
    const result = dividendComparison(QUARTERLY, pay('2026-08-06', 1.28));
    expect(result.vsPrevious).toEqual({ pct: 2.4, previousPerShare: 1.25, previousDate: '2026-05-07' });
    expect(result.vsYearAgo).toEqual({ pct: 6.7, yearAgoPerShare: 1.2, yearAgoDate: '2025-08-07' });
  });

  it('ignores the event itself and anything later when the history contains it', () => {
    const history = [...QUARTERLY, pay('2026-08-06', 1.28), pay('2026-11-05', 9)];
    expect(dividendComparison(history, pay('2026-08-06', 1.28))).toEqual(dividendComparison(QUARTERLY, pay('2026-08-06', 1.28)));
  });

  it('is independent of the order of the history', () => {
    expect(dividendComparison([...QUARTERLY].reverse(), pay('2026-08-06', 1.28))).toEqual(dividendComparison(QUARTERLY, pay('2026-08-06', 1.28)));
  });

  it('monthly payer: previous is last month, year ago is the same month last year', () => {
    const monthly = Array.from({ length: 14 }, (_, i) => pay(`${2025 + Math.floor((i + 5) / 12)}-${String(((i + 5) % 12) + 1).padStart(2, '0')}-15`, 0.1 + i * 0.001));
    const event = pay('2026-07-15', 0.12);
    const result = dividendComparison(monthly, event);
    expect(result.vsPrevious?.previousDate).toBe('2026-06-15');
    expect(result.vsYearAgo?.yearAgoDate).toBe('2025-07-15');
  });

  it('semi-annual payer', () => {
    const result = dividendComparison([pay('2025-03-10', 0.5), pay('2025-09-10', 0.55)], pay('2026-03-10', 0.6));
    expect(result.vsPrevious).toMatchObject({ previousDate: '2025-09-10', pct: 9.1 });
    expect(result.vsYearAgo).toMatchObject({ yearAgoDate: '2025-03-10', pct: 20 });
  });

  it('annual payer: both comparisons point at the same payment', () => {
    const result = dividendComparison([pay('2024-05-01', 2), pay('2025-05-02', 2.2)], pay('2026-05-01', 2.4));
    expect(result.vsPrevious).toMatchObject({ previousDate: '2025-05-02', pct: 9.1 });
    expect(result.vsYearAgo).toMatchObject({ yearAgoDate: '2025-05-02', pct: 9.1 });
  });

  it('irregular payer: previous is whatever came last, year ago needs a payment within +-45 days', () => {
    const history = [pay('2025-01-20', 1), pay('2026-02-10', 1.1)];
    const result = dividendComparison(history, pay('2026-05-20', 1.2));
    expect(result.vsPrevious).toMatchObject({ previousDate: '2026-02-10' });
    expect(result.vsYearAgo).toBeUndefined();
  });

  it('the year-ago window is +-45 days around the same day last year, boundaries inclusive', () => {
    const event = pay('2026-06-15', 1.1);
    expect(YEAR_AGO_TOLERANCE_DAYS).toBe(45);
    expect(dividendComparison([pay('2025-05-01', 1)], event).vsYearAgo).toMatchObject({ yearAgoDate: '2025-05-01' });
    expect(dividendComparison([pay('2025-07-30', 1)], event).vsYearAgo).toMatchObject({ yearAgoDate: '2025-07-30' });
    expect(dividendComparison([pay('2025-04-30', 1)], event).vsYearAgo).toBeUndefined();
    expect(dividendComparison([pay('2025-07-31', 1)], event).vsYearAgo).toBeUndefined();
  });

  it('picks the closest payment to a year ago, the earlier one on a tie', () => {
    const event = pay('2026-06-15', 1.1);
    expect(dividendComparison([pay('2025-06-01', 1), pay('2025-06-12', 1.05), pay('2025-07-20', 1)], event).vsYearAgo?.yearAgoDate).toBe('2025-06-12');
    expect(dividendComparison([pay('2025-06-20', 1), pay('2025-06-10', 1)], event).vsYearAgo?.yearAgoDate).toBe('2025-06-10');
    expect(dividendComparison([pay('2025-06-10', 1), pay('2025-06-20', 1)], event).vsYearAgo?.yearAgoDate).toBe('2025-06-10');
  });

  it('first payment: nothing to compare with', () => {
    expect(dividendComparison([], pay('2026-08-06', 1.28))).toEqual({});
    expect(dividendComparison([pay('2026-08-06', 1.28)], pay('2026-08-06', 1.28))).toEqual({});
  });

  it('a zero or missing reference omits that comparison (no division by zero)', () => {
    expect(dividendComparison([pay('2025-08-07', 0), pay('2026-05-07', 0)], pay('2026-08-06', 1.28))).toEqual({});
    expect(dividendComparison([pay('2025-08-07', 1.2), pay('2026-05-07', 0)], pay('2026-08-06', 1.28))).toEqual({
      vsYearAgo: { pct: 6.7, yearAgoPerShare: 1.2, yearAgoDate: '2025-08-07' },
    });
  });

  it('a zero or invalid event amount compares with nothing', () => {
    expect(dividendComparison(QUARTERLY, pay('2026-08-06', 0))).toEqual({});
    expect(dividendComparison(QUARTERLY, pay('2026-08-06', Number.NaN))).toEqual({});
  });

  it('omits a reference in another currency instead of guessing a rate', () => {
    const mixed = [pay('2025-08-07', 1.2, 'EUR'), pay('2026-05-07', 1.25, 'EUR')];
    expect(dividendComparison(mixed, pay('2026-08-06', 1.28, 'USD'))).toEqual({});
    const partly = [pay('2025-08-07', 1.2, 'USD'), pay('2026-05-07', 1.25, 'EUR')];
    expect(dividendComparison(partly, pay('2026-08-06', 1.28, 'USD'))).toEqual({ vsYearAgo: { pct: 6.7, yearAgoPerShare: 1.2, yearAgoDate: '2025-08-07' } });
  });

  it('does not special-case a special dividend: a big drop afterwards is a big drop', () => {
    const result = dividendComparison([pay('2026-02-05', 1), pay('2026-05-07', 5)], pay('2026-08-06', 1));
    expect(result.vsPrevious?.pct).toBe(-80);
  });

  it('reports a cut with a negative percentage', () => {
    expect(dividendComparison(QUARTERLY, pay('2026-08-06', 1.0)).vsPrevious?.pct).toBe(-20);
  });
});
