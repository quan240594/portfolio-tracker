/** The forward-yield audit: one fixture per payer shape, checked end to end through the Dividends overview and the Calendar. */
import { describe, expect, it } from 'vitest';
import { addIsoDays } from './analytics.js';
import type { AnalyticsData } from './analytics-compute.js';
import { buildCalendar, type CalendarData } from './calendar.js';
import { majorDividend } from './minor-units.js';
import { computeDividendsOverview, type DividendOverviewHolding } from './dividends-overview.js';
import type { DividendEvent, FxRates, InstrumentProfile, Quote, Transaction } from './types.js';

const TODAY = '2026-11-15';
const fx: FxRates = { base: 'EUR', rates: { USD: 1.16, GBP: 0.87 }, asOf: `${TODAY}T00:00:00Z` };
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2026-09-01',
  type: 'BUY',
  symbol: 'HESM',
  quantity: 65,
  price: 30,
  fee: 0,
  currency: 'USD',
  createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
const received = (symbol: string, date: string, perShare: number, quantity: number, currency = 'USD', withheldShare = 0.15): Transaction =>
  tx({ type: 'DIVIDEND', symbol, date, price: perShare, quantity, currency, fee: quantity * perShare * withheldShare });
const quote = (symbol: string, price: number, currency = 'USD'): Quote => ({ symbol, price, previousClose: price, currency, asOf: TODAY, source: 't' });
const profile = (symbol: string, currency = 'USD', assetClass: InstrumentProfile['assetClass'] = 'STOCK'): InstrumentProfile => ({ symbol, name: `${symbol} name`, assetClass, currency });
/** Dividend events `step` days apart, newest first at `newestOffset` days from today, oldest amount first. */
const events = (symbol: string, count: number, step: number, newestOffset: number, amounts: readonly number[], currency = 'USD'): DividendEvent[] =>
  Array.from({ length: count }, (_, i) => {
    const exDate = addIsoDays(TODAY, newestOffset - step * (count - 1 - i));
    return { symbol, exDate, payDate: addIsoDays(exDate, 10), amount: amounts[Math.min(i, amounts.length - 1)]!, currency };
  });

interface Case {
  transactions: Transaction[];
  quotes: Quote[];
  dividendEvents: DividendEvent[];
}

function dataOf(c: Case): AnalyticsData {
  return {
    transactions: c.transactions,
    quotes: Object.fromEntries(c.quotes.map((q) => [q.symbol, q])),
    profiles: Object.fromEntries(c.quotes.map((q) => [q.symbol, profile(q.symbol, q.currency)])),
    fx,
    eod: {},
    dividendEvents: c.dividendEvents,
    today: TODAY,
  };
}

const calendarDataOf = (c: Case): CalendarData => {
  const { transactions, quotes, profiles, dividendEvents } = dataOf(c);
  return { today: TODAY, transactions, quotes, profiles, fx, dividendEvents, earnings: [], splits: [], watchlist: [] };
};

const overview = (c: Case) => computeDividendsOverview(dataOf(c));
const rowOf = (c: Case, symbol: string): DividendOverviewHolding => overview(c).holdings.find((h) => h.symbol === symbol)!;

/** HESM as the owner has it: bought two months ago, one payment received, a quarterly payer of about USD 0.8 whose provider history is known. */
const HESM_AMOUNTS = [0.7, 0.72, 0.74, 0.76, 0.78, 0.79, 0.8, 0.81];
const hesm = (): Case => ({
  transactions: [tx({}), received('HESM', addIsoDays(TODAY, -2), 0.81, 65)],
  quotes: [quote('HESM', 31.89)],
  dividendEvents: events('HESM', 8, 91, -12, HESM_AMOUNTS),
});

