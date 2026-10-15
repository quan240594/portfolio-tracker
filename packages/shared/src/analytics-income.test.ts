import { describe, expect, it } from 'vitest';
import { FxTimeline } from './fx.js';
import { calculateDividendGrowth, calculatePassiveIncome, paymentsPerYear } from './analytics-income.js';
import { calculatePortfolio } from './portfolio.js';
import type { DividendEvent, FxRates, InstrumentProfile, Quote, Transaction } from './types.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-01-10T00:00:00Z' };
const timeline = new FxTimeline(fx);
const TODAY = '2026-01-10';
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2025-01-02',
  type: 'BUY',
  symbol: 'VWRL.AS',
  quantity: 100,
  price: 100,
  fee: 0,
  currency: 'EUR',
  createdAt: `2025-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
const div = (date: string, p: Partial<Transaction> = {}) => tx({ type: 'DIVIDEND', date, price: 0.5, fee: 7.5, ...p });
const quote = (symbol: string, price: number, currency = 'EUR'): Quote => ({ symbol, price, previousClose: price, currency, asOf: TODAY, source: 't' });
const profile = (symbol: string, currency = 'EUR'): InstrumentProfile => ({ symbol, name: `${symbol} name`, assetClass: 'STOCK', currency });

function income(transactions: Transaction[], events: DividendEvent[], quotes: Quote[]) {
  const { holdings } = calculatePortfolio({
    transactions,
    quotes: Object.fromEntries(quotes.map((q) => [q.symbol, q])),
    profiles: Object.fromEntries(quotes.map((q) => [q.symbol, profile(q.symbol, q.currency)])),
    fx,
    now: new Date(`${TODAY}T12:00:00Z`),
  });
  return calculatePassiveIncome(holdings, transactions, events, timeline, TODAY);
}

describe('paymentsPerYear', () => {
  it('derives the frequency from the median gap', () => {
    expect(paymentsPerYear([])).toBe(1);
    expect(paymentsPerYear(['2025-03-15'])).toBe(1);
    expect(paymentsPerYear(['2025-01-15', '2025-02-14', '2025-03-16', '2025-04-15'])).toBe(12);
    expect(paymentsPerYear(['2025-03-15', '2025-06-15', '2025-09-15'])).toBe(4);
    expect(paymentsPerYear(['2025-03-15', '2025-09-15'])).toBe(2);
    expect(paymentsPerYear(['2024-03-15', '2025-03-15'])).toBe(1);
  });
  it('looks at the last five payments only', () => {
    const dates = ['2020-01-01', '2021-01-01', '2022-01-01', '2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15'];
    expect(paymentsPerYear(dates)).toBe(4);
  });
});

describe('calculatePassiveIncome', () => {
  const quarterly = [tx({}), div('2025-03-15'), div('2025-06-15'), div('2025-09-15'), div('2025-12-15')];

  it('adds declared events and the payments the history still implies, net of withholding', () => {
    const events: DividendEvent[] = [
      { symbol: 'VWRL.AS', exDate: '2026-03-01', payDate: '2026-03-15', amount: 0.5, currency: 'EUR' },
      { symbol: 'VWRL.AS', exDate: '2025-12-01', amount: 0.5, currency: 'EUR' },
      { symbol: 'VWRL.AS', exDate: '2027-03-01', amount: 0.5, currency: 'EUR' },
      { symbol: 'OTHER', exDate: '2026-03-01', amount: 9, currency: 'EUR' },
    ];
    const r = income(quarterly, events, [quote('VWRL.AS', 100)]);
    // gross per payment 100 × 0.5 = 50, 15 % withheld → 42.5 net; 1 declared + 3 estimated
    expect(r).toMatchObject({ baseCurrency: 'EUR', declared: 42.5, estimated: 127.5, forward12m: 170 });
    expect(r.yieldOnValuePct).toBe(1.7);
    expect(r.yieldOnCostPct).toBe(1.7);
    expect(r.holdings).toEqual([
      { symbol: 'VWRL.AS', name: 'VWRL.AS name', declared: 42.5, estimated: 127.5, total: 170, sharePct: 100, yieldPct: 1.7, yieldOnCostPct: 1.7 },
    ]);
  });

  it('shares income across holdings, largest first, and ignores payers that stopped', () => {
    const txns = [
      ...quarterly,
      tx({ symbol: 'ANN', quantity: 50, price: 40 }),
      div('2025-04-01', { symbol: 'ANN', quantity: 50, price: 2, fee: 0 }),
      tx({ symbol: 'OLD', quantity: 10, price: 10 }),
      div('2024-01-01', { symbol: 'OLD', quantity: 10, price: 1, fee: 0 }),
      tx({ symbol: 'NEW', quantity: 10, price: 10 }),
      tx({ symbol: 'NONE', quantity: 10, price: 10 }),
    ];
    const events: DividendEvent[] = [{ symbol: 'NEW', exDate: '2026-02-01', amount: 1, currency: 'EUR' }];
    const quotes = ['VWRL.AS', 'ANN', 'OLD', 'NEW', 'NONE'].map((s) => quote(s, 100));
    const r = income(txns, events, quotes);
    expect(r.holdings.map((h) => [h.symbol, h.total, h.sharePct])).toEqual([
      ['VWRL.AS', 170, 60.71],
      ['ANN', 100, 35.71],
      ['NEW', 10, 3.57],
    ]);
    expect(r.estimated).toBe(270);
    expect(r.declared).toBe(10);
  });

  it('converts foreign dividends at the latest rate', () => {
    const txns = [tx({ symbol: 'KO', currency: 'USD', quantity: 10, price: 50 }), div('2025-10-01', { symbol: 'KO', currency: 'USD', quantity: 10, price: 0.5, fee: 0 })];
    const events: DividendEvent[] = [{ symbol: 'KO', exDate: '2026-02-01', amount: 0.5, currency: 'USD' }];
    const r = income(txns, events, [quote('KO', 50, 'USD')]);
    // 10 × 0.5 USD = 5 USD = 4 EUR declared, estimated annual payer → nothing more
    expect(r.declared).toBe(4);
    expect(r.estimated).toBe(0);
  });

  it('does not withhold anything without history and handles an empty portfolio', () => {
    const r = income([tx({ symbol: 'NEW', quantity: 10, price: 10 })], [{ symbol: 'NEW', exDate: '2026-02-01', amount: 1, currency: 'EUR' }], [quote('NEW', 10)]);
    expect(r.forward12m).toBe(10);
    expect(income([], [], [])).toMatchObject({ forward12m: 0, yieldOnValuePct: 0, yieldOnCostPct: 0, holdings: [] });
  });

  it('is zero when the holdings never paid and nothing is declared', () => {
    expect(income([tx({ symbol: 'GROW' })], [], [quote('GROW', 100)]).holdings).toEqual([]);
  });
});

describe('calculateDividendGrowth', () => {
  const txns = [
    tx({ symbol: 'AAA', quantity: 10 }),
    div('2024-03-10', { symbol: 'AAA', quantity: 10, price: 1, fee: 0 }),
    div('2025-03-10', { symbol: 'AAA', quantity: 10, price: 1.2, fee: 0 }),
    div('2025-09-10', { symbol: 'AAA', quantity: 10, price: 1.2, fee: 0 }),
    div('2026-03-10', { symbol: 'AAA', quantity: 10, price: 1.5, fee: 0 }),
    div('2025-03-20', { symbol: 'BBB', currency: 'USD', quantity: 10, price: 2, fee: 2.5, fxRate: 1.25 }),
  ];
  const g = calculateDividendGrowth(txns, timeline, '2026-04-01');

  it('groups per year with year-over-year growth and flags the running year', () => {
    expect(g.baseCurrency).toBe('EUR');
    expect(g.byYear).toEqual([
      { year: '2024', total: 10, payments: 1, yoyPct: null, partial: false },
      { year: '2025', total: 24 + 14, payments: 3, yoyPct: 280, partial: false },
      { year: '2026', total: 15, payments: 1, yoyPct: -60.53, partial: true },
    ]);
  });

  it('fills the months between the first and last payment', () => {
    expect(g.byMonth).toHaveLength(25);
    expect(g.byMonth[0]).toEqual({ month: '2024-03', total: 10, previousYearTotal: 0, yoyPct: null });
    expect(g.byMonth[12]).toEqual({ month: '2025-03', total: 12 + 14, previousYearTotal: 10, yoyPct: 160 });
    expect(g.byMonth[13]).toEqual({ month: '2025-04', total: 0, previousYearTotal: 0, yoyPct: null });
    expect(g.byMonth[24]).toEqual({ month: '2026-03', total: 15, previousYearTotal: 26, yoyPct: -42.31 });
    expect(g.byMonth.map((m) => m.month).slice(8, 11)).toEqual(['2024-11', '2024-12', '2025-01']);
  });

  it('tracks per-share growth per symbol', () => {
    expect(g.perShare).toEqual([
      {
        symbol: 'AAA',
        currency: 'EUR',
        years: [
          { year: '2024', perShare: 1, yoyPct: null, partial: false },
          { year: '2025', perShare: 2.4, yoyPct: 140, partial: false },
          { year: '2026', perShare: 1.5, yoyPct: -37.5, partial: true },
        ],
      },
      { symbol: 'BBB', currency: 'USD', years: [{ year: '2025', perShare: 2, yoyPct: null, partial: false }] },
    ]);
  });

  it('gives no growth across a gap year and handles no dividends', () => {
    const gap = calculateDividendGrowth([div('2023-05-01', { fee: 0 }), div('2025-05-01', { fee: 0 })], timeline, TODAY);
    expect(gap.byYear.map((y) => y.yoyPct)).toEqual([null, null]);
    expect(calculateDividendGrowth([tx({})], timeline, TODAY)).toEqual({
      baseCurrency: 'EUR',
      byYear: [],
      byMonth: [],
      perShare: [],
      growthStats: { asOf: TODAY, qoq: null, yoy: null, cagr: null },
    });
  });

  it('adds growth stats built from the same monthly totals', () => {
    // 2026-04-01: latest complete quarter Q1 2026 (15) vs Q4 2025 (0); first complete year 2024 (10) → 2025 (38)
    expect(g.growthStats).toMatchObject({
      asOf: '2026-04-01',
      qoq: { current: { from: '2026-01', to: '2026-03', amount: 15 }, previous: { amount: 0 }, change: 15, pct: null },
      yoy: { basis: 'TTM', current: { from: '2025-04', to: '2026-03', amount: 27 }, previous: { from: '2024-04', to: '2025-03', amount: 26 }, change: 1, pct: 3.85 },
      cagr: { startYear: 2024, endYear: 2025, startAmount: 10, endAmount: 38, years: 1, pct: 280 },
    });
  });
});
