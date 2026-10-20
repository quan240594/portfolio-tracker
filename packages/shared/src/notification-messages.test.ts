import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  TEST_NOTIFICATION,
  buildDeclaredNotification,
  buildExDividendNotification,
  buildReceivedNotification,
  buildSummaryNotification,
  comparisonParts,
  formatNoticeDate,
  formatPerShare,
  formatSignedPct,
  formatTotal,
  previousPeriodLabel,
  shortName,
  truncate,
  type DividendNotice,
  type ReceivedNotice,
} from './notification-messages.js';

const KMB: DividendNotice = {
  symbol: 'KMB',
  name: 'Kimberly-Clark Corporation',
  amountPerShare: 1.28,
  currency: 'USD',
  exDate: '2026-11-06',
  payDate: '2026-12-02',
  comparison: {
    vsPrevious: { pct: 2.4, previousPerShare: 1.25, previousDate: '2026-08-07' },
    vsYearAgo: { pct: 5.8, yearAgoPerShare: 1.21, yearAgoDate: '2025-11-06' },
  },
  baseCurrency: 'EUR',
  quantity: 6.4,
  expectedAmount: 7.74,
};

const RECEIVED: ReceivedNotice = { ...KMB, paidDate: '2026-12-02', receivedAmount: 6.19, receivedCurrency: 'EUR', transactionId: 'tx-1', comparisonDate: '2026-12-02' };

