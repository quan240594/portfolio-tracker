import { describe, expect, it } from 'vitest';
import { PortfolioError } from './portfolio.js';
import { calculateRebalance, rebalanceTradesToCsv, type RebalanceCategory, type RebalanceHolding } from './rebalance.js';

const cat = (categoryId: string, targetWeight: number, extra: Partial<RebalanceCategory> = {}): RebalanceCategory => ({
  categoryId,
  name: categoryId.toUpperCase(),
  targetWeight,
  ...extra,
});
const hold = (symbol: string, categoryId: string | null, marketValue: number, priceBase = 100, tradable = true): RebalanceHolding => ({
  symbol,
  name: `${symbol} name`,
  categoryId,
  marketValue,
  priceBase,
  tradable,
});

const base = [hold('A', 'c1', 6000), hold('B', 'c2', 3000), hold('C', 'c3', 1000)];
const cats = [cat('c1', 50, { color: '#111111' }), cat('c2', 30), cat('c3', 20)];

describe('calculateRebalance: full', () => {
  it('sells the overweight category and buys the underweight one', () => {
    const r = calculateRebalance({ holdings: base, categories: cats, mode: 'full' });
    expect(r.totalBefore).toBe(10000);
    expect(r.basis).toBe(10000);
    expect(r.trades).toEqual([
      { symbol: 'A', name: 'A name', categoryId: 'c1', action: 'SELL', units: 10, price: 100, value: 1000 },
      { symbol: 'C', name: 'C name', categoryId: 'c3', action: 'BUY', units: 10, price: 100, value: 1000 },
    ]);
    expect(r.leftoverCash).toBe(0);
    const [c1, c2, c3] = r.rows;
    expect(c1).toMatchObject({ color: '#111111', weightBefore: 60, driftBefore: 10, driftValueBefore: 1000, valueAfter: 5000, weightAfter: 50, driftAfter: 0 });
    expect(c2).toMatchObject({ weightBefore: 30, driftBefore: 0, driftAfter: 0 });
    expect(c3).toMatchObject({ weightBefore: 10, driftBefore: -10, driftValueBefore: -1000, valueAfter: 2000, driftValueAfter: 0 });
    expect(r.unallocated).toMatchObject({ categoryId: null, targetWeight: 0, valueBefore: 0 });
  });

  it('invests extra money on top of the sale proceeds', () => {
    const r = calculateRebalance({ holdings: base, categories: cats, mode: 'full', amount: 1000 });
    // basis 11000: targets 5500 / 3300 / 2200 -> sell 500 of A, buy 300 of B and 1200 of C with 500 + 1000
    expect(r.trades.map((t) => [t.symbol, t.action, t.value])).toEqual([
      ['A', 'SELL', 500],
      ['C', 'BUY', 1200],
      ['B', 'BUY', 300],
    ]);
    expect(r.leftoverCash).toBe(0);
  });

  it('spreads trades inside a category pro rata to market value', () => {
    const r = calculateRebalance({
      holdings: [hold('A1', 'c1', 4000), hold('A2', 'c1', 2000), hold('B', 'c2', 4000)],
      categories: [cat('c1', 50), cat('c2', 50)],
      mode: 'full',
    });
    expect(r.trades.map((t) => [t.symbol, t.action, t.value])).toEqual([
      ['A1', 'SELL', 666.67],
      ['A2', 'SELL', 333.33],
      ['B', 'BUY', 1000],
    ]);
  });

  it('scales buys down when whole-unit sells bring in less than planned', () => {
    const r = calculateRebalance({
      holdings: [hold('A', 'c1', 1050, 100), hold('B', 'c2', 0, 10)],
      categories: [cat('c1', 50), cat('c2', 50)],
      mode: 'full',
      wholeUnits: true,
    });
    // target 525 each: sell floor(525/100)=5 units (500), buy 500 of B = 50 units; A still 550 (52.38%)
    expect(r.trades.map((t) => [t.symbol, t.action, t.units])).toEqual([
      ['A', 'SELL', 5],
      ['B', 'BUY', 50],
    ]);
    expect(r.leftoverCash).toBe(0);
  });

  it('never sells more than the tradable value', () => {
    const r = calculateRebalance({
      holdings: [hold('CASH.EUR', 'c1', 8000, 1, false), hold('A', 'c1', 100), hold('B', 'c2', 100)],
      categories: [cat('c1', 10), cat('c2', 90)],
      mode: 'full',
    });
    expect(r.trades.find((t) => t.symbol === 'CASH.EUR')).toBeUndefined();
    const sell = r.trades.find((t) => t.symbol === 'A')!;
    expect(sell).toMatchObject({ action: 'SELL', value: 100 });
  });
});

