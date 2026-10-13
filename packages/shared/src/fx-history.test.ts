import { describe, expect, it } from 'vitest';
import {
  FxTimeline,
  MissingFxRateError,
  buildPositions,
  buildValueHistory,
  calculateDividends,
  calculatePortfolio,
  csvRowSchema,
  keys,
  transactionInputSchema,
} from './index.js';
import type { FxDay, FxRates, Transaction } from './types.js';

const latest: FxRates = { base: 'EUR', rates: { USD: 1.17 }, asOf: '2026-10-13T00:00:00Z' };
const history: FxDay[] = [
  { base: 'EUR', date: '2025-01-02', rates: { USD: 1.04 } },
  { base: 'EUR', date: '2025-01-03', rates: { USD: 1.03 } }, // Friday
  { base: 'EUR', date: '2025-06-02', rates: { USD: 1.1 } },
  { base: 'EUR', date: '2025-09-01', rates: { USD: 1.08 } },
];
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `f${++seq}`,
  userId: 'u',
  date: '2025-01-02',
  type: 'BUY',
  symbol: 'AAPL',
  quantity: 10,
  price: 100,
  fee: 0,
  currency: 'USD',
  createdAt: `2025-01-01T00:00:00.${String(seq).padStart(3, '0')}Z`,
  ...p,
});

describe('FxTimeline', () => {
  const t = new FxTimeline(latest, [...history, { base: 'USD', date: '2025-01-02', rates: { EUR: 9 } }, { base: 'EUR', date: '2025-01-06', rates: { USD: 0 } }]);
  it('uses the fixing of the date, carries it over weekends, and ignores other bases / bad rates', () => {
    expect(t.rate('USD', '2025-01-02')).toBe(1.04);
    expect(t.rate('USD', '2025-01-05')).toBe(1.03); // Sunday -> Friday's fixing
    expect(t.rate('USD', '2025-01-06')).toBe(1.03); // zero rate ignored
    expect(t.rate('USD', '2026-01-01')).toBe(1.08);
  });
  it('uses the earliest fixing before history, the latest rate without a date; base is 1', () => {
    expect(t.rate('USD', '2024-12-31')).toBe(1.04);
    expect(new FxTimeline(latest, []).rate('USD', '2024-12-31')).toBe(1.17);
    expect(t.rate('USD')).toBe(1.17);
    expect(t.rate('EUR', '2025-01-02')).toBe(1);
    expect(t.toBase(104, 'USD', '2025-01-02')).toBeCloseTo(100);
  });
  it('throws when a currency is unknown everywhere', () => {
    expect(() => t.rate('JPY', '2025-01-02')).toThrow(MissingFxRateError);
  });
});

