import type { DividendOverviewHolding, ListCategoriesResponse } from '@portfolio/shared';

export const UNCATEGORISED = 'Uncategorised';
/** Slices shown before the rest is collapsed into "Other". */
export const MAX_SLICES = 8;

export interface Slice {
  key: string;
  label: string;
  /** Ticker or note shown next to the label. */
  detail?: string;
  value: number;
}

/** The largest `max` slices of `slices` (already sorted descending) plus one "Other" slice for the rest. */
export function topSlices(slices: readonly Slice[], max = MAX_SLICES): Slice[] {
  if (slices.length <= max) return [...slices];
  const tail = slices.slice(max);
  const other: Slice = { key: '__other', label: 'Other', detail: `${tail.length} more`, value: tail.reduce((s, x) => s + x.value, 0) };
  return [...slices.slice(0, max), other];
}

/** Forward income per holding, largest first; holdings without expected income are left out. */
export function incomeSlices(holdings: readonly DividendOverviewHolding[]): Slice[] {
  return holdings
    .filter((h) => h.forward12m > 0)
    .map((h) => ({ key: h.symbol, label: h.name, detail: h.symbol, value: h.forward12m }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

// --- Yield / payout bars -------------------------------------------------------------------------------

export type YieldMetric = 'yield' | 'amount';
export type YieldGroup = 'holding' | 'category';

export interface YieldBar {
  key: string;
  /** Short axis label (ticker or category name). */
  label: string;
  name: string;
  yieldPct: number;
  onCostPct: number;
  /** Forward 12-month income, base currency. */
  amount: number;
}

const pct = (income: number, base: number): number => (base > 0 ? Math.round((income / base) * 10_000) / 100 : 0);

const byMetric = (metric: YieldMetric) => (a: YieldBar, b: YieldBar) =>
  (metric === 'yield' ? b.yieldPct - a.yieldPct : b.amount - a.amount) || a.label.localeCompare(b.label);

/** One bar per dividend-paying holding. */
function holdingBars(holdings: readonly DividendOverviewHolding[]): YieldBar[] {
  return holdings.filter((h) => h.forward12m > 0).map((h) => ({ key: h.symbol, label: h.symbol, name: h.name, yieldPct: h.yieldPct, onCostPct: h.yieldOnCostPct, amount: h.forward12m }));
}

/** One bar per category: yields are income over the value (cost) of the paying holdings in it. */
function categoryBars(holdings: readonly DividendOverviewHolding[], categories: ListCategoriesResponse): YieldBar[] {
  const nameOf = new Map(categories.categories.map((c) => [c.categoryId, c.name]));
  const categoryOf = new Map(categories.assignments.map((a) => [a.symbol, nameOf.get(a.categoryId) ?? UNCATEGORISED]));
  const groups = new Map<string, { income: number; value: number; cost: number }>();
  for (const h of holdings.filter((x) => x.forward12m > 0)) {
    const name = categoryOf.get(h.symbol) ?? UNCATEGORISED;
    const g = groups.get(name) ?? { income: 0, value: 0, cost: 0 };
    groups.set(name, { income: g.income + h.forward12m, value: g.value + h.marketValue, cost: g.cost + h.costBasis });
  }
  return [...groups.entries()].map(([name, g]) => ({ key: name, label: name, name, yieldPct: pct(g.income, g.value), onCostPct: pct(g.income, g.cost), amount: Math.round(g.income * 100) / 100 }));
}

/** Bars for the yield/payout chart, largest first by the selected metric. Categories need the portfolio's category data. */
export function yieldBars(holdings: readonly DividendOverviewHolding[], metric: YieldMetric, group: YieldGroup, categories?: ListCategoriesResponse): YieldBar[] {
  const bars = group === 'category' && categories ? categoryBars(holdings, categories) : holdingBars(holdings);
  return [...bars].sort(byMetric(metric));
}