describe('calculateRebalance: buy-only', () => {
  it('invests pro rata to the shortfall and never sells', () => {
    const r = calculateRebalance({ holdings: base, categories: cats, mode: 'buy-only', amount: 1000 });
    // basis 11000: shortfalls c2 300, c3 1200 (c1 is overweight) -> scaled by 1000/1500
    expect(r.trades.map((t) => [t.symbol, t.action, t.value])).toEqual([
      ['C', 'BUY', 800],
      ['B', 'BUY', 200],
    ]);
    expect(r.leftoverCash).toBe(0);
    expect(r.rows[0]).toMatchObject({ valueAfter: 6000, weightAfter: 54.55, driftAfter: 4.55 });
    expect(r.rows[2]).toMatchObject({ valueAfter: 1800, weightAfter: 16.36, driftAfter: -3.64 });
  });

  it('reaches the targets exactly when the amount covers every shortfall', () => {
    const r = calculateRebalance({ holdings: base, categories: cats, mode: 'buy-only', amount: 5000 });
    expect(r.trades.map((t) => [t.symbol, t.value])).toEqual([
      ['C', 2000],
      ['A', 1500],
      ['B', 1500],
    ]);
    expect(r.rows.map((x) => x.driftAfter)).toEqual([0, 0, 0]);
  });

  it('keeps unspent money as leftover cash when targets leave a remainder unallocated', () => {
    const r = calculateRebalance({
      holdings: [...base, hold('U', null, 1000)],
      categories: [cat('c1', 50), cat('c2', 30)],
      mode: 'buy-only',
      amount: 1000,
    });
    // basis 12000: c1 target 6000 (have 6000), c2 target 3600 (have 3000) -> only 600 is wanted
    expect(r.trades.map((t) => [t.symbol, t.value])).toEqual([['B', 600]]);
    expect(r.leftoverCash).toBe(400);
    // C and U are both outside the two categories
    expect(r.unallocated).toMatchObject({ targetWeight: 20, valueBefore: 2000, valueAfter: 2000 });
  });

  it('suggests nothing without an amount', () => {
    const r = calculateRebalance({ holdings: base, categories: cats, mode: 'buy-only' });
    expect(r.trades).toEqual([]);
    expect(r.leftoverCash).toBe(0);
  });

  it('treats holdings of unknown categories as unallocated', () => {
    const r = calculateRebalance({ holdings: [hold('X', 'gone', 500), hold('A', 'c1', 500)], categories: [cat('c1', 100)], mode: 'buy-only', amount: 0 });
    expect(r.unallocated.valueBefore).toBe(500);
  });
});