describe('historical cost basis in EUR', () => {
  const quote = { symbol: 'AAPL', price: 120, previousClose: 120, currency: 'USD', asOf: '', source: 't' };

  it('converts purchases at the trade-date rate and splits price vs currency effect', () => {
    const { holdings, summary } = calculatePortfolio({ transactions: [tx({})], quotes: { AAPL: quote }, profiles: {}, fx: latest, fxHistory: history });
    const h = holdings[0]!;
    expect(h.costBasis).toBeCloseTo(961.54, 2);
    expect(h.marketValue).toBeCloseTo(1025.64, 2);
    expect(h.unrealizedPnl).toBeCloseTo(64.1, 1);
    expect(h.currencyEffect).toBeCloseTo(-128.21, 1);
    expect(h.averageCostBase).toBeCloseTo(96.1538, 3);
    expect(h.priceBase).toBeCloseTo(102.5641, 3);
    expect(summary.currencyEffect).toBeCloseTo(-128.21, 1);
    expect(summary.totalReturnPct).toBeCloseTo((64.1 / 961.54) * 100, 1);
  });

  it('prefers the broker-reported fxRate over the ECB fixing', () => {
    const { holdings } = calculatePortfolio({ transactions: [tx({ fxRate: 1.05 })], quotes: { AAPL: quote }, profiles: {}, fx: latest, fxHistory: history });
    expect(holdings[0]!.costBasis).toBeCloseTo(952.38, 2);
  });

  it('realizes P&L in EUR at the sell-date rate against the historical cost', () => {
    const txns = [tx({}), tx({ type: 'SELL', quantity: 5, price: 130, date: '2025-06-02' })];
    const { summary } = calculatePortfolio({ transactions: txns, quotes: { AAPL: quote }, profiles: {}, fx: latest, fxHistory: history });
    // proceeds 650 / 1.10 = 590.91; removed cost 961.54 / 2 = 480.77
    expect(summary.realizedPnl).toBeCloseTo(110.14, 1);
    const p = buildPositions(txns).get('AAPL')!;
    expect(p.realizedPnlLocal).toBeCloseTo(150);
  });

  it('converts received dividends at their pay-date rate', () => {
    const div = tx({ type: 'DIVIDEND', quantity: 10, price: 0.27, date: '2025-09-01' });
    const overview = calculateDividends([tx({}), div], [], latest, '2026-10-13', history);
    expect(overview.received[0]!.amount).toBeCloseTo(2.5, 2); // 2.70 USD / 1.08
    const { summary } = calculatePortfolio({ transactions: [tx({}), div], quotes: {}, profiles: {}, fx: latest, fxHistory: history });
    expect(summary.dividendsReceived).toBeCloseTo(2.5, 2);
  });

  it('values history at each day\'s fixing with invested at historical cost', () => {
    const eod = { AAPL: [{ symbol: 'AAPL', date: '2025-01-02', close: 104, currency: 'USD' }, { symbol: 'AAPL', date: '2025-01-03', close: 103, currency: 'USD' }] };
    const points = buildValueHistory([tx({})], eod, latest, '2025-01-02', '2025-01-03', history);
    expect(points).toEqual([
      { date: '2025-01-02', value: 1000, invested: 961.54 },
      { date: '2025-01-03', value: 1000, invested: 961.54 },
    ]);
  });

  it('reports no currency effect for base-currency holdings or when quote currency differs', () => {
    const eurTx = tx({ symbol: 'ASML.AS', currency: 'EUR', price: 600, quantity: 1 });
    const { holdings } = calculatePortfolio({
      transactions: [eurTx, tx({ symbol: 'X' })],
      quotes: {
        'ASML.AS': { symbol: 'ASML.AS', price: 700, previousClose: 700, currency: 'EUR', asOf: '', source: 't' },
        X: { symbol: 'X', price: 1, previousClose: 1, currency: 'EUR', asOf: '', source: 't' },
      },
      profiles: {},
      fx: latest,
      fxHistory: history,
    });
    expect(holdings.find((h) => h.symbol === 'ASML.AS')!.currencyEffect).toBe(0);
    expect(holdings.find((h) => h.symbol === 'X')!.currencyEffect).toBe(0);
  });
});

describe('contract additions', () => {
  it('fx day keys', () => {
    expect(keys.fxDay('EUR', '2025-01-02')).toEqual({ PK: 'FX#EUR', SK: 'DAY#2025-01-02' });
    expect(keys.fxDayPrefix).toBe('DAY#');
  });
  it('accepts an optional positive fxRate on input and CSV', () => {
    const base = { date: '2025-01-02', type: 'BUY', symbol: 'AAPL', quantity: '1', price: '1', currency: 'USD' };
    expect(transactionInputSchema.parse({ ...base, fxRate: '1.0842' }).fxRate).toBe(1.0842);
    expect(csvRowSchema.parse({ ...base, fxRate: '' }).fxRate).toBeUndefined();
    expect(csvRowSchema.safeParse({ ...base, fxRate: '-1' }).success).toBe(false);
    expect(transactionInputSchema.parse({ ...base, fxRate: '' }).fxRate).toBeUndefined();
    expect(transactionInputSchema.parse({ ...base, fxRate: null }).fxRate).toBeUndefined();
    expect(transactionInputSchema.safeParse({ ...base, fxRate: 0 }).success).toBe(false);
  });
});
