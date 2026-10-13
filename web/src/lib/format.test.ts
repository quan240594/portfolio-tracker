import {
  BASE_CURRENCY,
  LOCALE,
  formatDate,
  formatFxRate,
  formatMoney,
  formatMonth,
  formatPercent,
  formatQuantity,
  formatWeight,
  normalizeDecimalInput,
  trendOf,
} from './format';

/** Intl puts a no-break space between the currency symbol and the amount. */
const nb = (s: string) => s.replace(/ /g, '\u00a0');
const M = '\u2212';

describe('locale', () => {
  it('formats Dutch (nl-NL) with EUR as the base currency', () => {
    expect(LOCALE).toBe('nl-NL');
    expect(BASE_CURRENCY).toBe('EUR');
  });
});

describe('formatMoney', () => {
  it('formats EUR the Dutch way: € prefix, dot thousands, comma decimals', () => {
    expect(formatMoney(1234.56, 'EUR')).toBe(nb('€ 1.234,56'));
    expect(formatMoney(1234.5, 'EUR')).toBe(nb('€ 1.234,50'));
  });

  it('defaults to the base currency (EUR) when none or an empty one is given', () => {
    expect(formatMoney(5)).toBe(nb('€ 5,00'));
    expect(formatMoney(5, '')).toBe(nb('€ 5,00'));
  });

  it('formats other currencies from the API', () => {
    expect(formatMoney(99.999, 'USD')).toBe(nb('US$ 100,00'));
  });

  it('uses a typographic minus for negatives', () => {
    expect(formatMoney(-42.1, 'EUR')).toBe(nb(`€ ${M}42,10`));
  });

  it('adds an explicit + for positive values when signed', () => {
    expect(formatMoney(10, 'EUR', { signed: true })).toBe(nb('€ +10,00'));
    expect(formatMoney(-10, 'EUR', { signed: true })).toBe(nb(`€ ${M}10,00`));
  });

  it('never shows a signed zero', () => {
    expect(formatMoney(-0.001, 'EUR', { signed: true })).toBe(nb('€ 0,00'));
    expect(formatMoney(-0, 'EUR')).toBe(nb('€ 0,00'));
  });

  it('supports compact notation and extra precision', () => {
    expect(formatMoney(1_250_000, 'EUR', { compact: true })).toBe(nb('€ 1,3 mln.'));
    expect(formatMoney(7_500, 'EUR', { compact: true })).toBe(nb('€ 7,5K'));
    expect(formatMoney(0.12345678, 'EUR', { maxDigits: 6 })).toBe(nb('€ 0,123457'));
  });
});

describe('formatPercent', () => {
  it('formats API percentages (already ×100) with a decimal comma', () => {
    expect(formatPercent(12.345)).toBe('12,35%');
  });

  it('signs positive and negative values', () => {
    expect(formatPercent(12.34, { signed: true })).toBe('+12,34%');
    expect(formatPercent(-3.2, { signed: true })).toBe(`${M}3,20%`);
    expect(formatPercent(0, { signed: true })).toBe('0,00%');
  });

  it('formats 0..1 weights', () => {
    expect(formatWeight(0.1234)).toBe('12,3%');
  });
});

describe('misc formatters', () => {
  it('formats quantities, dates and months', () => {
    expect(formatQuantity(0.12345)).toBe('0,12345');
    expect(formatQuantity(1500)).toBe('1.500');
    expect(formatDate('2024-03-05')).toBe('5 mrt 2024');
    expect(formatDate('2026-10-13')).toBe('13 okt 2026');
    expect(formatMonth('2024-11')).toBe('nov 24');
  });

  it('formats FX rates with 2–6 decimals', () => {
    expect(formatFxRate(1.0842)).toBe('1,0842');
    expect(formatFxRate(1.5)).toBe('1,50');
    expect(formatFxRate(161.123456789)).toBe('161,123457');
  });

  it('derives a trend', () => {
    expect(trendOf(1)).toBe('up');
    expect(trendOf(-1)).toBe('down');
    expect(trendOf(0)).toBe('flat');
  });
});

describe('normalizeDecimalInput', () => {
  it.each([
    ['1,0842', '1.0842'],
    [' 0,25 ', '0.25'],
    ['1.234,56', '1234.56'],
    ['1 234,56', '1234.56'],
    ['1234.56', '1234.56'],
    ['1,234.56', '1234.56'],
    ['42', '42'],
    ['', ''],
    ['abc', 'abc'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeDecimalInput(raw)).toBe(expected);
  });
});

describe('formatter edge cases', () => {
  it('handles zero, negatives and tiny values', () => {
    expect(formatMoney(0, 'EUR', { signed: true })).toBe(nb('€ 0,00'));
    expect(formatMoney(0.004, 'EUR', { signed: true })).toBe(nb('€ 0,00'));
    expect(formatMoney(-1_250_000, 'EUR', { compact: true })).toBe(nb(`${M}€ 1,3 mln.`));
    expect(formatPercent(-0.001)).toBe('0,00%');
    expect(formatPercent(-12.5, { digits: 1 })).toBe(`${M}12,5%`);
    expect(formatWeight(0)).toBe('0,0%');
    expect(formatWeight(1, 0)).toBe('100%');
    expect(formatQuantity(-2.5)).toBe('-2,5');
    expect(formatQuantity(0)).toBe('0');
  });

  it('renders NaN without throwing', () => {
    expect(formatMoney(Number.NaN, 'EUR')).toBe(nb('€ NaN'));
    expect(formatMoney(Number.NaN, 'EUR', { signed: true })).toBe(nb('€ NaN'));
    expect(formatPercent(Number.NaN)).toBe('NaN%');
    expect(formatQuantity(Number.NaN)).toBe('NaN');
    expect(trendOf(Number.NaN)).toBe('flat');
  });

  it('treats values within ±0.000001 as flat', () => {
    expect(trendOf(0.0000005)).toBe('flat');
    expect(trendOf(-0.0000005)).toBe('flat');
    expect(trendOf(0.00001)).toBe('up');
  });

  it('caches money formatters per currency/options', () => {
    expect(formatMoney(1, 'GBP')).toBe(nb('£ 1,00'));
    expect(formatMoney(2, 'GBP')).toBe(nb('£ 2,00'));
    expect(formatMoney(1, 'JPY', { maxDigits: 0 })).toBe(nb('JP¥ 1'));
    expect(formatMoney(-1500, 'USD', { compact: true })).toBe(nb(`${M}US$ 1,5K`));
  });

  it('formats timestamps and custom date options', () => {
    expect(formatDate('2024-03-05T12:00:00Z', { year: 'numeric' })).toBe('2024');
    expect(formatDate('2024-12-31', { month: 'long' })).toBe('december');
  });
});
