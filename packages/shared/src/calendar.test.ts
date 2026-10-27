import { describe, expect, it } from 'vitest';
import { calculatePassiveIncome } from './analytics-income.js';
import {
  CALENDAR_CHART_MONTHS,
  CALENDAR_COVERAGE,
  buildCalendar,
  calendarAddMonths,
  calendarChartWindow,
  calendarDataWindow,
  calendarKeys,
  calendarLastDay,
  calendarMonthOf,
  calendarMonthlyIncome,
  calendarRatioFromQuantity,
  calendarSplitKind,
  calendarSplitLabel,
  defaultCalendarRange,
  projectedEarningsDate,
  type CalendarData,
  type CalendarEvent,
  type CalendarQuery,
  type StoredEarningsEvent,
  type StoredSplitEvent,
} from './calendar.js';
import { FxTimeline } from './fx.js';
import { calculatePortfolio } from './portfolio.js';
import type { DividendEvent, FxRates, InstrumentProfile, Quote, Transaction } from './types.js';

const TODAY = '2026-06-15';
const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-15T00:00:00Z' };

let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2025-01-02',
  type: 'BUY',
  symbol: 'AAPL',
  quantity: 10,
  price: 100,
  fee: 0,
  currency: 'USD',
  createdAt: `2025-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
/** 10 shares × 0.5 USD with 15% withholding: 4.25 USD net = 3.40 EUR at 1.25. */
const aaplDividend = (date: string, id?: string) => tx({ ...(id ? { id } : {}), type: 'DIVIDEND', date, quantity: 10, price: 0.5, fee: 0.75 });
const quote = (symbol: string, price: number, currency: string): Quote => ({ symbol, price, previousClose: price, currency, asOf: TODAY, source: 't' });
const profile = (symbol: string, name: string, currency: string): InstrumentProfile => ({ symbol, name, assetClass: 'STOCK', currency });

const transactions: Transaction[] = [
  tx({ id: 'buy-aapl' }),
  aaplDividend('2025-08-15'),
  aaplDividend('2025-11-15'),
  aaplDividend('2026-02-15'),
  aaplDividend('2026-05-15', 'div-may'),
  tx({ id: 'buy-sap', symbol: 'SAP.DE', currency: 'EUR', date: '2025-03-01', quantity: 20, price: 200 }),
  tx({ id: 'split-sap', symbol: 'SAP.DE', currency: 'EUR', date: '2026-03-02', type: 'SPLIT', quantity: 2, price: 0 }),
  // The same split entered in a second portfolio counts once.
  tx({ id: 'split-sap-2', portfolioId: 'second', symbol: 'SAP.DE', currency: 'EUR', date: '2026-03-02', type: 'SPLIT', quantity: 2, price: 0 }),
];

const dividendEvents: DividendEvent[] = [
  { symbol: 'AAPL', exDate: '2026-05-01', payDate: '2026-05-15', amount: 0.5, currency: 'USD' },
  { symbol: 'AAPL', exDate: '2026-08-01', payDate: '2026-08-14', amount: 0.55, currency: 'USD' },
  // Declared before SAP.DE was bought: not entitled.
  { symbol: 'SAP.DE', exDate: '2025-01-10', payDate: '2025-01-20', amount: 2, currency: 'EUR' },
  { symbol: 'MSFT', exDate: '2026-06-18', payDate: '2026-07-10', amount: 0.83, currency: 'USD' },
  { symbol: 'UNTRACKED', exDate: '2026-06-20', amount: 1, currency: 'USD' },
];
const earnings: StoredEarningsEvent[] = [
  { symbol: 'AAPL', date: '2026-07-30', fiscalPeriodEnd: '2026-06-30', epsEstimate: 1.23, currency: 'USD', timeOfDay: 'AMC', source: 'alphavantage', name: 'APPLE INC' },
  { symbol: 'MSFT', date: '2026-07-21', timeOfDay: 'BMO', source: 'alphavantage' },
  { symbol: 'AAPL', date: '2026-05-01', source: 'alphavantage' },
  { symbol: 'KO', date: '2026-07-22', confirmed: true, source: 'test', timeOfDay: 'unknown' },
  { symbol: 'NOPE', date: '2026-07-22', source: 'alphavantage' },
];
const splits: StoredSplitEvent[] = [
  { symbol: 'SAP.DE', date: '2026-03-03', fromFactor: 1, toFactor: 2, source: 'eodhd' },
  { symbol: 'AAPL', date: '2026-07-10', fromFactor: 1, toFactor: 4, source: 'eodhd' },
  { symbol: 'AAPL', date: '2026-09-01', fromFactor: 100, toFactor: 104, source: 'eodhd' },
  { symbol: 'MSFT', date: '2026-07-01', fromFactor: 10, toFactor: 1, source: 'eodhd' },
];

const data: CalendarData = {
  today: TODAY,
  transactions,
  quotes: { AAPL: quote('AAPL', 150, 'USD'), 'SAP.DE': quote('SAP.DE', 250, 'EUR') },
  profiles: {
    AAPL: profile('AAPL', 'Apple Inc.', 'USD'),
    'SAP.DE': profile('SAP.DE', 'SAP SE', 'EUR'),
    MSFT: profile('MSFT', 'Microsoft', 'USD'),
  },
  fx,
  dividendEvents,
  earnings,
  splits,
  watchlist: ['MSFT', 'KO'],
};
const wide: CalendarQuery = { from: '2025-01-01', to: '2027-12-31', scope: 'all' };
const eventsOf = (query: Partial<CalendarQuery> = {}, override: Partial<CalendarData> = {}): CalendarEvent[] =>
  buildCalendar({ ...data, ...override }, { ...wide, ...query }).events;
const projected = (list: readonly CalendarEvent[]) => list.filter((e) => e.status === 'ESTIMATED' && e.type.includes('DIVIDEND'));
const byId = (events: readonly CalendarEvent[], id: string) => events.find((e) => e.id === id);

describe('calendar dates', () => {
  it('adds months across year boundaries', () => {
    expect(calendarAddMonths('2026-11', 3)).toBe('2027-02');
    expect(calendarAddMonths('2026-01', -1)).toBe('2025-12');
    expect(calendarAddMonths('2026-06', 0)).toBe('2026-06');
    expect(calendarAddMonths('2026-12', 12)).toBe('2027-12');
  });
  it('finds the last day of a month', () => {
    expect(calendarLastDay('2026-02')).toBe('2026-02-28');
    expect(calendarLastDay('2028-02')).toBe('2028-02-29');
    expect(calendarLastDay('2026-12')).toBe('2026-12-31');
    expect(calendarMonthOf('2026-06-15')).toBe('2026-06');
  });
  it('defaults to the current month ± 1', () => {
    expect(defaultCalendarRange('2026-06-15')).toEqual({ from: '2026-05-01', to: '2026-07-31' });
    expect(defaultCalendarRange('2026-01-31')).toEqual({ from: '2025-12-01', to: '2026-02-28' });
  });
  it('shows 12 months starting 3 months back in the income chart, and loads the union with the range', () => {
    expect(calendarChartWindow(TODAY)).toEqual({ from: '2026-03-01', to: '2027-02-28' });
    expect(calendarDataWindow({ from: '2026-05-01', to: '2026-07-31' }, TODAY)).toEqual({ from: '2026-03-01', to: '2027-02-28' });
    expect(calendarDataWindow({ from: '2025-01-01', to: '2028-01-01' }, TODAY)).toEqual({ from: '2025-01-01', to: '2028-01-01' });
  });
  it('builds the DynamoDB keys of the stored items', () => {
    expect(calendarKeys.earnings('AAPL', '2026-07-30')).toEqual({ PK: 'TICKER#AAPL', SK: 'EARN#2026-07-30' });
    expect(calendarKeys.split('AAPL', '2026-07-10')).toEqual({ PK: 'TICKER#AAPL', SK: 'SPLIT#2026-07-10' });
    expect(calendarKeys.earningsPrefix).toBe('EARN#');
    expect(calendarKeys.splitPrefix).toBe('SPLIT#');
    expect(calendarKeys.tickerPk('X')).toBe('TICKER#X');
  });
});

describe('split ratios', () => {
  it('classifies plain splits, reverse splits and irregular adjustments', () => {
    expect(calendarSplitKind(1, 4)).toBe('SPLIT');
    expect(calendarSplitKind(2, 3)).toBe('SPLIT');
    expect(calendarSplitKind(8, 1)).toBe('REVERSE_SPLIT');
    expect(calendarSplitKind(100, 1)).toBe('REVERSE_SPLIT');
    expect(calendarSplitKind(100, 104)).toBe('ADJUSTMENT');
    expect(calendarSplitKind(1000, 1281)).toBe('ADJUSTMENT');
    expect(calendarSplitKind(1, 1.5)).toBe('ADJUSTMENT');
    expect(calendarSplitKind(2, 2)).toBe('ADJUSTMENT');
    expect(calendarSplitKind(0, 2)).toBe('ADJUSTMENT');
    expect(calendarSplitKind(1, 150)).toBe('ADJUSTMENT');
  });
  it('labels them', () => {
    expect(calendarSplitLabel(1, 4)).toBe('4-for-1 stock split');
    expect(calendarSplitLabel(10, 1)).toBe('1-for-10 reverse split');
    expect(calendarSplitLabel(100, 104)).toBe('Share adjustment 104-for-100');
    expect(calendarSplitLabel(3, 1.123456789)).toBe('Share adjustment 1.1235-for-3');
  });
  it('turns a SPLIT transaction quantity into the smallest whole ratio', () => {
    expect(calendarRatioFromQuantity(4)).toEqual({ fromFactor: 1, toFactor: 4 });
    expect(calendarRatioFromQuantity(0.1)).toEqual({ fromFactor: 10, toFactor: 1 });
    expect(calendarRatioFromQuantity(1.5)).toEqual({ fromFactor: 2, toFactor: 3 });
    expect(calendarRatioFromQuantity(0.3333333333)).toEqual({ fromFactor: 3, toFactor: 1 });
    expect(calendarRatioFromQuantity(0.37)).toEqual({ fromFactor: 1, toFactor: 0.37 });
  });
});

describe('dividend events', () => {
  const events = eventsOf();

  it('matches a received payment with its declared dividend', () => {
    const pay = byId(events, 'pay:AAPL:2026-05-01')!;
    expect(pay).toMatchObject({
      date: '2026-05-15',
      type: 'DIVIDEND_PAY',
      status: 'PAID',
      source: 'transactions',
      origin: 'HOLDING',
      name: 'Apple Inc.',
      amountPerShare: 0.5,
      currency: 'USD',
      exDate: '2026-05-01',
      payDate: '2026-05-15',
      quantity: 10,
      expectedAmount: 3.4,
      countsAsIncome: true,
    });
    const ex = byId(events, 'ex:AAPL:2026-05-01')!;
    expect(ex).toMatchObject({ date: '2026-05-01', type: 'EX_DIVIDEND', status: 'CONFIRMED', quantity: 10, expectedAmount: 3.4, countsAsIncome: false, source: 'market-data' });
    expect(ex.description).toBe('0.5 USD per share × 10 shares');
    // No second, standalone entry for the matched transaction.
    expect(byId(events, 'paid:div-may')).toBeUndefined();
  });

  it('values a declared dividend by the quantity held, net of observed withholding (15%)', () => {
    const pay = byId(events, 'pay:AAPL:2026-08-01')!;
    expect(pay).toMatchObject({ date: '2026-08-14', status: 'CONFIRMED', quantity: 10, expectedAmount: 3.74, countsAsIncome: true });
    expect(byId(events, 'ex:AAPL:2026-08-01')).toMatchObject({ date: '2026-08-01', expectedAmount: 3.74, countsAsIncome: false, payDate: '2026-08-14' });
  });

  it('adds received dividends that match no declared event as PAID', () => {
    const paid = byId(events, `paid:${transactions[1]!.id}`)!;
    expect(paid).toMatchObject({ date: '2025-08-15', status: 'PAID', type: 'DIVIDEND_PAY', payDate: '2025-08-15', quantity: 10, amountPerShare: 0.5, expectedAmount: 3.4, origin: 'HOLDING' });
    expect(paid.exDate).toBeUndefined();
    expect(events.filter((e) => e.status === 'PAID')).toHaveLength(4);
  });

  it('uses the shares held the day before the ex-date', () => {
    const past: DividendEvent[] = [{ symbol: 'AAPL', exDate: '2026-04-10', payDate: '2026-04-25', amount: 0.5, currency: 'USD' }];
    const quantityWith = (buyDate: string) =>
      byId(eventsOf({}, { dividendEvents: past, transactions: [...transactions, tx({ id: 'late-buy', date: buyDate, quantity: 5 })] }), 'ex:AAPL:2026-04-10')!.quantity;
    expect(quantityWith('2026-04-10')).toBe(10);
    expect(quantityWith('2026-04-09')).toBe(15);
  });

  it('skips dividends declared before the position existed and for symbols the user does not track', () => {
    expect(events.some((e) => e.symbol === 'SAP.DE' && e.type !== 'SPLIT')).toBe(false);
    expect(events.some((e) => e.symbol === 'UNTRACKED')).toBe(false);
  });

  it('shows watchlist dividends without a quantity or amount', () => {
    const ex = byId(events, 'ex:MSFT:2026-06-18')!;
    expect(ex).toMatchObject({ origin: 'WATCHLIST', status: 'CONFIRMED', amountPerShare: 0.83, currency: 'USD', countsAsIncome: false });
    expect(ex.quantity).toBeUndefined();
    expect(ex.expectedAmount).toBeUndefined();
    expect(byId(events, 'pay:MSFT:2026-06-18')).toMatchObject({ date: '2026-07-10', quantity: undefined, expectedAmount: undefined, countsAsIncome: true });
    expect(ex.description).toBe('0.83 USD per share');
  });

  it('lets the ex-date carry the income when no pay date is known, and matches a payment up to 60 days later', () => {
    const noPay: DividendEvent[] = [{ symbol: 'AAPL', exDate: '2026-02-01', amount: 0.5, currency: 'USD' }];
    const open = eventsOf({}, { dividendEvents: noPay, transactions: transactions.filter((t) => t.date !== '2026-02-15') });
    expect(byId(open, 'ex:AAPL:2026-02-01')).toMatchObject({ countsAsIncome: true, expectedAmount: 3.4, payDate: undefined });
    expect(byId(open, 'pay:AAPL:2026-02-01')).toBeUndefined();
    const matched = eventsOf({}, { dividendEvents: noPay });
    expect(byId(matched, 'ex:AAPL:2026-02-01')).toMatchObject({ countsAsIncome: false });
    expect(byId(matched, 'pay:AAPL:2026-02-01')).toMatchObject({ status: 'PAID', date: '2026-02-15', expectedAmount: 3.4, payDate: '2026-02-15' });
    // A payment before the ex-date or more than 60 days after it is not matched.
    const within = [{ symbol: 'AAPL', exDate: '2025-12-20', amount: 0.5, currency: 'USD' }];
    expect(byId(eventsOf({}, { dividendEvents: within }), 'pay:AAPL:2025-12-20')).toMatchObject({ date: '2026-02-15', status: 'PAID' });
    const tooLate = [{ symbol: 'AAPL', exDate: '2025-09-01', amount: 0.5, currency: 'USD' }];
    expect(byId(eventsOf({}, { dividendEvents: tooLate }), 'pay:AAPL:2025-09-01')).toBeUndefined();
    const before = [{ symbol: 'AAPL', exDate: '2026-03-01', amount: 0.5, currency: 'USD' }];
    expect(byId(eventsOf({}, { dividendEvents: before }), 'pay:AAPL:2026-03-01')).toBeUndefined();
  });

  it('does not match a payment more than a week away from the pay date', () => {
    const shifted: DividendEvent[] = [{ symbol: 'AAPL', exDate: '2026-04-01', payDate: '2026-04-20', amount: 0.5, currency: 'USD' }];
    const result = eventsOf({}, { dividendEvents: shifted });
    expect(byId(result, 'pay:AAPL:2026-04-01')).toMatchObject({ status: 'CONFIRMED', date: '2026-04-20' });
    expect(byId(result, 'paid:div-may')).toMatchObject({ status: 'PAID' });
  });

  it('picks the closest of several received payments', () => {
    const two = [...transactions, aaplDividend('2026-05-12', 'div-early')];
    const result = eventsOf({}, { transactions: two });
    expect(byId(result, 'pay:AAPL:2026-05-01')).toMatchObject({ date: '2026-05-15' });
    expect(byId(result, 'paid:div-early')).toMatchObject({ status: 'PAID', date: '2026-05-12' });
  });

  it('converts past events at the fixing of the ex-date and future ones at the latest rate', () => {
    const history = [{ base: 'EUR', date: '2026-05-01', rates: { USD: 1 } }];
    const result = eventsOf({}, { fxHistory: history });
    // Past ex-date at 1.00: 10 × 0.5 USD = 5 EUR × 0.85.
    expect(byId(result, 'ex:AAPL:2026-05-01')!.expectedAmount).toBe(4.25);
    expect(byId(result, 'ex:AAPL:2026-08-01')!.expectedAmount).toBe(3.74);
  });

  it('merges a stored dividend that appears twice', () => {
    const dup = [...dividendEvents, { symbol: 'AAPL', exDate: '2026-08-01', payDate: '2026-08-14', amount: 0.6, currency: 'USD' }];
    const result = eventsOf({}, { dividendEvents: dup });
    expect(result.filter((e) => e.id === 'ex:AAPL:2026-08-01')).toHaveLength(1);
    expect(byId(result, 'ex:AAPL:2026-08-01')!.amountPerShare).toBe(0.6);
  });
});

describe('estimated dividends', () => {
  const events = eventsOf();

  it('projects the payments the history implies that are not declared yet', () => {
    const est = projected(events).filter((e) => e.symbol === 'AAPL');
    expect(est.map((e) => `${e.type}:${e.date}`)).toEqual([
      'EX_DIVIDEND:2026-10-30',
      'DIVIDEND_PAY:2026-11-13',
      'EX_DIVIDEND:2027-01-29',
      'DIVIDEND_PAY:2027-02-12',
      'EX_DIVIDEND:2027-04-30',
      'DIVIDEND_PAY:2027-05-14',
    ]);
    const pay = byId(events, 'est-pay:AAPL:2026-11-13')!;
    expect(pay).toMatchObject({ expectedAmount: 3.4, quantity: 10, amountPerShare: 0.5, currency: 'USD', countsAsIncome: true, source: 'estimate' });
    expect(pay.exDate).toBeUndefined();
    expect(pay.description).toContain('projected from your payment history');
    expect(byId(events, 'est-ex:AAPL:2026-10-30')).toMatchObject({ countsAsIncome: false, payDate: '2026-11-13', exDate: '2026-10-30' });
  });

  it('skips periods that a declared event already covers', () => {
    expect(byId(events, 'est-pay:AAPL:2026-08-14')).toBeUndefined();
  });

  it('omits estimated ex-dates when no ex-to-pay lag is known', () => {
    const result = eventsOf({}, { dividendEvents: [] });
    const est = projected(result);
    expect(est.every((e) => e.type === 'DIVIDEND_PAY')).toBe(true);
    // Without a declared event the first payment already falls on 2026-08-14.
    expect(est.map((e) => e.date)).toEqual(['2026-08-14', '2026-11-13', '2027-02-12', '2027-05-14']);
  });

  it('does not project payers that stopped paying a year ago, non-payers or sold positions', () => {
    const stale = transactions.filter((t) => t.type !== 'DIVIDEND' || t.date < '2025-06-01');
    expect(eventsOf({}, { transactions: [...stale, aaplDividend('2025-01-15')] }).filter((e) => e.type.includes('DIVIDEND') && e.status === 'ESTIMATED')).toEqual([]);
    expect(eventsOf({}, { transactions: transactions.filter((t) => t.type !== 'DIVIDEND') }).filter((e) => e.type.includes('DIVIDEND') && e.status === 'ESTIMATED')).toEqual([]);
    const sold = [...transactions, tx({ id: 'sell', type: 'SELL', date: '2026-06-01', quantity: 10 })];
    expect(eventsOf({}, { transactions: sold }).filter((e) => e.type.includes('DIVIDEND') && e.status === 'ESTIMATED')).toEqual([]);
  });

  it('projects an annual payer once and stays inside the 12-month horizon', () => {
    const annual = [tx({ id: 'b' }), tx({ type: 'DIVIDEND', date: '2025-09-01', price: 1, fee: 0 }), tx({ type: 'DIVIDEND', date: '2024-09-01', price: 1, fee: 0 })];
    const result = projected(eventsOf({}, { transactions: annual, dividendEvents: [] }));
    expect(result.map((e) => `${e.id}`)).toEqual(['est-pay:AAPL:2026-09-01']);
    expect(result[0]!.expectedAmount).toBe(8);
  });

  it('starts at the first payment date after today when the last payment is overdue', () => {
    const monthly = [tx({ id: 'b' }), ...['2026-03-14', '2026-04-14', '2026-05-14'].map((d) => tx({ type: 'DIVIDEND', date: d, price: 0.1, fee: 0 }))];
    const result = projected(eventsOf({}, { transactions: monthly, dividendEvents: [] }));
    expect(result[0]!.date).toBe('2026-07-13');
    expect(result).toHaveLength(12);
  });
});

describe('earnings and splits', () => {
  const events = eventsOf();

  it('lists earnings of held and watched symbols with fiscal period, EPS estimate and time of day', () => {
    expect(byId(events, 'earn:AAPL:2026-07-30')).toMatchObject({
      type: 'EARNINGS',
      status: 'ESTIMATED',
      name: 'Apple Inc.',
      origin: 'HOLDING',
      source: 'alphavantage',
      fiscalPeriodEnd: '2026-06-30',
      epsEstimate: 1.23,
      currency: 'USD',
      timeOfDay: 'AMC',
    });
    expect(byId(events, 'earn:AAPL:2026-07-30')!.description).toBe('Earnings report for the period ending 2026-06-30 · EPS estimate 1.23 USD · after market close');
    // Without a profile the provider's company name is used.
    expect(eventsOf({}, { profiles: {} }).find((e) => e.id === 'earn:AAPL:2026-07-30')!.name).toBe('APPLE INC');
    const msft = byId(events, 'earn:MSFT:2026-07-21')!;
    expect(msft).toMatchObject({ origin: 'WATCHLIST', name: 'Microsoft', timeOfDay: 'BMO' });
    expect(msft.description).toBe('Earnings report · before market open');
    expect(byId(events, 'earn:KO:2026-07-22')).toMatchObject({ status: 'CONFIRMED', name: 'KO', timeOfDay: 'unknown', description: 'Earnings report' });
    expect(byId(events, 'earn:AAPL:2026-05-01')).toMatchObject({ status: 'CONFIRMED', timeOfDay: 'unknown' });
    expect(events.some((e) => e.symbol === 'NOPE')).toBe(false);
  });

  it('prefers the split you recorded over the provider’s, and counts a split entered twice once', () => {
    const splitsOf = events.filter((e) => e.symbol === 'SAP.DE' && e.type === 'SPLIT');
    expect(splitsOf).toHaveLength(1);
    expect(splitsOf[0]).toMatchObject({ id: 'split:SAP.DE:2026-03-02', source: 'transactions', splitFrom: 1, splitTo: 2, status: 'CONFIRMED', description: '2-for-1 stock split' });
  });

  it('lists provider splits and irregular adjustments', () => {
    expect(byId(events, 'split:AAPL:2026-07-10')).toMatchObject({ type: 'SPLIT', source: 'eodhd', description: '4-for-1 stock split', splitFrom: 1, splitTo: 4 });
    expect(byId(events, 'split:AAPL:2026-09-01')).toMatchObject({ type: 'CORPORATE_ACTION', description: 'Share adjustment 104-for-100' });
    expect(byId(events, 'split:MSFT:2026-07-01')).toMatchObject({ type: 'SPLIT', origin: 'WATCHLIST', description: '1-for-10 reverse split' });
  });

  it('shows a provider split that is not within 3 days of an own split', () => {
    const far = [{ symbol: 'SAP.DE', date: '2026-03-06', fromFactor: 1, toFactor: 2, source: 'eodhd' }];
    expect(eventsOf({}, { splits: far }).filter((e) => e.symbol === 'SAP.DE' && e.type === 'SPLIT')).toHaveLength(2);
  });
});

describe('reported and projected earnings', () => {
  const noProviderAhead = earnings.filter((e) => e.symbol !== 'AAPL' || e.date < TODAY);
  const earningsOnly = (override: Partial<CalendarData>): CalendarEvent[] => eventsOf({ types: ['EARNINGS'] }, override).filter((e) => e.symbol === 'AAPL');

  it('shows a stored summary as reported earnings: CONFIRMED, labelled Reported, with its own source', () => {
    const events = earningsOnly({ reportedEarnings: [{ symbol: 'AAPL', reportDate: '2026-04-30', period: 'Q2 2026' }] });
    expect(byId(events, 'earn:AAPL:2026-04-30')).toEqual({
      id: 'earn:AAPL:2026-04-30',
      date: '2026-04-30',
      type: 'EARNINGS',
      status: 'CONFIRMED',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      origin: 'HOLDING',
      source: 'earnings-summary',
      description: 'Reported results for Q2 2026',
      period: 'Q2 2026',
      timeOfDay: 'unknown',
      earningsPhase: 'reported',
    });
    // The provider still lists the next date: nothing is projected.
    expect(events.map((e) => e.earningsPhase)).toEqual(['reported', 'scheduled']);
  });

  it('a released report replaces the provider date it matches and keeps its fiscal period, estimate and time of day', () => {
    const provider: StoredEarningsEvent = { symbol: 'AAPL', date: '2026-05-01', fiscalPeriodEnd: '2026-03-31', epsEstimate: 1.1, currency: 'USD', timeOfDay: 'AMC', source: 'alphavantage' };
    const events = earningsOnly({ earnings: [provider], reportedEarnings: [{ symbol: 'AAPL', reportDate: '2026-04-30' }] });
    expect(events.filter((e) => e.date < TODAY)).toEqual([expect.objectContaining({ id: 'earn:AAPL:2026-04-30', description: 'Reported results', fiscalPeriodEnd: '2026-03-31', epsEstimate: 1.1, timeOfDay: 'AMC', earningsPhase: 'reported' })]);
    expect(byId(events, 'earn:AAPL:2026-05-01')).toBeUndefined();
  });

  it('keeps a provider date that is more than four days from the released report', () => {
    const provider: StoredEarningsEvent = { symbol: 'AAPL', date: '2026-05-06', source: 'alphavantage' };
    const events = earningsOnly({ earnings: [provider], reportedEarnings: [{ symbol: 'AAPL', reportDate: '2026-04-30' }] });
    expect(events.map((e) => e.id).filter((id) => id.startsWith('earn:'))).toEqual(['earn:AAPL:2026-04-30', 'earn:AAPL:2026-05-06']);
  });

  it('projects the next date a quarter (91 days) after the previous report when the provider has none, labelled as an estimate', () => {
    const events = earningsOnly({ earnings: noProviderAhead, reportedEarnings: [{ symbol: 'AAPL', reportDate: '2026-05-14', period: 'Q2 2026' }] });
    expect(events.find((e) => e.earningsPhase === 'projected')).toEqual({
      id: 'earn-est:AAPL:2026-08-13',
      date: '2026-08-13',
      type: 'EARNINGS',
      status: 'ESTIMATED',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      origin: 'HOLDING',
      source: 'estimate',
      description: 'Estimated next report, about 91 days after the previous one (2026-05-14). A projection, not an announced date.',
      timeOfDay: 'unknown',
      earningsPhase: 'projected',
    });
  });

  it('projects from the latest of several reports, and for a watched company too', () => {
    const reports = [
      { symbol: 'MSFT', reportDate: '2026-01-20' },
      { symbol: 'MSFT', reportDate: '2026-04-21' },
    ];
    const projection = eventsOf({ types: ['EARNINGS'] }, { earnings: noProviderAhead.filter((e) => e.symbol !== 'MSFT'), reportedEarnings: reports }).find((e) => e.id.startsWith('earn-est:MSFT'));
    expect(projection).toMatchObject({ date: '2026-07-21', origin: 'WATCHLIST', status: 'ESTIMATED' });
  });

  it('skips whole quarters that are long gone, but not a report that is only a few days overdue, nor one older than a year', () => {
    expect(projectedEarningsDate('2026-05-14', TODAY)).toBe('2026-08-13');
    expect(projectedEarningsDate('2026-03-17', TODAY)).toBe('2026-06-16');
    expect(projectedEarningsDate('2026-01-10', TODAY)).toBe('2026-07-11');
    expect(projectedEarningsDate('2026-03-10', TODAY)).toBeNull();
    expect(projectedEarningsDate('2024-01-01', TODAY)).toBeNull();
  });

  it('projects nothing while the provider has a date ahead, and nothing for symbols that are neither held nor watched', () => {
    const events = eventsOf({ types: ['EARNINGS'] }, { reportedEarnings: [{ symbol: 'AAPL', reportDate: '2026-04-30' }, { symbol: 'NOPE', reportDate: '2026-04-30' }] });
    expect(events.some((e) => e.earningsPhase === 'projected')).toBe(false);
    expect(events.some((e) => e.symbol === 'NOPE')).toBe(false);
  });

  it('honours the status and type filters and counts for no income', () => {
    const result = buildCalendar({ ...data, earnings: noProviderAhead, reportedEarnings: [{ symbol: 'AAPL', reportDate: '2026-05-14' }] }, { ...wide, types: ['EARNINGS'], statuses: ['ESTIMATED'], scope: 'holdings' });
    expect(result.events.filter((e) => e.symbol === 'AAPL').map((e) => e.id)).toEqual(['earn-est:AAPL:2026-08-13']);
    expect(result.events.every((e) => e.countsAsIncome === undefined)).toBe(true);
  });
});

describe('filters', () => {
  it('limits events to the date range, inclusive', () => {
    const ids = eventsOf({ from: '2026-07-10', to: '2026-07-21' }).map((e) => e.id);
    expect(ids).toEqual(['pay:MSFT:2026-06-18', 'split:AAPL:2026-07-10', 'earn:MSFT:2026-07-21']);
  });

  it('filters by type and by status', () => {
    expect(new Set(eventsOf({ types: ['EARNINGS'] }).map((e) => e.type))).toEqual(new Set(['EARNINGS']));
    expect(new Set(eventsOf({ types: ['SPLIT', 'CORPORATE_ACTION'] }).map((e) => e.type))).toEqual(new Set(['SPLIT', 'CORPORATE_ACTION']));
    expect(new Set(eventsOf({ statuses: ['PAID'] }).map((e) => e.status))).toEqual(new Set(['PAID']));
    expect(new Set(eventsOf({ statuses: ['ESTIMATED'] }).map((e) => e.status))).toEqual(new Set(['ESTIMATED']));
    expect(eventsOf({ types: [], statuses: [] })).toHaveLength(eventsOf().length);
  });

  it('filters by holdings and watchlist', () => {
    const holdings = eventsOf({ scope: 'holdings' });
    expect(holdings.every((e) => e.origin === 'HOLDING')).toBe(true);
    expect(holdings.some((e) => e.symbol === 'MSFT')).toBe(false);
    const watch = eventsOf({ scope: 'watchlist' });
    expect(watch.length).toBeGreaterThan(0);
    expect(watch.every((e) => e.origin === 'WATCHLIST')).toBe(true);
    expect(eventsOf({ scope: 'all' }).length).toBe(holdings.length + watch.length);
  });

  it('sorts by date, then type, then symbol', () => {
    const sorted = eventsOf({ from: '2026-07-01', to: '2026-07-31' });
    expect(sorted.map((e) => e.id)).toEqual([
      'split:MSFT:2026-07-01',
      'pay:MSFT:2026-06-18',
      'split:AAPL:2026-07-10',
      'earn:MSFT:2026-07-21',
      'earn:KO:2026-07-22',
      'earn:AAPL:2026-07-30',
    ]);
  });
});

describe('summary and monthly income', () => {
  const result = buildCalendar(data, { ...wide, scope: 'holdings', types: ['EARNINGS'] });

  it('reuses the analytics passive-income numbers', () => {
    const { holdings } = calculatePortfolio({ transactions, quotes: data.quotes, profiles: data.profiles, fx, now: new Date('2026-06-15T12:00:00Z') });
    const income = calculatePassiveIncome(holdings, transactions, dividendEvents, new FxTimeline(fx), TODAY);
    expect(result.summary).toEqual({
      annualIncome: income.forward12m,
      monthlyAverage: 1.16,
      dailyAverage: 0.04,
      yieldPct: income.yieldOnValuePct,
      yieldOnCostPct: income.yieldOnCostPct,
      declared: 3.74,
      estimated: 10.2,
    });
    expect(result.summary.annualIncome).toBe(13.94);
    expect(result.baseCurrency).toBe('EUR');
    expect(result.summary.yieldPct).toBeCloseTo(0.12, 2);
  });

  it('ignores the filters and splits twelve months into paid, declared and estimated', () => {
    expect(result.monthly).toHaveLength(CALENDAR_CHART_MONTHS);
    expect(result.monthly[0]!.month).toBe('2026-03');
    expect(result.monthly.at(-1)!.month).toBe('2027-02');
    const nonZero = result.monthly.filter((m) => m.total > 0);
    expect(nonZero).toEqual([
      { month: '2026-05', paid: 3.4, declared: 0, estimated: 0, total: 3.4 },
      { month: '2026-08', paid: 0, declared: 3.74, estimated: 0, total: 3.74 },
      { month: '2026-11', paid: 0, declared: 0, estimated: 3.4, total: 3.4 },
      { month: '2027-02', paid: 0, declared: 0, estimated: 3.4, total: 3.4 },
    ]);
    expect(result.monthly).toEqual(buildCalendar(data, wide).monthly);
  });

  it('does not count events without an amount or outside the chart window', () => {
    const events = [
      { id: 'a', date: '2026-03-10', countsAsIncome: true, expectedAmount: 1, status: 'PAID' },
      { id: 'b', date: '2025-03-10', countsAsIncome: true, expectedAmount: 5, status: 'PAID' },
      { id: 'c', date: '2026-04-10', countsAsIncome: true, status: 'CONFIRMED' },
      { id: 'd', date: '2026-04-10', countsAsIncome: false, expectedAmount: 7, status: 'CONFIRMED' },
    ] as CalendarEvent[];
    const months = calendarMonthlyIncome(events, TODAY);
    expect(months.find((m) => m.month === '2026-03')).toEqual({ month: '2026-03', paid: 1, declared: 0, estimated: 0, total: 1 });
    expect(months.find((m) => m.month === '2026-04')!.total).toBe(0);
    expect(months.reduce((s, m) => s + m.total, 0)).toBe(1);
  });

  it('describes what is and is not covered', () => {
    expect(result.coverage).toEqual(CALENDAR_COVERAGE);
    expect(result.coverage.earnings).toMatch(/Alpha Vantage earnings calendar/);
    expect(result.coverage.earnings).toMatch(/projected from the previous report/);
    expect(result.coverage.corporateActions).toMatch(/Mergers, spin-offs, symbol changes/);
    expect(result.from).toBe('2025-01-01');
    expect(result.to).toBe('2027-12-31');
  });
});

describe('without holdings', () => {
  it('shows watchlist events only and reports no income', () => {
    const empty = buildCalendar({ ...data, transactions: [] }, wide);
    expect(empty.events.length).toBeGreaterThan(0);
    expect(empty.events.every((e) => e.origin === 'WATCHLIST')).toBe(true);
    expect(empty.events.map((e) => e.symbol)).not.toContain('AAPL');
    expect(empty.summary).toEqual({ annualIncome: 0, monthlyAverage: 0, dailyAverage: 0, yieldPct: 0, yieldOnCostPct: 0, declared: 0, estimated: 0 });
    expect(empty.monthly.every((m) => m.total === 0)).toBe(true);
  });
});
