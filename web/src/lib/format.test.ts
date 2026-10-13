import { formatDate, formatMoney, formatMonth, formatPercent, formatQuantity, formatWeight, trendOf } from './format';

describe('formatMoney', () => {
  it('formats EUR with two decimals and thousands separators', () => {
    expect(formatMoney(1234.5, 'EUR')).toBe('€1,234.50');
  });

  it('formats other currencies from the API', () => {
    expect(formatMoney(99.999, 'USD')).toBe('US$100.00');
  });

  it('uses a typographic minus for negatives', () => {
    expect(formatMoney(-42.1, 'EUR')).toBe('\u2212€42.10');
  });

  it('adds a + sign for positive values when signed', () => {
    expect(formatMoney(10, 'EUR', { signed: true })).toBe('+€10.00');
    expect(formatMoney(-10, 'EUR', { signed: true })).toBe('\u2212€10.00');
  });

  it('never shows a signed zero', () => {
    expect(formatMoney(-0.001, 'EUR', { signed: true })).toBe('€0.00');
    expect(formatMoney(-0, 'EUR')).toBe('€0.00');
  });

  it('supports compact notation and extra precision', () => {
    expect(formatMoney(1_250_000, 'EUR', { compact: true })).toBe('€1.3M');
    expect(formatMoney(0.12345678, 'EUR', { maxDigits: 6 })).toBe('€0.123457');
  });
});

describe('formatPercent', () => {
  it('formats API percentages (already ×100)', () => {
    expect(formatPercent(12.345)).toBe('12.35%');
  });

  it('signs positive and negative values', () => {
    expect(formatPercent(3.2, { signed: true })).toBe('+3.20%');
    expect(formatPercent(-3.2, { signed: true })).toBe('\u22123.20%');
    expect(formatPercent(0, { signed: true })).toBe('0.00%');
  });

  it('formats 0..1 weights', () => {
    expect(formatWeight(0.1234)).toBe('12.3%');
  });
});

describe('misc formatters', () => {
  it('formats quantities, dates and months', () => {
    expect(formatQuantity(0.12345)).toBe('0.12345');
    expect(formatQuantity(1500)).toBe('1,500');
    expect(formatDate('2024-03-05')).toBe('5 Mar 2024');
    expect(formatMonth('2024-11')).toBe('Nov 24');
  });

  it('derives a trend', () => {
    expect(trendOf(1)).toBe('up');
    expect(trendOf(-1)).toBe('down');
    expect(trendOf(0)).toBe('flat');
  });
});
