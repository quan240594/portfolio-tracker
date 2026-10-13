import { describe, expect, it } from 'vitest';
import {
  ENTITY,
  buildPositions,
  buildValueHistory,
  calculateAllocation,
  calculateDividends,
  calculatePortfolio,
  csvRowSchema,
  historyRangeStart,
  importObjectKey,
  keys,
  parseImportObjectKey,
  PortfolioError,
  transactionInputSchema,
} from './index.js';
import type { FxRates, Transaction } from './types.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 2 }, asOf: '2026-01-01T00:00:00Z' };
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `g${++seq}`,
  userId: 'u',
  portfolioId: 'default',
  date: '2026-01-02',
  type: 'BUY',
  symbol: 'A',
  quantity: 1,
  price: 10,
  fee: 0,
  currency: 'EUR',
  createdAt: `2026-01-01T00:00:00.${String(seq).padStart(3, '0')}Z`,
  ...p,
});

describe('keys', () => {
  it('builds every single-table key in the documented format', () => {
    expect(keys.user('u')).toEqual({ PK: 'USER#u' });
    expect(keys.transaction('u', 'p1', '2026-01-02', 't1')).toEqual({ PK: 'USER#u', SK: 'TXN#p1#2026-01-02#t1' });
    expect(keys.import('u', 'i1')).toEqual({ PK: 'USER#u', SK: 'IMPORT#i1' });
    expect(keys.userRegistry('u')).toEqual({ PK: 'USERS', SK: 'USER#u' });
    expect(keys.trackedTicker('AAPL')).toEqual({ PK: 'TRACKED', SK: 'TICKER#AAPL' });
    expect(keys.quote('AAPL')).toEqual({ PK: 'TICKER#AAPL', SK: 'QUOTE#LATEST' });
    expect(keys.eod('AAPL', '2026-01-02')).toEqual({ PK: 'TICKER#AAPL', SK: 'EOD#2026-01-02' });
    expect(keys.profile('AAPL')).toEqual({ PK: 'TICKER#AAPL', SK: 'PROFILE' });
    expect(keys.dividendEvent('AAPL', '2026-03-01')).toEqual({ PK: 'TICKER#AAPL', SK: 'DIV#2026-03-01' });
    expect(keys.tickerPk('AAPL')).toBe('TICKER#AAPL');
    expect(keys.fx('EUR')).toEqual({ PK: 'FX#EUR', SK: 'LATEST' });
    expect([keys.transactionPrefix, keys.eodPrefix, keys.dividendPrefix, keys.trackedPk]).toEqual(['TXN#', 'EOD#', 'DIV#', 'TRACKED']);
    expect(ENTITY.dividendEvent).toBe('DIVIDEND_EVENT');
  });
  it('decodes URL-encoded import object keys', () => {
    expect(parseImportObjectKey(encodeURIComponent(importObjectKey('a b', 'x')))).toEqual({ userId: 'a b', importId: 'x' });
  });
});

describe('historyRangeStart', () => {
  const today = '2026-03-31';
  it.each([
    ['1M', '2026-03-01'],
    ['3M', '2025-12-30'],
    ['6M', '2025-09-30'],
    ['YTD', '2026-01-01'],
    ['1Y', '2025-03-31'],
  ] as const)('%s starts at %s', (range, expected) => {
    expect(historyRangeStart(range, today)).toBe(expected);
  });
  it('ALL uses the first transaction date, else falls back to one year', () => {
    expect(historyRangeStart('ALL', today, '2020-05-05')).toBe('2020-05-05');
    expect(historyRangeStart('ALL', today)).toBe('2025-03-31');
  });
});

