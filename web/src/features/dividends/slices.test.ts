import type { DividendOverviewHolding, ListCategoriesResponse } from '@portfolio/shared';
import { incomeSlices, topSlices, yieldBars, type Slice } from './slices';
import { basisNote } from './basisNote';

const holding = (symbol: string, over: Partial<DividendOverviewHolding> = {}): DividendOverviewHolding => ({
  symbol,
  name: `${symbol} Corp`,
  assetClass: 'STOCK',
  currency: 'EUR',
  marketValue: 1000,
  costBasis: 800,
  forward12m: 40,
  declared: 10,
  estimated: 30,
  sharePct: 10,
  yieldPct: 4,
  yieldOnCostPct: 5,
  grossYieldPct: 4.7,
  withholdingPct: 15,
  basis: 'provider-history',
  paymentsPerYear: 4,
  perShareAnnual: 1.6,
  received12m: 0,
  receivedTotal: 0,
  growthPct: null,
  growthYears: 0,
  consistency: { badge: 'NEW', score: null, payments: 0, yearsWithPayments: 0, paymentsPerYear: 1, regularityCv: null, cuts: null, growthStreak: 0, points: { history: 0, regularity: 0, cuts: 0, growth: 0 } },
  ...over,
});

describe('topSlices', () => {
  const slices: Slice[] = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, value: 10 - i }));

  it('keeps everything up to the maximum', () => {
    expect(topSlices(slices.slice(0, 8))).toHaveLength(8);
  });

  it('collapses the rest into Other', () => {
    const top = topSlices(slices);
    expect(top).toHaveLength(9);
    expect(top.at(-1)).toEqual({ key: '__other', label: 'Other', detail: '2 more', value: 2 + 1 });
    expect(top.slice(0, 8).map((s) => s.key)).toEqual(slices.slice(0, 8).map((s) => s.key));
    expect(topSlices(slices, 3).at(-1)?.value).toBe(7 + 6 + 5 + 4 + 3 + 2 + 1);
  });
});

describe('incomeSlices', () => {
  it('lists paying holdings by income, largest first, ties by symbol', () => {
    const slices = incomeSlices([holding('B', { forward12m: 10 }), holding('A', { forward12m: 10 }), holding('C', { forward12m: 50 }), holding('Z', { forward12m: 0 })]);
    expect(slices.map((s) => [s.key, s.value, s.detail, s.label])).toEqual([
      ['C', 50, 'C', 'C Corp'],
      ['A', 10, 'A', 'A Corp'],
      ['B', 10, 'B', 'B Corp'],
    ]);
  });
});

describe('yieldBars', () => {
  const holdings = [
    holding('LOW', { yieldPct: 1, yieldOnCostPct: 2, forward12m: 100, marketValue: 10_000, costBasis: 5000 }),
    holding('HIGH', { yieldPct: 5, yieldOnCostPct: 6, forward12m: 50, marketValue: 1000, costBasis: 800 }),
    holding('TIE', { yieldPct: 5, yieldOnCostPct: 6, forward12m: 50, marketValue: 1000, costBasis: 800 }),
    holding('NONE', { forward12m: 0, yieldPct: 0 }),
  ];
  const categories: ListCategoriesResponse = {
    categories: [
      { categoryId: 'c1', userId: 'u', portfolioId: 'p', name: 'Core', color: '#000000', targetWeight: 50, createdAt: '', updatedAt: '' },
    ],
    assignments: [
      { userId: 'u', portfolioId: 'p', symbol: 'LOW', categoryId: 'c1' },
      { userId: 'u', portfolioId: 'p', symbol: 'HIGH', categoryId: 'c1' },
      { userId: 'u', portfolioId: 'p', symbol: 'GONE', categoryId: 'missing' },
    ],
    totalTarget: 50,
    unallocated: 50,
  };

  it('sorts holdings by yield or by amount, leaving out holdings without income', () => {
    expect(yieldBars(holdings, 'yield', 'holding').map((b) => b.key)).toEqual(['HIGH', 'TIE', 'LOW']);
    expect(yieldBars(holdings, 'amount', 'holding').map((b) => b.key)).toEqual(['LOW', 'HIGH', 'TIE']);
    expect(yieldBars(holdings, 'yield', 'holding')[0]).toEqual({ key: 'HIGH', label: 'HIGH', name: 'HIGH Corp', yieldPct: 5, onCostPct: 6, grossPct: 4.7, amount: 50, note: 'based on 4 payments a year from provider history' });
  });

  it('groups by category: income over the value and cost of the paying holdings in it', () => {
    const bars = yieldBars(holdings, 'yield', 'category', categories);
    // Core: 150 / 11000 = 1.36 %, on cost 150 / 5800 = 2.59 %; TIE is uncategorised: 50 / 1000 = 5 %
    expect(bars).toEqual([
      { key: 'Uncategorised', label: 'Uncategorised', name: 'Uncategorised', yieldPct: 5, onCostPct: 6.25, grossPct: 4.7, amount: 50, note: '' },
      { key: 'Core', label: 'Core', name: 'Core', yieldPct: 1.36, onCostPct: 2.59, grossPct: 4.7, amount: 150, note: '' },
    ]);
    expect(yieldBars(holdings, 'amount', 'category', categories).map((b) => b.key)).toEqual(['Core', 'Uncategorised']);
  });

  it('falls back to holdings without category data and guards against zero values', () => {
    expect(yieldBars(holdings, 'yield', 'category')).toHaveLength(3);
    const zero = yieldBars([holding('X', { marketValue: 0, costBasis: 0 })], 'yield', 'category', categories);
    expect(zero).toEqual([{ key: 'Uncategorised', label: 'Uncategorised', name: 'Uncategorised', yieldPct: 0, onCostPct: 0, grossPct: 0, amount: 40, note: '' }]);
  });
});

describe('basisNote', () => {
  it('says what the income rests on and warns when only one payment is known', () => {
    expect(basisNote({ basis: 'declared', paymentsPerYear: 4 })).toBe('every payment of the next 12 months is announced');
    expect(basisNote({ basis: 'provider-history', paymentsPerYear: 12 })).toBe('based on 12 payments a year from provider history');
    expect(basisNote({ basis: 'own-payments', paymentsPerYear: 1 })).toBe('based on 1 payment a year from your own payments');
    expect(basisNote({ basis: 'single-payment-assumed', paymentsPerYear: 1 })).toBe('only 1 payment known: assumed once a year - may be too low');
    expect(basisNote({ basis: 'none', paymentsPerYear: 0 })).toBe('');
  });
});