describe('message builders (the rendered examples)', () => {
  it('declared', () => {
    const { payload } = buildDeclaredNotification(KMB);
    expect(payload).toEqual({
      type: 'declared',
      symbol: 'KMB',
      title: 'Kimberly-Clark declared $1.28 per share',
      body: 'Ex-date 06-11-2026, pay 02-12-2026 · +2.4 % vs last quarter · +5.8 % vs a year ago · about EUR 7.74 for your 6.4 shares',
      url: '/assets/KMB',
      tag: 'declared:KMB:2026-11-06',
    });
  });

  it('declared, with the symbol only', () => {
    expect(buildDeclaredNotification({ ...KMB, name: undefined }).payload.title).toBe('KMB declared $1.28 per share');
  });

  it('ex-dividend reminder', () => {
    const { payload } = buildExDividendNotification({ ...KMB, name: undefined }, 2);
    expect(payload).toEqual({
      type: 'exDividend',
      symbol: 'KMB',
      title: 'KMB goes ex-dividend in 2 days (06-11-2026)',
      body: '$1.28 per share, +2.4 % vs last quarter, +5.8 % vs a year ago',
      url: '/assets/KMB',
      tag: 'exDividend:KMB:2026-11-06',
    });
  });

  it('ex-dividend tomorrow', () => {
    expect(buildExDividendNotification(KMB, 1).payload.title).toBe('Kimberly-Clark goes ex-dividend tomorrow (06-11-2026)');
  });

  it('received', () => {
    const { payload } = buildReceivedNotification({ ...RECEIVED, name: undefined });
    expect(payload).toEqual({
      type: 'received',
      symbol: 'KMB',
      title: 'KMB dividend received: EUR 6.19',
      body: '$1.28 per share, +2.4 % vs last quarter, +5.8 % vs a year ago',
      url: '/assets/KMB',
      tag: 'received:KMB:2026-12-02:tx-1',
    });
  });

  it('leaves out the parts it cannot know: no comparison, no pay date, no quantity', () => {
    const bare: DividendNotice = { ...KMB, comparison: {}, payDate: undefined, quantity: undefined, expectedAmount: undefined };
    expect(buildDeclaredNotification(bare).payload.body).toBe('Ex-date 06-11-2026');
    expect(buildExDividendNotification(bare, 3).payload.body).toBe('$1.28 per share');
    expect(buildReceivedNotification({ ...RECEIVED, comparison: {} }).payload.body).toBe('$1.28 per share');
  });

  it('says a year-ago comparison once for an annual payer', () => {
    const annual = { vsPrevious: { pct: 9.1, previousPerShare: 2.2, previousDate: '2025-05-02' }, vsYearAgo: { pct: 9.1, yearAgoPerShare: 2.2, yearAgoDate: '2025-05-02' } };
    expect(comparisonParts(annual, '2026-05-01')).toEqual(['+9.1 % vs a year ago']);
  });

  it('puts one summary line per notice, with its percentage', () => {
    expect(buildDeclaredNotification(KMB).line).toBe('Kimberly-Clark declared $1.28 (+2.4 %)');
    expect(buildExDividendNotification(KMB, 2).line).toBe('Kimberly-Clark ex-dividend in 2 days (+2.4 %)');
    expect(buildReceivedNotification(RECEIVED).line).toBe('Kimberly-Clark received EUR 6.19 (+2.4 %)');
    expect(buildDeclaredNotification({ ...KMB, comparison: { vsYearAgo: KMB.comparison.vsYearAgo } }).line).toBe('Kimberly-Clark declared $1.28 (+5.8 %)');
    expect(buildDeclaredNotification({ ...KMB, comparison: {} }).line).toBe('Kimberly-Clark declared $1.28');
  });

  it('caps the title and the body', () => {
    const long = buildDeclaredNotification({ ...KMB, name: 'A'.repeat(200), symbol: 'X'.repeat(80), comparison: {} });
    expect(long.payload.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    const parts = { ...KMB, symbol: 'S'.repeat(300), comparison: {} };
    expect(buildDeclaredNotification(parts).payload.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(buildExDividendNotification({ ...KMB, currency: 'C'.repeat(400) }, 2).payload.body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
  });

  it('encodes the symbol in the app route', () => {
    expect(buildDeclaredNotification({ ...KMB, symbol: 'BRK.B' }).payload.url).toBe('/assets/BRK.B');
    expect(buildDeclaredNotification({ ...KMB, symbol: 'A/B' }).payload.url).toBe('/assets/A%2FB');
  });
});

describe('summary', () => {
  const lines = ['KMB declared $1.28 (+2.4 %)', 'MSFT ex-dividend tomorrow (+10.0 %)', 'ABBV received EUR 6.19 (-1.0 %)', 'O declared $0.26', 'PG declared $1.01'];

  it('counts the items, lists the first three and opens the calendar', () => {
    expect(buildSummaryNotification(lines, '2026-11-04')).toEqual({
      type: 'summary',
      symbol: '',
      title: '5 dividend updates',
      body: 'KMB declared $1.28 (+2.4 %) · MSFT ex-dividend tomorrow (+10.0 %) · ABBV received EUR 6.19 (-1.0 %) · and 2 more',
      url: '/calendar',
      tag: 'summary:2026-11-04:5',
    });
  });

  it('has no "and more" for exactly three', () => {
    expect(buildSummaryNotification(lines.slice(0, 3), '2026-11-04').body).not.toContain('more');
  });
});

describe('formatting', () => {
  it('writes dates as dd-mm-yyyy', () => {
    expect(formatNoticeDate('2026-01-05')).toBe('05-01-2026');
  });

  it('writes per-share amounts in their own currency with 2 to 4 decimals', () => {
    expect(formatPerShare(1.28, 'USD')).toBe('$1.28');
    expect(formatPerShare(1.2, 'USD')).toBe('$1.20');
    expect(formatPerShare(0.0275, 'EUR')).toBe('€0.0275');
    expect(formatPerShare(0.30125, 'GBP')).toBe('£0.3013');
    expect(formatPerShare(2, 'CAD')).toBe('CAD 2.00');
    expect(formatPerShare(150, 'JPY')).toBe('¥150.00');
  });

  it('writes totals with a currency code and thousands separators', () => {
    expect(formatTotal(7.74, 'EUR')).toBe('EUR 7.74');
    expect(formatTotal(1234567.891, 'EUR')).toBe('EUR 1,234,567.89');
    expect(formatTotal(999.999, 'EUR')).toBe('EUR 1,000.00');
    expect(formatTotal(-12.5, 'EUR')).toBe('EUR -12.50');
    expect(formatTotal(0, 'EUR')).toBe('EUR 0.00');
  });

  it('writes percentages with an explicit sign', () => {
    expect(formatSignedPct(2.4)).toBe('+2.4 %');
    expect(formatSignedPct(-1.3)).toBe('-1.3 %');
    expect(formatSignedPct(0)).toBe('0.0 %');
    expect(formatSignedPct(12)).toBe('+12.0 %');
    expect(formatSignedPct(1234.5)).toBe('+1,234.5 %');
  });

  it('writes share counts', () => {
    const one = buildDeclaredNotification({ ...KMB, quantity: 1, comparison: {} });
    expect(one.payload.body).toContain('for your 1 share');
    expect(buildDeclaredNotification({ ...KMB, quantity: 1000, comparison: {} }).payload.body).toContain('for your 1,000 shares');
    expect(buildDeclaredNotification({ ...KMB, quantity: 0.12345678, comparison: {} }).payload.body).toContain('for your 0.1235 shares');
  });

  it('names the previous payment by how long ago it was', () => {
    expect([30, 45, 46, 91, 135, 136, 182, 230, 231, 365].map(previousPeriodLabel)).toEqual([
      'last month',
      'last month',
      'last quarter',
      'last quarter',
      'last quarter',
      'last half year',
      'last half year',
      'last half year',
      'the previous payment',
      'the previous payment',
    ]);
  });

  it('shortens company names', () => {
    expect(shortName('KMB', 'Kimberly-Clark Corporation')).toBe('Kimberly-Clark');
    expect(shortName('AAPL', 'Apple Inc.')).toBe('Apple');
    expect(shortName('X', 'Some Holdings Group Inc')).toBe('Some');
    expect(shortName('PG', 'Procter & Gamble Co., Ltd')).toBe('Procter & Gamble');
    expect(shortName('Z', 'Inc')).toBe('Inc');
    expect(shortName('KMB', undefined)).toBe('KMB');
    expect(shortName('KMB', '   ')).toBe('KMB');
    expect(shortName('LONG', 'The Extraordinarily Long Company Name Of Things')).toBe('The Extraordinarily Lon…');
  });

  it('truncates with an ellipsis', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('has a test notification that opens the settings page', () => {
    expect(TEST_NOTIFICATION).toMatchObject({ type: 'test', title: 'Test notification', url: '/settings/notifications' });
  });
});