describe('engine edge cases', () => {
  it('rejects mixed currencies for one symbol', () => {
    expect(() => buildPositions([tx({}), tx({ currency: 'USD', date: '2026-01-03' })])).toThrow(PortfolioError);
  });
  it('sells from a zero-cost position and orders same-day trades by createdAt', () => {
    const p = buildPositions([
      tx({ type: 'SELL', quantity: 1, price: 5, createdAt: '2026-01-01T00:00:02Z' }),
      tx({ quantity: 1, price: 0, createdAt: '2026-01-01T00:00:01Z' }),
    ]).get('A')!;
    expect(p.quantity).toBe(0);
    expect(p.realizedPnlLocal).toBe(5);
  });
  it('returns zero percentages and weights for an all-zero portfolio', () => {
    const { summary, holdings } = calculatePortfolio({ transactions: [tx({ price: 0 })], quotes: {}, profiles: {}, fx });
    expect(summary).toMatchObject({ totalValue: 0, unrealizedPnlPct: 0, totalReturnPct: 0, dayChangePct: 0 });
    expect(holdings[0]!.weight).toBe(0);
    expect(calculateAllocation(holdings, 'sector')).toEqual([{ key: 'Unknown', label: 'Unknown', value: 0, weight: 0 }]);
  });
  it('labels symbol allocation with name and converts quotes in another currency', () => {
    const { holdings } = calculatePortfolio({
      transactions: [tx({ symbol: 'B', currency: 'USD', price: 20 })],
      quotes: { B: { symbol: 'B', price: 40, previousClose: 40, currency: 'USD', asOf: '', source: 't' } },
      profiles: { B: { symbol: 'B', name: 'Bee', assetClass: 'ETF', currency: 'USD' } },
      fx,
    });
    expect(holdings[0]).toMatchObject({ marketValue: 20, costBasis: 10, sector: 'Unknown', country: 'Unknown' });
    expect(calculateAllocation(holdings, 'symbol')[0]!.label).toBe('B · Bee');
  });
  it('history: empty input, inverted range, carry-forward seeding from before start, closed positions', () => {
    expect(buildValueHistory([], {}, fx, '2026-01-01', '2026-01-02')).toEqual([]);
    expect(buildValueHistory([tx({})], {}, fx, '2026-02-01', '2026-01-01')).toEqual([]);
    const txns = [tx({ date: '2025-12-01', quantity: 2 }), tx({ symbol: 'Z', date: '2025-12-01' }), tx({ symbol: 'Z', type: 'SELL', date: '2025-12-15' })];
    const eod = {
      A: [
        { symbol: 'A', date: '2025-12-20', close: 12, currency: 'EUR' },
        { symbol: 'A', date: '2025-11-01', close: 99, currency: 'EUR' },
      ],
    };
    const points = buildValueHistory(txns, eod, fx, '2026-01-01', '2026-01-02');
    expect(points).toEqual([
      { date: '2026-01-01', value: 24, invested: 20 },
      { date: '2026-01-02', value: 24, invested: 20 },
    ]);
  });
  it('dividends: ignores events for unheld symbols and past ex-dates, falls back to exDate without payDate', () => {
    const overview = calculateDividends(
      [tx({ quantity: 4 })],
      [
        { symbol: 'A', exDate: '2026-05-01', amount: 1, currency: 'EUR' },
        { symbol: 'A', exDate: '2026-01-01', amount: 1, currency: 'EUR' },
        { symbol: 'NOPE', exDate: '2026-06-01', amount: 1, currency: 'EUR' },
      ],
      fx,
      '2026-02-01',
    );
    expect(overview.upcoming).toEqual([{ symbol: 'A', date: '2026-05-01', perShareLocal: 1, currency: 'EUR', amount: 4, status: 'UPCOMING' }]);
    expect(overview.received).toEqual([]);
    expect(calculateDividends([], [], fx).monthly).toEqual([]);
  });
});

describe('schemas', () => {
  it('defaults fee and accepts null/undefined fee in CSV rows', () => {
    const row = { date: '2026-01-02', type: 'sell', symbol: 'a', quantity: '1', price: '1', currency: 'usd' };
    expect(csvRowSchema.parse({ ...row, fee: null }).fee).toBe(0);
    expect(csvRowSchema.parse(row).fee).toBe(0);
    expect(csvRowSchema.parse({ ...row, note: 'hi' }).note).toBe('hi');
    expect(transactionInputSchema.parse({ ...row, portfolioId: 'default', type: 'SELL' }).fee).toBe(0);
  });
  it('rejects bad symbols and currencies', () => {
    const row = { date: '2026-01-02', type: 'BUY', quantity: 1, price: 1, currency: 'EUR' };
    expect(transactionInputSchema.safeParse({ ...row, portfolioId: 'default', symbol: 'BAD SYMBOL' }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...row, portfolioId: 'default', symbol: 'A', currency: 'EURO' }).success).toBe(false);
  });
});
