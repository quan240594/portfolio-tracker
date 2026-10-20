import {
  BASE_CURRENCY,
  LOCALE,
  formatCount,
  MONTH_NAMES_LONG,
  MONTH_NAMES_SHORT,
  formatDate,
  formatDateTime,
  formatDayMonthShort,
  formatDayOfMonth,
  formatFxRate,
  formatMoney,
  formatMonth,
  formatMonthShort,
  formatMonthYear,
  formatTime,
  formatWeekdayDate,
  formatWeekdayLong,
  formatWeekdayShort,
  formatWeekdayTime,
  formatPercent,
  formatQuantity,
  formatWeight,
  normalizeDecimalInput,
  trendOf,
} from './format';

/** Intl puts a no-break space between the currency symbol and the amount. */
const nb = (s: string) => s.replace(/ /g, '\u00a0');
const M = '\u2212';

describe('formatCount', () => {
  it('groups thousands the Dutch way and rounds to at most two decimals by default', () => {
    expect(formatCount(1_000_000_000)).toBe('1.000.000.000');
    expect(formatCount(12.3456)).toBe('12,35');
    expect(formatCount(7)).toBe('7');
  });

  it('honours the maximum number of decimals', () => {
    expect(formatCount(12.3456, 0)).toBe('12');
    expect(formatCount(12.3456, 3)).toBe('12,346');
  });
});

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
    expect(formatMonth('2024-11')).toBe('Nov 24');
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
});

/** Local-time timestamp, so the expectations hold in any time zone. */
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe('date formatters (dd-mm-yyyy, English names)', () => {
  it('prints date-only values as zero-padded dd-mm-yyyy without any time zone shift', () => {
    expect(formatDate('2024-03-05')).toBe('05-03-2024');
    expect(formatDate('2026-10-20')).toBe('20-10-2026');
    expect(formatDate('2026-01-01')).toBe('01-01-2026');
    expect(formatDate('2026-12-31')).toBe('31-12-2026');
    expect(formatDate('2024-02-29')).toBe('29-02-2024');
  });

  it('prints timestamps in local time, with a 24-hour clock and no locale dependence', () => {
    expect(formatDate(local(2026, 10, 20, 11, 27))).toBe('20-10-2026');
    expect(formatDateTime(local(2026, 10, 20, 11, 27))).toBe('20-10-2026, 11:27');
    expect(formatDateTime(local(2026, 1, 2, 0, 5))).toBe('02-01-2026, 00:05');
    expect(formatDateTime(local(2026, 12, 31, 23, 59))).toBe('31-12-2026, 23:59');
    expect(formatTime(local(2026, 10, 20, 9, 7))).toBe('09:07');
    expect(formatTime(local(2026, 10, 20, 15, 30))).toBe('15:30');
  });

  it('handles the daylight-saving switch days', () => {
    expect(formatDateTime(local(2026, 3, 29, 3, 30))).toBe('29-03-2026, 03:30');
    expect(formatDateTime(local(2026, 10, 25, 1, 30))).toBe('25-10-2026, 01:30');
  });

  it('prefixes the English weekday for date-only values and timestamps', () => {
    expect(formatWeekdayDate('2026-10-02')).toBe('Friday, 02-10-2026');
    expect(formatWeekdayDate('2026-10-04')).toBe('Sunday, 04-10-2026');
    expect(formatWeekdayDate(local(2026, 10, 19, 16, 39))).toBe('Monday, 19-10-2026');
    expect(formatWeekdayLong('2026-10-05')).toBe('Monday');
    expect(formatWeekdayShort('2026-10-05')).toBe('Mon');
    expect(formatWeekdayTime(local(2026, 10, 19, 2, 0))).toBe('Mon 02:00');
    expect(formatWeekdayTime(local(2026, 10, 24, 23, 45))).toBe('Sat 23:45');
  });

  it('names every month and weekday in English', () => {
    expect(MONTH_NAMES_LONG).toHaveLength(12);
    expect(MONTH_NAMES_SHORT.join(' ')).toBe('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec');
    const days = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
    expect(days.map((d) => formatWeekdayLong(d))).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
    MONTH_NAMES_LONG.forEach((name, i) => {
      const key = `2026-${String(i + 1).padStart(2, '0')}`;
      expect(formatMonthYear(key)).toBe(`${name} 2026`);
      expect(formatMonthShort(`${key}-15`)).toBe(name.slice(0, 3));
    });
  });

  it('formats month headings and compact chart labels at year boundaries', () => {
    expect(formatMonthYear('2026-10')).toBe('October 2026');
    expect(formatMonthYear('2026-10-20')).toBe('October 2026');
    expect(formatMonthYear('2027-01')).toBe('January 2027');
    expect(formatMonth('2026-10')).toBe('Oct 26');
    expect(formatMonth('2027-01')).toBe('Jan 27');
    expect(formatMonth('2009-12')).toBe('Dec 09');
    expect(formatDayMonthShort('2026-10-02')).toBe('2 Oct');
    expect(formatDayMonthShort('2026-12-31')).toBe('31 Dec');
    expect(formatDayMonthShort(local(2026, 1, 9, 12))).toBe('9 Jan');
    expect(formatDayOfMonth('2026-10-02')).toBe('2');
    expect(formatDayOfMonth('2026-10-20')).toBe('20');
  });

  it('degrades to empty names for an unparseable date instead of throwing', () => {
    expect(formatWeekdayLong('nonsense')).toBe('');
    expect(formatMonthShort('nonsense')).toBe('');
  });
});