describe('HESM: a recent quarterly payer with one received payment', () => {
  it('projects four payments a year from the provider history instead of one', () => {
    const row = rowOf(hesm(), 'HESM');
    // 4 payments × 0.81 × 65 shares / 1.16 × (1 - 15 % withholding)
    expect(row.forward12m).toBeCloseTo(154.31, 1);
    expect(row.basis).toBe('provider-history');
    expect(row.paymentsPerYear).toBe(4);
    expect(row.perShareAnnual).toBeCloseTo(3.24, 2);
    // net yield on the value of 65 × 31.89 USD; gross is what the broker quotes (3.24 / 31.89)
    expect(row.yieldPct).toBeCloseTo(8.63, 1);
    expect(row.grossYieldPct).toBeCloseTo(10.16, 1);
    expect(row.withholdingPct).toBeCloseTo(15, 5);
  });

  it('feeds the Calendar the same income and the same number of estimated payments', () => {
    const calendar = buildCalendar(calendarDataOf(hesm()), { from: TODAY, to: addIsoDays(TODAY, 365), types: ['DIVIDEND_PAY'], statuses: ['ESTIMATED'], scope: 'holdings' });
    expect(calendar.summary.annualIncome).toBeCloseTo(154.31, 1);
    expect(calendar.events.filter((e) => e.status === 'ESTIMATED')).toHaveLength(4);
    expect(calendar.events.reduce((s, e) => s + (e.expectedAmount ?? 0), 0)).toBeCloseTo(154.31, 0);
  });
});

