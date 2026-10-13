import { describe, expect, it } from 'vitest';
import {
  buildPositions,
  buildValueHistory,
  calculateAllocation,
  calculateDividends,
  calculatePortfolio,
  PortfolioError,
} from './portfolio.js';
import { toBase, MissingFxRateError } from './fx.js';
import type { FxRates, Transaction } from './types.js';
import { csvRowSchema, parseImportObjectKey, importObjectKey } from './index.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-01-01T00:00:00Z' };
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  date: '2026-01-02',
  type: 'BUY',
  symbol: 'AAPL',
  quantity: 1,
  price: 100,
  fee: 0,
  currency: 'USD',
  createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
  ...p,
});

describe('fx', () => {
  it('converts to base and passes through base currency', () => {
    expect(toBase(110, 'USD', fx)).toBeCloseTo(100);
    expect(toBase(50, 'EUR', fx)).toBe(50);
  });
  it('throws on unknown currency', () => {
    expect(() => toBase(1, 'JPY', fx)).toThrow(MissingFxRateError);
  });
});

describe('buildPositions', () => {
  it('uses average cost and realizes P&L on sell', () => {
    const p = buildPositions([
      tx({ quantity: 10, price: 100, fee: 10 }),
      tx({ date: '2026-02-01', quantity: 10, price: 200 }),
      tx({ date: '2026-03-01', type: 'SELL', quantity: 5, price: 300, fee: 5 }),
    ]).get('AAPL')!;
    // avg = (1010 + 2000) / 20 = 150.5 ; realized = 1500 - 5 - 752.5 = 742.5
    expect(p.quantity).toBe(15);
    expect(p.costLocal).toBeCloseTo(2257.5);
    expect(p.realizedPnlLocal).toBeCloseTo(742.5);
  });
  it('rejects overselling', () => {
    expect(() => buildPositions([tx({ quantity: 1 }), tx({ type: 'SELL', quantity: 2, date: '2026-01-03' })])).toThrow(PortfolioError);
  });
  it('respects asOfDate', () => {
    const p = buildPositions([tx({ quantity: 1 }), tx({ quantity: 1, date: '2026-05-01' })], '2026-03-01');
    expect(p.get('AAPL')!.quantity).toBe(1);
  });
});

