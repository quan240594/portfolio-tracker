import { describe, expect, it } from 'vitest';
import {
  ENTITY,
  applyManagement,
  assignHoldingsSchema,
  assignmentMap,
  buildPositions,
  buildValueHistory,
  calculateCategoryAllocation,
  calculatePortfolio,
  cashBalances,
  cashDelta,
  cashSymbol,
  categoryTargetTotal,
  createCategorySchema,
  createCustomAssetSchema,
  csvRowSchema,
  customAssetValueLocal,
  externalCashFlows,
  firstValuationDate,
  isCashSymbol,
  isCustomSymbol,
  isMarketSymbol,
  managementHistoryExtra,
  managementKeys,
  marketSymbols,
  normalizeHoldingSymbol,
  PortfolioError,
  portfolioSettingsSchema,
  rebalanceQuerySchema,
  sortValuations,
  toRebalanceHoldings,
  transactionInputSchema,
  transactionsToCsv,
  updateCategorySchema,
  updateCustomAssetSchema,
  upsertValuation,
  valuationSchema,
  withholdingFee,
  MAX_VALUATIONS,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
  type EodPrice,
  type FxRates,
  type Holding,
  type Quote,
  type Transaction,
} from './index.js';

const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-06-01T00:00:00Z' };
let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2026-01-02',
  type: 'BUY',
  symbol: 'AAPL',
  quantity: 1,
  price: 100,
  fee: 0,
  currency: 'EUR',
  createdAt: `2026-01-01T00:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
const cash = (type: 'DEPOSIT' | 'WITHDRAWAL' | 'FEE' | 'INTEREST', amount: number, extra: Partial<Transaction> = {}) =>
  tx({ type, symbol: cashSymbol(extra.currency ?? 'EUR'), quantity: amount, price: 1, ...extra });

describe('symbols', () => {
  it('recognises cash and custom symbols and excludes them from market data', () => {
    expect(cashSymbol('usd')).toBe('CASH.USD');
    expect(isCashSymbol('CASH.EUR')).toBe(true);
    expect(isCashSymbol('CASH.AS')).toBe(false);
    expect(isCustomSymbol('CUSTOM:abc')).toBe(true);
    expect(isMarketSymbol('AAPL')).toBe(true);
    expect(isMarketSymbol('CASH.EUR')).toBe(false);
    expect(isMarketSymbol('CUSTOM:abc')).toBe(false);
    expect(marketSymbols(['AAPL', 'CASH.EUR', 'CUSTOM:x', 'ASML.AS'])).toEqual(['AAPL', 'ASML.AS']);
  });

  it('normalises holding symbols without breaking custom ids', () => {
    expect(normalizeHoldingSymbol(' aapl ')).toBe('AAPL');
    expect(normalizeHoldingSymbol('cash.eur')).toBe('CASH.EUR');
    expect(normalizeHoldingSymbol('custom:AbC-1')).toBe('CUSTOM:abc-1');
  });
});

describe('keys', () => {
  it('builds non-overlapping sort keys scoped by user and portfolio', () => {
    expect(managementKeys.settings('u', 'p')).toEqual({ PK: 'USER#u', SK: 'PSETTINGS#p' });
    expect(managementKeys.category('u', 'p', 'c')).toEqual({ PK: 'USER#u', SK: 'CATEGORY#p#c' });
    expect(managementKeys.assignment('u', 'p', 'AAPL')).toEqual({ PK: 'USER#u', SK: 'CATASSIGN#p#AAPL' });
    expect(managementKeys.customAsset('u', 'p', 'a')).toEqual({ PK: 'USER#u', SK: 'ASSET#p#a' });
    expect(managementKeys.watchlist('u', 'BTC-EUR')).toEqual({ PK: 'USER#u', SK: 'WATCH#BTC-EUR' });
    expect(managementKeys.categoryPrefix()).toBe('CATEGORY#');
    expect(managementKeys.categoryPrefix('p')).toBe('CATEGORY#p#');
    expect(managementKeys.assignmentPrefix()).toBe('CATASSIGN#');
    expect(managementKeys.assignmentPrefix('p')).toBe('CATASSIGN#p#');
    expect(managementKeys.customAssetPrefix()).toBe('ASSET#');
    expect(managementKeys.customAssetPrefix('p')).toBe('ASSET#p#');
  });
});

describe('transaction schemas', () => {
  const base = { portfolioId: 'default', date: '2026-01-02', type: 'DEPOSIT', symbol: 'CASH.EUR', quantity: 1000, price: 1, fee: 0, currency: 'EUR' };

  it('accepts cash movements and splits', () => {
    expect(transactionInputSchema.safeParse(base).success).toBe(true);
    expect(transactionInputSchema.safeParse({ ...base, type: 'withdrawal' }).success).toBe(false); // API types are upper-case
    expect(transactionInputSchema.safeParse({ ...base, type: 'SPLIT', symbol: 'aapl', quantity: 4, price: 0 }).success).toBe(true);
  });

  it('requires CASH.<currency> and a price for cash movements', () => {
    const wrongSymbol = transactionInputSchema.safeParse({ ...base, symbol: 'CASH.USD' });
    expect(wrongSymbol.success).toBe(false);
    expect(!wrongSymbol.success && wrongSymbol.error.issues[0]!.path).toEqual(['symbol']);
    const noPrice = transactionInputSchema.safeParse({ ...base, price: 0 });
    expect(!noPrice.success && noPrice.error.issues[0]!.path).toEqual(['price']);
  });

  it('rejects fees on types that have none and reserved symbols on trades', () => {
    expect(transactionInputSchema.safeParse({ ...base, fee: 1 }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...base, type: 'SPLIT', symbol: 'AAPL', fee: 1 }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...base, type: 'BUY', symbol: 'CASH.EUR', fee: 1 }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...base, type: 'BUY', symbol: 'custom:x' }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...base, type: 'BUY', symbol: 'AAPL', fee: 1 }).success).toBe(true);
  });

  it('applies the same rules to CSV rows', () => {
    const row = { date: '2026-01-02', type: 'deposit', symbol: 'CASH.EUR', quantity: '500', price: '1', fee: '', currency: 'eur' };
    expect(csvRowSchema.safeParse(row).success).toBe(true);
    expect(csvRowSchema.safeParse({ ...row, symbol: 'AAPL' }).success).toBe(false);
    expect(csvRowSchema.safeParse({ ...row, type: 'split', symbol: 'AAPL', quantity: '0.1', price: '0' }).success).toBe(true);
  });
});

describe('stock splits', () => {
  it('multiplies units and keeps total cost, so the average cost per share drops', () => {
    const p = buildPositions([tx({ quantity: 10, price: 100, fee: 5 }), tx({ date: '2026-02-01', type: 'SPLIT', quantity: 4, price: 0 })]).get('AAPL')!;
    expect(p.quantity).toBe(40);
    expect(p.costLocal).toBe(1005);
    expect(p.costBase).toBe(1005);
    expect(p.costLocal / p.quantity).toBeCloseTo(25.125);
  });

  it('supports reverse splits and selling afterwards', () => {
    const p = buildPositions([
      tx({ quantity: 40, price: 25 }),
      tx({ date: '2026-02-01', type: 'SPLIT', quantity: 0.1, price: 0 }),
      tx({ date: '2026-03-01', type: 'SELL', quantity: 4, price: 300 }),
    ]).get('AAPL')!;
    // 40 shares (cost 1000) -> 4 shares at an average cost of 250; selling all 4 at 300 realizes 200
    expect(p.quantity).toBe(0);
    expect(p.realizedPnlLocal).toBe(200);
  });

  it('rejects a split without a position, on a closed position and with an invalid ratio', () => {
    expect(() => buildPositions([tx({ type: 'SPLIT', quantity: 2, price: 0 })])).toThrow(PortfolioError);
    expect(() =>
      buildPositions([tx({ quantity: 1 }), tx({ date: '2026-01-03', type: 'SELL', quantity: 1 }), tx({ date: '2026-01-04', type: 'SPLIT', quantity: 2, price: 0 })]),
    ).toThrow(/Cannot split AAPL on 2026-01-04/);
    expect(() => buildPositions([tx({}), tx({ date: '2026-01-03', type: 'SPLIT', quantity: 0, price: 0 })])).toThrow(PortfolioError);
  });

  it('counts the same split once when portfolios are combined', () => {
    const txns = [
      tx({ portfolioId: 'a', quantity: 10 }),
      tx({ portfolioId: 'b', quantity: 10 }),
      tx({ portfolioId: 'a', date: '2026-02-01', type: 'SPLIT', quantity: 2, price: 0 }),
      tx({ portfolioId: 'b', date: '2026-02-01', type: 'SPLIT', quantity: 2, price: 0 }),
    ];
    expect(buildPositions(txns).get('AAPL')!.quantity).toBe(40);
    expect(buildPositions(txns.filter((t) => t.portfolioId === 'a')).get('AAPL')!.quantity).toBe(20);
  });

  it('shows pre-split quantities on the split-adjusted price basis in the value history', () => {
    const txns = [tx({ date: '2026-01-02', quantity: 10, price: 100 }), tx({ date: '2026-01-05', type: 'SPLIT', quantity: 4, price: 0 })];
    // Provider closes are split-adjusted: the 100 EUR stock before the split already shows as 25.
    const eod: EodPrice[] = [
      { symbol: 'AAPL', date: '2026-01-02', close: 25, currency: 'EUR' },
      { symbol: 'AAPL', date: '2026-01-03', close: 25, currency: 'EUR' },
      { symbol: 'AAPL', date: '2026-01-04', close: 25, currency: 'EUR' },
      { symbol: 'AAPL', date: '2026-01-05', close: 26, currency: 'EUR' },
      { symbol: 'AAPL', date: '2026-01-06', close: 27, currency: 'EUR' },
    ];
    const points = buildValueHistory(txns, { AAPL: eod }, fx, '2026-01-02', '2026-01-06');
    expect(points.map((p) => p.value)).toEqual([1000, 1000, 1000, 1040, 1080]);
    expect(points.map((p) => p.invested)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('falls back to the split-adjusted average cost when there is no close', () => {
    const txns = [tx({ date: '2026-01-02', quantity: 10, price: 100 }), tx({ date: '2026-01-05', type: 'SPLIT', quantity: 4, price: 0 })];
    const points = buildValueHistory(txns, {}, fx, '2026-01-02', '2026-01-06');
    expect(points.map((p) => p.value)).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('applies a split once in the combined history and reports the split quantity today', () => {
    const txns = [
      tx({ portfolioId: 'a', quantity: 5, price: 100 }),
      tx({ portfolioId: 'b', quantity: 5, price: 100 }),
      tx({ portfolioId: 'a', date: '2026-01-04', type: 'SPLIT', quantity: 2, price: 0 }),
      tx({ portfolioId: 'b', date: '2026-01-04', type: 'SPLIT', quantity: 2, price: 0 }),
    ];
    const eod: EodPrice[] = [{ symbol: 'AAPL', date: '2026-01-03', close: 50, currency: 'EUR' }];
    const points = buildValueHistory(txns, { AAPL: eod }, fx, '2026-01-02', '2026-01-04');
    expect(points.map((p) => p.value)).toEqual([1000, 1000, 1000]);

    const quotes: Record<string, Quote> = { AAPL: { symbol: 'AAPL', price: 50, previousClose: 50, currency: 'EUR', asOf: 'x', source: 't' } };
    const { holdings } = calculatePortfolio({ transactions: txns, quotes, profiles: {}, fx });
    expect(holdings[0]).toMatchObject({ quantity: 20, averageCostLocal: 50, marketValue: 1000 });
  });
});

describe('cash ledger', () => {
  it('books every transaction type in the transaction currency', () => {
    expect(cashDelta(tx({ quantity: 10, price: 100, fee: 5 }))).toBe(-1005);
    expect(cashDelta(tx({ type: 'SELL', quantity: 10, price: 100, fee: 5 }))).toBe(995);
    expect(cashDelta(tx({ type: 'DIVIDEND', quantity: 10, price: 1, fee: 1.5 }))).toBe(8.5);
    expect(cashDelta(cash('DEPOSIT', 500))).toBe(500);
    expect(cashDelta(cash('INTEREST', 2))).toBe(2);
    expect(cashDelta(cash('WITHDRAWAL', 200))).toBe(-200);
    expect(cashDelta(cash('FEE', 3))).toBe(-3);
    expect(cashDelta(tx({ type: 'SPLIT', quantity: 2, price: 0 }))).toBe(0);
  });

  it('sums balances per currency for the selected portfolios up to a date', () => {
    const txns = [
      cash('DEPOSIT', 1000),
      tx({ date: '2026-01-03', quantity: 2, price: 100, symbol: 'AAPL' }),
      cash('DEPOSIT', 700, { currency: 'USD' }),
      cash('DEPOSIT', 999, { portfolioId: 'other' }),
      cash('WITHDRAWAL', 100, { date: '2026-02-01' }),
    ];
    const all = cashBalances(txns, new Set(['default']));
    expect(Object.fromEntries(all)).toEqual({ EUR: 700, USD: 700 });
    expect(Object.fromEntries(cashBalances(txns, new Set(['default']), '2026-01-02'))).toEqual({ EUR: 1000, USD: 700 });
    expect(cashBalances(txns, new Set()).size).toBe(0);
  });

  it('ignores cash movements for positions', () => {
    expect(buildPositions([cash('DEPOSIT', 1000), cash('FEE', 1)]).size).toBe(0);
  });
});

describe('applyManagement', () => {
  const quotes: Record<string, Quote> = { AAPL: { symbol: 'AAPL', price: 110, previousClose: 108, currency: 'USD', asOf: 'x', source: 't' } };
  const txns = [
    cash('DEPOSIT', 5000),
    tx({ date: '2026-01-03', quantity: 10, price: 100, currency: 'USD' }),
    cash('INTEREST', 12.5, { date: '2026-02-01' }),
    cash('FEE', 2.5, { date: '2026-02-02' }),
  ];
  const compute = (t: readonly Transaction[]) => calculatePortfolio({ transactions: t, quotes, profiles: {}, fx, now: new Date('2026-06-01T00:00:00Z') });

  it('leaves the result untouched without cash tracking or custom assets', () => {
    const result = compute(txns);
    expect(applyManagement(result, { transactions: txns, cashPortfolioIds: new Set(), customAssets: [], fx, today: '2026-06-01' })).toBe(result);
    expect(result.summary.totalValue).toBe(880); // 10 * 110 USD / 1.25
    expect(result.summary.cashValue).toBeUndefined();
  });

  it('adds cash rows, totals and the cash income to the return', () => {
    const result = applyManagement(compute(txns), { transactions: txns, cashPortfolioIds: new Set(['default']), customAssets: [], fx, today: '2026-06-01' });
    // EUR: 5000 + 12.5 - 2.5 = 5010; USD: -1000 -> -800 EUR; stock 880 EUR (cost 800)
    expect(result.holdings.map((h) => [h.symbol, h.marketValue])).toEqual([
      ['CASH.EUR', 5010],
      ['AAPL', 880],
      ['CASH.USD', -800],
    ]);
    const usd = result.holdings.find((h) => h.symbol === 'CASH.USD')!;
    expect(usd).toMatchObject({ assetClass: 'CASH', quantity: -1000, priceBase: 0.8, costBasis: -800, unrealizedPnl: 0, name: 'Cash (USD)' });
    expect(result.summary).toMatchObject({
      totalValue: 5090,
      totalCost: 5010,
      unrealizedPnl: 80,
      unrealizedPnlPct: 1.6,
      cashValue: 4210,
      cashIncome: 10,
      realizedPnl: 0,
      totalReturn: 90,
      totalReturnPct: 11.25, // 90 / 800 invested
      holdingsCount: 3,
      dayChange: 16,
    });
    expect(result.summary.customAssetsValue).toBeUndefined();
    expect(result.holdings.find((h) => h.symbol === 'AAPL')!.weight).toBeCloseTo(880 / 5090, 4);
  });

  it('only counts portfolios that track cash', () => {
    const mixed = [cash('DEPOSIT', 1000, { portfolioId: 'other' }), ...txns];
    const result = applyManagement(compute(mixed), { transactions: mixed, cashPortfolioIds: new Set(['other']), customAssets: [], fx, today: '2026-06-01' });
    expect(result.holdings.map((h) => h.symbol)).toEqual(['CASH.EUR', 'AAPL']);
    expect(result.summary.cashValue).toBe(1000);
  });

  it('skips balances that are zero and reports 0 cash when tracking is on but empty', () => {
    const zero = [cash('DEPOSIT', 10), cash('WITHDRAWAL', 10)];
    const result = applyManagement(compute(zero), { transactions: zero, cashPortfolioIds: new Set(['default']), customAssets: [], fx, today: '2026-06-01' });
    expect(result.holdings).toEqual([]);
    expect(result.summary).toMatchObject({ cashValue: 0, totalValue: 0, totalReturnPct: 0, dayChangePct: 0 });
  });
});

describe('custom assets', () => {
  const asset = (p: Partial<CustomAsset> = {}): CustomAsset => ({
    assetId: 'a1',
    userId: 'demo',
    portfolioId: 'default',
    name: 'Apartment',
    assetClass: 'REAL_ESTATE',
    currency: 'EUR',
    costBasis: 8000,
    valuations: [{ date: '2025-06-01', value: 10000 }],
    createdAt: 'x',
    updatedAt: 'x',
    ...p,
  });

  it('values by the latest point on or before the date, optionally compounding growth', () => {
    expect(customAssetValueLocal(asset(), '2025-05-31')).toBe(0);
    expect(customAssetValueLocal(asset(), '2025-06-01')).toBe(10000);
    expect(customAssetValueLocal(asset(), '2030-01-01')).toBe(10000);
    expect(customAssetValueLocal(asset({ growthRate: 5 }), '2026-06-01')).toBeCloseTo(10500, 6);
    expect(customAssetValueLocal(asset({ growthRate: 5 }), '2025-06-01')).toBe(10000);
    const points = asset({ valuations: [{ date: '2026-01-01', value: 12000 }, { date: '2025-06-01', value: 10000 }], growthRate: 10 });
    expect(customAssetValueLocal(points, '2025-12-31')).toBeCloseTo(10000 * 1.1 ** (213 / 365), 6);
    expect(customAssetValueLocal(points, '2026-01-01')).toBe(12000);
    expect(firstValuationDate(points)).toBe('2025-06-01');
    expect(firstValuationDate({ valuations: [] })).toBeUndefined();
  });

  it('sorts valuations, keeps the last entry per date and enforces the maximum', () => {
    expect(sortValuations([{ date: '2026-02-01', value: 2 }, { date: '2026-01-01', value: 1 }, { date: '2026-02-01', value: 3 }])).toEqual([
      { date: '2026-01-01', value: 1 },
      { date: '2026-02-01', value: 3 },
    ]);
    const updated = upsertValuation(asset(), { date: '2025-01-01', value: 9000 })!;
    expect(updated.valuations.map((v) => v.date)).toEqual(['2025-01-01', '2025-06-01']);
    const full = asset({ valuations: Array.from({ length: MAX_VALUATIONS }, (_, i) => ({ date: new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10), value: 1 })) });
    expect(upsertValuation(full, { date: '2030-01-01', value: 1 })).toBeNull();
    expect(upsertValuation(full, { date: '2000-01-01', value: 5 })).not.toBeNull();
  });

  it('adds assets to holdings and totals, including currency effect and allocation classes', () => {
    const base = calculatePortfolio({ transactions: [], quotes: {}, profiles: {}, fx, now: new Date('2026-06-01T00:00:00Z') });
    const usdAsset = asset({ assetId: 'a2', name: 'P2P loans', assetClass: 'DEPOSIT', currency: 'USD', costBasis: 1250, valuations: [{ date: '2026-01-01', value: 1500 }] });
    const result = applyManagement(base, { transactions: [], cashPortfolioIds: new Set(), customAssets: [asset({ growthRate: 5 }), usdAsset, asset({ assetId: 'future', valuations: [{ date: '2027-01-01', value: 1 }] })], fx, today: '2026-06-01' });
    expect(result.holdings.map((h) => [h.symbol, h.assetClass, h.marketValue, h.costBasis, h.unrealizedPnl])).toEqual([
      ['CUSTOM:a1', 'REAL_ESTATE', 10500, 8000, 2500],
      ['CUSTOM:a2', 'DEPOSIT', 1200, 1000, 200],
    ]);
    expect(result.holdings[1]).toMatchObject({ quantity: 1, priceLocal: 1500, currency: 'USD', sector: 'Custom assets' });
    expect(result.summary).toMatchObject({ totalValue: 11700, totalCost: 9000, unrealizedPnl: 2700, unrealizedPnlPct: 30, customAssetsValue: 11700, holdingsCount: 2, totalReturn: 2700, totalReturnPct: 30 });
    expect(result.summary.cashValue).toBeUndefined();
  });

  it('handles a zero cost basis', () => {
    const base = calculatePortfolio({ transactions: [], quotes: {}, profiles: {}, fx, now: new Date('2026-06-01T00:00:00Z') });
    const free = asset({ costBasis: 0, currency: 'USD', valuations: [{ date: '2026-01-01', value: 125 }] });
    const result = applyManagement(base, { transactions: [], cashPortfolioIds: new Set(), customAssets: [free], fx, today: '2026-06-01' });
    expect(result.holdings[0]).toMatchObject({ marketValue: 100, costBasis: 0, unrealizedPnlPct: 0, currencyEffect: 0 });
  });
});

describe('managementHistoryExtra', () => {
  const customAsset: CustomAsset = {
    assetId: 'a1',
    userId: 'demo',
    portfolioId: 'default',
    name: 'Savings',
    assetClass: 'DEPOSIT',
    currency: 'EUR',
    costBasis: 900,
    valuations: [{ date: '2026-01-04', value: 1000 }],
    createdAt: 'x',
    updatedAt: 'x',
  };
  const txns = [cash('DEPOSIT', 2000, { date: '2026-01-02' }), tx({ date: '2026-01-03', quantity: 5, price: 100 })];

  it('is undefined when there is nothing to add', () => {
    expect(managementHistoryExtra({ transactions: txns, cashPortfolioIds: new Set(), customAssets: [] })).toBeUndefined();
  });

  it('adds the running cash balance and custom assets to the daily value and cost', () => {
    const extra = managementHistoryExtra({ transactions: txns, cashPortfolioIds: new Set(['default']), customAssets: [customAsset] });
    const eod: EodPrice[] = [{ symbol: 'AAPL', date: '2026-01-03', close: 100, currency: 'EUR' }, { symbol: 'AAPL', date: '2026-01-04', close: 120, currency: 'EUR' }];
    const points = buildValueHistory(txns, { AAPL: eod }, fx, '2026-01-02', '2026-01-04', undefined, extra);
    // cash 2000 -> 1500 after buying 5 x 100; stock 500 -> 600; custom asset 1000 (cost 900) from the 4th
    expect(points).toEqual([
      { date: '2026-01-02', value: 2000, invested: 2000 },
      { date: '2026-01-03', value: 2000, invested: 2000 },
      { date: '2026-01-04', value: 3100, invested: 2900 },
    ]);
  });

  it('works with custom assets only', () => {
    const extra = managementHistoryExtra({ transactions: txns, cashPortfolioIds: new Set(), customAssets: [customAsset, { ...customAsset, assetId: 'empty', valuations: [] }] });
    const points = buildValueHistory(txns, {}, fx, '2026-01-03', '2026-01-04', undefined, extra);
    expect(points.map((p) => p.value)).toEqual([500, 1500]);
  });
});

describe('externalCashFlows', () => {
  const flows = [
    cash('DEPOSIT', 1000, { date: '2026-01-02' }),
    cash('WITHDRAWAL', 250, { date: '2026-03-01' }),
    cash('INTEREST', 5, { date: '2026-03-02' }),
    tx({ portfolioId: 'plain', date: '2026-01-05', quantity: 10, price: 100, fee: 5, currency: 'USD' }),
    tx({ portfolioId: 'plain', date: '2026-02-05', type: 'SELL', quantity: 5, price: 120, fee: 5, currency: 'USD' }),
    tx({ portfolioId: 'plain', date: '2026-02-06', type: 'DIVIDEND', quantity: 5, price: 1, fee: 1, currency: 'USD' }),
    tx({ portfolioId: 'plain', date: '2026-02-07', type: 'SPLIT', quantity: 2, price: 0, currency: 'USD' }),
    tx({ date: '2026-01-03', quantity: 1, price: 10 }), // BUY inside a cash-tracking portfolio: internal
  ];

  it('uses deposits/withdrawals when tracking cash and trades otherwise', () => {
    const result = externalCashFlows(flows, new Set(['default']), fx);
    expect(result).toEqual([
      { date: '2026-01-02', amount: 1000, portfolioId: 'default' },
      { date: '2026-01-05', amount: 804, portfolioId: 'plain' }, // (10 x 100 + 5) / 1.25
      { date: '2026-02-05', amount: -476, portfolioId: 'plain' }, // -(5 x 120 - 5) / 1.25
      { date: '2026-02-06', amount: -3.2, portfolioId: 'plain' }, // -(5 x 1 - 1) / 1.25
      { date: '2026-03-01', amount: -250, portfolioId: 'default' },
    ]);
  });

  it('treats every portfolio as untracked without cash tracking', () => {
    const result = externalCashFlows([cash('DEPOSIT', 1000), tx({ quantity: 2, price: 10 })], new Set(), fx);
    expect(result.map((f) => f.amount)).toEqual([20]);
  });
});

describe('categories', () => {
  const category = (categoryId: string, targetWeight: number, name = categoryId): Category => ({ categoryId, userId: 'demo', portfolioId: 'default', name, color: '#000000', targetWeight, createdAt: 'x', updatedAt: 'x' });
  const assign = (symbol: string, categoryId: string): CategoryAssignment => ({ userId: 'demo', portfolioId: 'default', symbol, categoryId });
  const holding = (symbol: string, marketValue: number, extra: Partial<Holding> = {}): Holding => ({
    symbol,
    name: `${symbol} Inc`,
    assetClass: 'STOCK',
    sector: 's',
    country: 'c',
    currency: 'EUR',
    quantity: 1,
    averageCostLocal: marketValue,
    priceLocal: marketValue,
    averageCostBase: marketValue,
    priceBase: marketValue,
    priceStale: false,
    costBasis: marketValue,
    marketValue,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    currencyEffect: 0,
    dayChange: 0,
    dayChangePct: 0,
    realizedPnl: 0,
    dividendsReceived: 0,
    weight: 0,
    ...extra,
  });
  const cats = [category('c1', 60, 'Core'), category('c2', 15.5, 'Crypto'), category('empty', 5, 'Empty')];
  const assignments = [assign('A', 'c1'), assign('B', 'c1'), assign('C', 'c2'), assign('Z', 'deleted')];

  it('sums targets and maps assignments of known categories only', () => {
    expect(categoryTargetTotal(cats)).toBe(80.5);
    expect(assignmentMap(cats, assignments).get('A')).toBe('c1');
    expect(assignmentMap(cats, assignments).has('Z')).toBe(false);
  });

  it('allocates by category with an uncategorized slice', () => {
    const slices = calculateCategoryAllocation([holding('A', 500), holding('B', 300), holding('C', 100), holding('X', 100), holding('Z', 0)], cats, assignments);
    expect(slices).toEqual([
      { key: 'c1', label: 'Core', value: 800, weight: 0.8 },
      { key: 'c2', label: 'Crypto', value: 100, weight: 0.1 },
      { key: 'unassigned', label: 'Uncategorized', value: 100, weight: 0.1 },
    ]);
    expect(calculateCategoryAllocation([], cats, assignments)).toEqual([]);
  });

  it('joins holdings with their category for rebalancing; only priced market holdings are tradable', () => {
    const rows = toRebalanceHoldings(
      [holding('A', 500, { priceBase: 50 }), holding('CASH.EUR', 100, { assetClass: 'CASH' }), holding('CUSTOM:x', 10), holding('X', 1)],
      cats,
      [...assignments, assign('CASH.EUR', 'c2'), assign('CUSTOM:x', 'c2')],
    );
    expect(rows.map((r) => [r.symbol, r.categoryId, r.tradable])).toEqual([
      ['A', 'c1', true],
      ['CASH.EUR', 'c2', false],
      ['CUSTOM:x', 'c2', false],
      ['X', null, true],
    ]);
  });
});

describe('request schemas', () => {
  it('validates categories', () => {
    expect(createCategorySchema.parse({ name: ' Core ', color: '#AABBCC', targetWeight: '40' })).toEqual({ name: 'Core', color: '#aabbcc', targetWeight: 40 });
    expect(createCategorySchema.safeParse({ name: 'x', color: 'red', targetWeight: 10 }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: 'x', color: '#aabbcc', targetWeight: 101 }).success).toBe(false);
    expect(updateCategorySchema.safeParse({}).success).toBe(false);
    expect(updateCategorySchema.parse({ targetWeight: 5 })).toEqual({ targetWeight: 5 });
  });

  it('normalises assigned symbols', () => {
    expect(assignHoldingsSchema.parse({ symbols: ['aapl', 'custom:AbC', 'cash.eur'] }).symbols).toEqual(['AAPL', 'CUSTOM:abc', 'CASH.EUR']);
    expect(assignHoldingsSchema.safeParse({ symbols: ['bad symbol'] }).success).toBe(false);
  });

  it('validates settings, assets, valuations and the rebalance query', () => {
    expect(portfolioSettingsSchema.parse({ trackCash: true, withholdingTaxRate: 15 })).toEqual({ trackCash: true, withholdingTaxRate: 15 });
    expect(portfolioSettingsSchema.parse({ trackCash: false, withholdingTaxRate: null }).withholdingTaxRate).toBeNull();
    expect(portfolioSettingsSchema.safeParse({ trackCash: 'yes' }).success).toBe(false);
    expect(portfolioSettingsSchema.safeParse({ trackCash: true, withholdingTaxRate: 120 }).success).toBe(false);

    const asset = createCustomAssetSchema.parse({ name: 'House', currency: 'eur', value: '250000', growthRate: 2 });
    expect(asset).toEqual({ name: 'House', assetClass: 'OTHER', currency: 'EUR', value: 250000, growthRate: 2 });
    expect(createCustomAssetSchema.safeParse({ name: 'House', currency: 'EUR', value: -1 }).success).toBe(false);
    expect(updateCustomAssetSchema.safeParse({}).success).toBe(false);
    expect(updateCustomAssetSchema.parse({ growthRate: null })).toEqual({ growthRate: null });
    expect(valuationSchema.safeParse({ date: '2026-02-30', value: 1 }).success).toBe(false);

    expect(rebalanceQuerySchema.parse({})).toEqual({ mode: 'buy-only', amount: 0, minTrade: 0 });
    expect(rebalanceQuerySchema.parse({ mode: 'full', amount: '1500.5', wholeUnits: 'true', minTrade: '25' })).toEqual({ mode: 'full', amount: 1500.5, wholeUnits: true, minTrade: 25 });
    expect(rebalanceQuerySchema.parse({ wholeUnits: 'false' }).wholeUnits).toBe(false);
    expect(rebalanceQuerySchema.parse({ wholeUnits: '' }).wholeUnits).toBeUndefined();
    expect(rebalanceQuerySchema.safeParse({ mode: 'sell' }).success).toBe(false);
  });
});

describe('exports and helpers', () => {
  it('writes transactions as importer-compatible CSV', () => {
    const csv = transactionsToCsv([
      tx({ date: '2026-02-01', type: 'DIVIDEND', quantity: 2, price: 0.5, fee: 0.1, note: 'Q1, "net"', fxRate: 1.08, currency: 'USD' }),
      cash('DEPOSIT', 100, { date: '2026-01-01' }),
    ]);
    expect(csv).toBe(
      'date,type,symbol,quantity,price,fee,currency,note,fxRate\n' +
        '2026-01-01,DEPOSIT,CASH.EUR,100,1,0,EUR,,\n' +
        '2026-02-01,DIVIDEND,AAPL,2,0.5,0.1,USD,"Q1, ""net""",1.08\n',
    );
    expect(transactionsToCsv([])).toBe('date,type,symbol,quantity,price,fee,currency,note,fxRate\n');
  });

  it('computes the withholding tax of a dividend in cents', () => {
    expect(withholdingFee(10, 0.83, 15)).toBe(1.25);
    expect(withholdingFee(3, 0.333, 15)).toBe(0.15);
    expect(withholdingFee(10, 1, 0)).toBe(0);
  });
});