describe('calculateRebalance: rounding and limits', () => {
  it('rounds buys down to whole units and tops up with single units', () => {
    const r = calculateRebalance({
      holdings: [hold('H1', 'c1', 300, 30), hold('H2', 'c1', 300, 30)],
      categories: [cat('c1', 100)],
      mode: 'buy-only',
      amount: 100,
      wholeUnits: true,
    });
    // 50 each -> 1 unit each (60); 40 left: one more unit of the largest/first holding fits and keeps the gap <= half a unit
    expect(r.trades.map((t) => [t.symbol, t.units, t.value])).toEqual([
      ['H1', 2, 60],
      ['H2', 1, 30],
    ]);
    expect(r.leftoverCash).toBe(10);
  });

  it('keeps fractional units when whole units are not required', () => {
    const r = calculateRebalance({ holdings: [hold('H', 'c1', 100, 30)], categories: [cat('c1', 100)], mode: 'buy-only', amount: 100 });
    expect(r.trades[0]).toMatchObject({ units: 3.333333, value: 100 });
  });

  it('drops trades below the minimum trade size', () => {
    const r = calculateRebalance({ holdings: base, categories: cats, mode: 'buy-only', amount: 1000, minTrade: 500 });
    expect(r.trades.map((t) => t.symbol)).toEqual(['C']);
    expect(r.leftoverCash).toBe(200);
  });

  it('does not top up with units cheaper than the minimum trade', () => {
    const r = calculateRebalance({
      holdings: [hold('H1', 'c1', 300, 30), hold('H2', 'c1', 300, 30)],
      categories: [cat('c1', 100)],
      mode: 'buy-only',
      amount: 100,
      wholeUnits: true,
      minTrade: 40,
    });
    expect(r.trades).toEqual([]);
    expect(r.leftoverCash).toBe(100);
  });

  it('splits equally between holdings that are worth nothing yet', () => {
    const r = calculateRebalance({
      holdings: [hold('N1', 'c1', 0, 10), hold('N2', 'c1', 0, 10)],
      categories: [cat('c1', 100)],
      mode: 'buy-only',
      amount: 100,
      wholeUnits: true,
    });
    expect(r.trades.map((t) => [t.symbol, t.units])).toEqual([
      ['N1', 5],
      ['N2', 5],
    ]);
  });

  it('warns when an underweight category has nothing to buy', () => {
    const r = calculateRebalance({
      holdings: [hold('CASH.EUR', 'c1', 100, 1, false), hold('A', 'c2', 100)],
      categories: [cat('c1', 50, { name: 'Safe' }), cat('c2', 50)],
      mode: 'buy-only',
      amount: 100,
    });
    expect(r.warnings).toEqual(['"Safe" is below its target but has no holdings that can be bought.']);
    expect(r.trades.map((t) => t.symbol)).toEqual(['A']);
    expect(r.leftoverCash).toBe(r.amount - r.trades[0]!.value);
  });

  it('ignores holdings without a usable price', () => {
    const r = calculateRebalance({ holdings: [hold('Z', 'c1', 100, 0)], categories: [cat('c1', 100)], mode: 'buy-only', amount: 100 });
    expect(r.trades).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it('handles an empty portfolio', () => {
    const r = calculateRebalance({ holdings: [], categories: [cat('c1', 100)], mode: 'full' });
    expect(r).toMatchObject({ totalBefore: 0, basis: 0, trades: [], leftoverCash: 0 });
    expect(r.rows[0]).toMatchObject({ weightBefore: 0, driftBefore: -100 });
  });

  it('rejects invalid input', () => {
    expect(() => calculateRebalance({ holdings: base, categories: [cat('a', 60), cat('b', 50)], mode: 'full' })).toThrow(PortfolioError);
    expect(() => calculateRebalance({ holdings: base, categories: cats, mode: 'full', amount: -1 })).toThrow(/Amount/);
    expect(() => calculateRebalance({ holdings: base, categories: cats, mode: 'full', amount: Number.NaN })).toThrow(/Amount/);
    expect(() => calculateRebalance({ holdings: base, categories: cats, mode: 'full', minTrade: -1 })).toThrow(/Minimum/);
  });
});

describe('rebalanceTradesToCsv', () => {
  it('writes a header and quotes names with commas or quotes', () => {
    const csv = rebalanceTradesToCsv([
      { symbol: 'A', name: 'Acme, "Inc"', categoryId: 'c', action: 'BUY', units: 2, price: 10.5, value: 21 },
      { symbol: 'B', name: 'Beta', categoryId: 'c', action: 'SELL', units: 1, price: 5, value: 5 },
    ]);
    expect(csv).toBe('symbol,name,action,units,price,value\nA,"Acme, ""Inc""",BUY,2,10.5,21\nB,Beta,SELL,1,5,5\n');
    expect(rebalanceTradesToCsv([])).toBe('symbol,name,action,units,price,value\n');
  });
});