describe('calculatePortfolio', () => {
  it('computes summary, weights and day change in base currency', () => {
    const { summary, holdings } = calculatePortfolio({
      transactions: [
        tx({ quantity: 10, price: 100 }),
        tx({ symbol: 'ASML', currency: 'EUR', quantity: 1, price: 600 }),
        tx({ type: 'DIVIDEND', quantity: 10, price: 1.1, fee: 0, date: '2026-02-01' }),
      ],
      quotes: {
        AAPL: { symbol: 'AAPL', price: 121, previousClose: 110, currency: 'USD', asOf: '', source: 't' },
      },
      profiles: { AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', sector: 'Tech', country: 'US', currency: 'USD' } },
      fx,
      now: new Date('2026-03-01T00:00:00Z'),
    });
    expect(summary.totalValue).toBeCloseTo(1100 + 600);
    expect(summary.totalCost).toBeCloseTo(909.09 + 600, 1);
    expect(summary.dividendsReceived).toBe(10);
    expect(summary.dayChange).toBe(100);
    expect(holdings[0]!.symbol).toBe('AAPL');
    expect(holdings[0]!.weight + holdings[1]!.weight).toBeCloseTo(1);
    const asml = holdings.find((h) => h.symbol === 'ASML')!;
    expect(asml.priceStale).toBe(true);
    expect(asml.name).toBe('ASML');
    expect(asml.assetClass).toBe('OTHER');
  });
  it('excludes closed positions but keeps realized P&L', () => {
    const { summary, holdings } = calculatePortfolio({
      transactions: [tx({ quantity: 1, price: 110 }), tx({ type: 'SELL', quantity: 1, price: 220, date: '2026-02-01' })],
      quotes: {},
      profiles: {},
      fx,
    });
    expect(holdings).toHaveLength(0);
    expect(summary.realizedPnl).toBe(100);
  });
});

describe('calculateAllocation', () => {
  it('groups and weights by dimension', () => {
    const { holdings } = calculatePortfolio({
      transactions: [tx({ currency: 'EUR', price: 300 }), tx({ symbol: 'B', currency: 'EUR', price: 100 })],
      quotes: {},
      profiles: {},
      fx,
    });
    const slices = calculateAllocation(holdings, 'currency');
    expect(slices).toEqual([{ key: 'EUR', label: 'EUR', value: 400, weight: 1 }]);
  });
});

describe('buildValueHistory', () => {
  it('carries forward closes over gaps and starts at first transaction', () => {
    const points = buildValueHistory(
      [tx({ currency: 'EUR', quantity: 2, price: 10, date: '2026-01-02' })],
      { AAPL: [{ symbol: 'AAPL', date: '2026-01-02', close: 11, currency: 'EUR' }, { symbol: 'AAPL', date: '2026-01-04', close: 15, currency: 'EUR' }] },
      fx,
      '2026-01-01',
      '2026-01-04',
    );
    expect(points.map((p) => p.value)).toEqual([22, 22, 30]);
    expect(points[0]!.date).toBe('2026-01-02');
    expect(points.every((p) => p.invested === 20)).toBe(true);
  });
});

describe('calculateDividends', () => {
  it('splits received and upcoming and buckets per month', () => {
    const overview = calculateDividends(
      [tx({ currency: 'EUR', quantity: 10 }), tx({ type: 'DIVIDEND', currency: 'EUR', quantity: 10, price: 0.5, fee: 1, date: '2026-03-10' })],
      [{ symbol: 'AAPL', exDate: '2026-06-01', payDate: '2026-06-15', amount: 0.6, currency: 'EUR' }],
      fx,
      '2026-04-01',
    );
    expect(overview.totalReceived).toBe(4);
    expect(overview.upcoming[0]).toMatchObject({ date: '2026-06-15', amount: 6 });
    expect(overview.monthly).toEqual([
      { month: '2026-03', received: 4, upcoming: 0 },
      { month: '2026-06', received: 0, upcoming: 6 },
    ]);
    expect(overview.projectedNext12Months).toBe(6);
  });
});

describe('schemas & keys', () => {
  it('normalises CSV rows', () => {
    const row = csvRowSchema.parse({ date: '2026-01-02', type: 'buy', symbol: 'asml.as', quantity: '2', price: '600.5', fee: '', currency: 'eur', note: '' });
    expect(row).toEqual({ date: '2026-01-02', type: 'BUY', symbol: 'ASML.AS', quantity: 2, price: 600.5, fee: 0, currency: 'EUR' });
  });
  it('rejects invalid rows', () => {
    expect(csvRowSchema.safeParse({ date: '02-01-2026', type: 'HOLD', symbol: '', quantity: '-1', price: 'x', currency: 'E' }).success).toBe(false);
  });
  it('round-trips import object keys', () => {
    expect(parseImportObjectKey(importObjectKey('demo', 'abc'))).toEqual({ userId: 'demo', importId: 'abc' });
    expect(parseImportObjectKey('other/x.csv')).toBeNull();
  });
});

describe('validation & performance regressions', () => {
  it('rejects impossible calendar dates', () => {
    const base = { type: 'BUY', symbol: 'A', quantity: 1, price: 1, currency: 'EUR' };
    expect(csvRowSchema.safeParse({ ...base, date: '2025-13-40' }).success).toBe(false);
    expect(csvRowSchema.safeParse({ ...base, date: '2025-02-29' }).success).toBe(false);
    expect(csvRowSchema.safeParse({ ...base, date: '2024-02-29' }).success).toBe(true);
  });
  it('builds multi-year history for many transactions quickly and matches point-in-time positions', () => {
    const txns = Array.from({ length: 2000 }, (_, i) =>
      tx({ currency: 'EUR', symbol: `S${i % 20}`, quantity: 1, price: 10, date: new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10) }),
    );
    const t0 = performance.now();
    const points = buildValueHistory(txns, {}, fx, '2021-01-01', '2026-06-30');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(points.at(-1)!.invested).toBe(20000);
    const mid = points.find((p) => p.date === '2022-06-15')!;
    const expected = [...buildPositions(txns, '2022-06-15').values()].reduce((s, p) => s + p.costLocal, 0);
    expect(mid.invested).toBeCloseTo(expected);
  });
});