describe('other payer shapes', () => {
  const buy = (symbol: string, currency: string, quantity: number, price: number) => tx({ symbol, currency, quantity, price });

  it('a monthly payer without any received payment is projected twelve times from the provider history', () => {
    const c: Case = { transactions: [buy('MO', 'USD', 100, 10)], quotes: [quote('MO', 10)], dividendEvents: events('MO', 12, 30, -5, [0.05]) };
    const row = rowOf(c, 'MO');
    expect(row).toMatchObject({ basis: 'provider-history', paymentsPerYear: 12, perShareAnnual: 0.6 });
    // no payment received yet: nothing observed to withhold, so the income is gross; 12 × 100 × 0.05 USD / 1.16
    expect(row.withholdingPct).toBe(0);
    expect(row.forward12m).toBeCloseTo(51.72, 2);
    expect(row.grossYieldPct).toBeCloseTo(6, 5);
  });

  it('a semi-annual payer is projected twice, valued at the latest regular amount', () => {
    const c: Case = { transactions: [buy('SA', 'USD', 100, 40)], quotes: [quote('SA', 40)], dividendEvents: events('SA', 4, 182, -30, [1, 1, 1.1, 1.2]) };
    const row = rowOf(c, 'SA');
    expect(row).toMatchObject({ basis: 'provider-history', paymentsPerYear: 2, perShareAnnual: 2.4 });
    expect(row.forward12m).toBeCloseTo(206.9, 1); // 2 × 100 × 1.2 / 1.16
  });

  it('leaves a special dividend out of the run rate', () => {
    const regular = events('HESM', 6, 91, -60, [0.8]);
    const special: DividendEvent = { symbol: 'HESM', exDate: addIsoDays(TODAY, -20), payDate: addIsoDays(TODAY, -10), amount: 4, currency: 'USD' };
    const c: Case = { transactions: [tx({})], quotes: [quote('HESM', 32)], dividendEvents: [...regular, special] };
    const row = rowOf(c, 'HESM');
    expect(row).toMatchObject({ basis: 'provider-history', paymentsPerYear: 4, perShareAnnual: 3.2 });
    expect(row.yieldPct).toBeCloseTo(row.grossYieldPct, 5); // nothing received yet, so nothing observed to withhold
  });

  it('a declared special dividend is paid but is not one of the regular payments of the year', () => {
    const declaredSpecial: DividendEvent = { symbol: 'HESM', exDate: addIsoDays(TODAY, 20), payDate: addIsoDays(TODAY, 30), amount: 4, currency: 'USD' };
    const c: Case = { transactions: [tx({})], quotes: [quote('HESM', 32)], dividendEvents: [...events('HESM', 6, 91, -60, [0.8]), declaredSpecial] };
    const row = rowOf(c, 'HESM');
    // 4 × 0.8 estimated plus the declared special 4: 7.2 USD per share × 65 / 1.16
    expect(row.forward12m).toBeCloseTo((7.2 * 65) / 1.16, 1);
    expect(row.declared).toBeCloseTo((4 * 65) / 1.16, 1);
  });

  it('flags a holding whose only evidence is one received payment instead of silently assuming it', () => {
    const c: Case = { transactions: [tx({ symbol: 'NEW', quantity: 100, price: 20 }), received('NEW', addIsoDays(TODAY, -30), 0.5, 100)], quotes: [quote('NEW', 20)], dividendEvents: [] };
    expect(rowOf(c, 'NEW')).toMatchObject({ basis: 'single-payment-assumed', paymentsPerYear: 1, perShareAnnual: 0.5 });
  });

  it('uses the owner\'s payments when the provider has no history', () => {
    const own = [-290, -200, -110, -20].map((d) => received('OWN', addIsoDays(TODAY, d), 0.4, 100));
    const c: Case = { transactions: [tx({ symbol: 'OWN', quantity: 100, price: 20 }), ...own], quotes: [quote('OWN', 20)], dividendEvents: [] };
    expect(rowOf(c, 'OWN')).toMatchObject({ basis: 'own-payments', paymentsPerYear: 4, perShareAnnual: 1.6 });
  });

  it('a London listing stored in pence is valued in pounds', () => {
    const stored: DividendEvent[] = events('LGEN.L', 4, 182, -30, [12.5], 'GBX').map((e) => majorDividend(e));
    const c: Case = { transactions: [tx({ symbol: 'LGEN.L', currency: 'GBP', quantity: 1000, price: 2.5 })], quotes: [quote('LGEN.L', 2.5, 'GBP')], dividendEvents: stored };
    const row = rowOf(c, 'LGEN.L');
    expect(row).toMatchObject({ basis: 'provider-history', paymentsPerYear: 2, perShareAnnual: 0.25 });
    // 2 × 1000 × 0.125 GBP / 0.87 EUR rate; a 10 % yield on the price of 2.50 GBP
    expect(row.forward12m).toBeCloseTo(287.36, 1);
    expect(row.grossYieldPct).toBeCloseTo(10, 5);
  });

  it('an accumulating fund that pays nothing has no row and adds no income', () => {
    const c: Case = { transactions: [buy('ACC', 'USD', 10, 100)], quotes: [quote('ACC', 100)], dividendEvents: [] };
    expect(overview(c).holdings).toEqual([]);
    expect(overview(c).summary.forward12m).toBe(0);
  });

  it('a payer whose last regular dividend is more than a year old is not projected', () => {
    const c: Case = { transactions: [buy('OLD', 'USD', 10, 100)], quotes: [quote('OLD', 100)], dividendEvents: events('OLD', 4, 91, -500, [1]) };
    expect(rowOf(c, 'OLD')).toMatchObject({ basis: 'none', forward12m: 0, paymentsPerYear: 0 });
  });

  it('shows the declared basis once every payment of the year is announced', () => {
    const c: Case = { transactions: [tx({})], quotes: [quote('HESM', 32)], dividendEvents: events('HESM', 4, 91, 340, [0.8]).map((e, i) => ({ ...e, exDate: addIsoDays(TODAY, 20 + 91 * i), payDate: addIsoDays(TODAY, 30 + 91 * i) })).filter((e) => e.exDate <= addIsoDays(TODAY, 365)) };
    const row = rowOf(c, 'HESM');
    expect(row.estimated).toBe(0);
    expect(row.basis).toBe('declared');
  });

  it('withholds a new US payer like the US payers already paid, and shows both yields', () => {
    const c: Case = {
      transactions: [tx({}), received('HESM', addIsoDays(TODAY, -2), 0.81, 65), tx({ symbol: 'KO', quantity: 10, price: 60 })],
      quotes: [quote('HESM', 31.89), quote('KO', 60)],
      dividendEvents: [...events('HESM', 8, 91, -12, HESM_AMOUNTS), ...events('KO', 4, 91, -12, [0.5])],
    };
    const ko = rowOf(c, 'KO');
    expect(ko.withholdingPct).toBeCloseTo(15, 5);
    expect(ko.yieldPct).toBeCloseTo(ko.grossYieldPct * 0.85, 1);
    expect(overview(c).summary.grossYieldOnValuePct).toBeGreaterThan(overview(c).summary.yieldOnValuePct);
  });

  it('keeps the schedule of the estimated payments in line with the forward income', () => {
    const o = overview(hesm());
    const estimated = o.futureMonths.reduce((s, m) => s + m.estimated, 0);
    expect(estimated).toBeCloseTo(o.summary.estimated, 1);
    expect(o.futureMonths.filter((m) => m.estimated > 0)).toHaveLength(4);
  });
});
