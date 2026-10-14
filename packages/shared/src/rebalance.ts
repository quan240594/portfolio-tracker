import { PortfolioError } from './portfolio.js';

export const REBALANCE_MODES = ['buy-only', 'full'] as const;
export type RebalanceMode = (typeof REBALANCE_MODES)[number];

export interface RebalanceCategory {
  categoryId: string;
  name: string;
  color?: string;
  /** Percent of the total portfolio value (0-100). */
  targetWeight: number;
}

export interface RebalanceHolding {
  symbol: string;
  name: string;
  /** null = uncategorized: counts as "unallocated", never traded. */
  categoryId: string | null;
  /** Base currency. */
  marketValue: number;
  /** Base currency per unit. */
  priceBase: number;
  /** False for cash and custom assets: they count towards their category but are never bought or sold. */
  tradable: boolean;
}

export interface RebalanceInput {
  holdings: readonly RebalanceHolding[];
  categories: readonly RebalanceCategory[];
  mode: RebalanceMode;
  /** New money to invest (>= 0, base currency). `buy-only` needs it to suggest anything; `full` may add it. */
  amount?: number;
  /** Trade whole units only (buys are floored, leftover money is topped up with single units when affordable). */
  wholeUnits?: boolean;
  /** Trades below this value (base currency) are dropped. */
  minTrade?: number;
}

export interface RebalanceTrade {
  symbol: string;
  name: string;
  categoryId: string;
  action: 'BUY' | 'SELL';
  units: number;
  /** Base currency per unit. */
  price: number;
  /** units * price, base currency. */
  value: number;
}

export interface RebalanceRow {
  categoryId: string | null;
  name: string;
  color?: string;
  targetWeight: number;
  valueBefore: number;
  /** Percent of `totalAfter`'s basis (portfolio value + new money). */
  weightBefore: number;
  /** weight - target, percentage points. */
  driftBefore: number;
  /** value - target value, base currency. */
  driftValueBefore: number;
  valueAfter: number;
  weightAfter: number;
  driftAfter: number;
  driftValueAfter: number;
}

export interface RebalanceResult {
  mode: RebalanceMode;
  amount: number;
  totalBefore: number;
  /** totalBefore + amount: the base on which targets and weights are computed. */
  basis: number;
  rows: RebalanceRow[];
  /** Holdings outside every category; target = 100 - sum of category targets, never traded. */
  unallocated: RebalanceRow;
  trades: RebalanceTrade[];
  /** New money plus sale proceeds that is not spent on the suggested buys. */
  leftoverCash: number;
  warnings: string[];
}

const EPS = 1e-9;
const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

interface Plan {
  category: RebalanceCategory;
  current: number;
  target: number;
  tradables: RebalanceHolding[];
}

interface Ledger {
  trades: Map<string, RebalanceTrade>;
  categoryDelta: Map<string, number>;
}

const isTradable = (h: RebalanceHolding) => h.tradable && h.priceBase > 0;

function toUnits(value: number, price: number, wholeUnits: boolean): number {
  const raw = value / price;
  return wholeUnits ? Math.floor(raw + EPS) : round(raw, 6);
}

/** Splits `value` over the holdings pro rata to their market value (equally when all are worth 0). */
function spread(holdings: readonly RebalanceHolding[], value: number): { holding: RebalanceHolding; value: number }[] {
  const total = sum(holdings.map((h) => h.marketValue));
  return holdings.map((holding) => ({
    holding,
    value: total > EPS ? (value * holding.marketValue) / total : value / holdings.length,
  }));
}

function record(ledger: Ledger, plan: Plan, h: RebalanceHolding, action: 'BUY' | 'SELL', units: number): void {
  if (units <= 0) return;
  const existing = ledger.trades.get(h.symbol);
  const totalUnits = (existing?.units ?? 0) + units;
  const trade: RebalanceTrade = {
    symbol: h.symbol,
    name: h.name,
    categoryId: plan.category.categoryId,
    action,
    units: round(totalUnits, 6),
    price: h.priceBase,
    value: round(totalUnits * h.priceBase),
  };
  ledger.trades.set(h.symbol, trade);
  const sign = action === 'BUY' ? 1 : -1;
  ledger.categoryDelta.set(plan.category.categoryId, (ledger.categoryDelta.get(plan.category.categoryId) ?? 0) + sign * units * h.priceBase);
}

/** Records the trades that move roughly `value` through the tradable holdings of a category. Returns the value traded. */
function trade(ledger: Ledger, plan: Plan, action: 'BUY' | 'SELL', value: number, opts: { wholeUnits: boolean; minTrade: number }): number {
  let done = 0;
  for (const part of spread(plan.tradables, value)) {
    const h = part.holding;
    let units = toUnits(part.value, h.priceBase, opts.wholeUnits);
    if (action === 'SELL') units = Math.min(units, h.marketValue / h.priceBase);
    const tradeValue = units * h.priceBase;
    if (units <= 0 || tradeValue < opts.minTrade - EPS) continue;
    record(ledger, plan, h, action, units);
    done += tradeValue;
  }
  return done;
}

/**
 * Whole-unit rounding leaves money unspent: buy single extra units where the category is still furthest below target
 * and the unit fits the leftover, as long as it does not overshoot the target by more than half a unit.
 */
function topUp(ledger: Ledger, plans: readonly Plan[], leftover: number, opts: { minTrade: number }): number {
  let cash = leftover;
  for (let guard = 0; guard < 10_000; guard++) {
    let best: { plan: Plan; holding: RebalanceHolding; gap: number } | undefined;
    for (const plan of plans) {
      const gap = plan.target - (plan.current + (ledger.categoryDelta.get(plan.category.categoryId) ?? 0));
      const holding = [...plan.tradables]
        .sort((a, b) => b.marketValue - a.marketValue || a.symbol.localeCompare(b.symbol))
        .find((h) => h.priceBase <= cash + EPS && gap >= h.priceBase / 2 && h.priceBase >= opts.minTrade - EPS);
      if (holding && (!best || gap > best.gap)) best = { plan, holding, gap };
    }
    if (!best) break;
    record(ledger, best.plan, best.holding, 'BUY', 1);
    cash -= best.holding.priceBase;
  }
  return cash;
}

function makeRow(
  base: { categoryId: string | null; name: string; color?: string; targetWeight: number },
  valueBefore: number,
  valueAfter: number,
  basis: number,
): RebalanceRow {
  const weight = (v: number) => (basis > EPS ? (v / basis) * 100 : 0);
  const targetValue = (basis * base.targetWeight) / 100;
  return {
    ...base,
    valueBefore: round(valueBefore),
    weightBefore: round(weight(valueBefore)),
    driftBefore: round(weight(valueBefore) - base.targetWeight),
    driftValueBefore: round(valueBefore - targetValue),
    valueAfter: round(valueAfter),
    weightAfter: round(weight(valueAfter)),
    driftAfter: round(weight(valueAfter) - base.targetWeight),
    driftValueAfter: round(valueAfter - targetValue),
  };
}

function validate(input: RebalanceInput): void {
  const targetSum = sum(input.categories.map((c) => c.targetWeight));
  if (targetSum > 100 + EPS) throw new PortfolioError(`Target weights add up to ${round(targetSum)}%, which is more than 100%`);
  if ((input.amount ?? 0) < 0 || Number.isNaN(input.amount ?? 0)) throw new PortfolioError('Amount must be zero or positive');
  if ((input.minTrade ?? 0) < 0) throw new PortfolioError('Minimum trade size must be zero or positive');
}

/**
 * Suggests trades that move category weights towards their targets (percent of portfolio value + new money).
 *
 * - `buy-only`: invests `amount` into categories below target (pro rata to their shortfall, never selling).
 * - `full`: sells from categories above target and buys for those below; sale proceeds and `amount` fund the buys.
 * Inside a category, trades are spread pro rata to the holdings' market value. Uncategorized holdings, cash and custom
 * assets count towards the totals but are never traded. Buys are scaled down when the budget (amount + proceeds) is
 * short; whatever is not spent is reported as `leftoverCash`.
 */
export function calculateRebalance(input: RebalanceInput): RebalanceResult {
  validate(input);
  const { holdings, categories, mode } = input;
  const amount = input.amount ?? 0;
  const opts = { wholeUnits: input.wholeUnits ?? false, minTrade: input.minTrade ?? 0 };
  const known = new Set(categories.map((c) => c.categoryId));
  const totalBefore = sum(holdings.map((h) => h.marketValue));
  const basis = totalBefore + amount;

  const plans: Plan[] = categories.map((category) => {
    const members = holdings.filter((h) => h.categoryId === category.categoryId);
    return {
      category,
      current: sum(members.map((h) => h.marketValue)),
      target: (basis * category.targetWeight) / 100,
      tradables: members.filter(isTradable),
    };
  });

  const ledger: Ledger = { trades: new Map(), categoryDelta: new Map() };
  const warnings: string[] = [];
  let proceeds = 0;
  if (mode === 'full') {
    for (const plan of plans.filter((p) => p.current > p.target + EPS)) {
      proceeds += trade(ledger, plan, 'SELL', Math.min(plan.current - plan.target, sum(plan.tradables.map((h) => h.marketValue))), opts);
    }
  }

  const wanted = plans.map((p) => Math.max(0, p.target - p.current));
  const budget = amount + proceeds;
  const wantedTotal = sum(wanted);
  const scale = wantedTotal > budget && wantedTotal > EPS ? budget / wantedTotal : 1;
  let spent = 0;
  plans.forEach((plan, i) => {
    if (wanted[i]! <= EPS) return;
    if (plan.tradables.length === 0) {
      warnings.push(`"${plan.category.name}" is below its target but has no holdings that can be bought.`);
      return;
    }
    spent += trade(ledger, plan, 'BUY', wanted[i]! * scale, opts);
  });

  let leftoverCash = budget - spent;
  if (opts.wholeUnits) leftoverCash = topUp(ledger, plans, leftoverCash, opts);

  const rows = plans.map((p) =>
    makeRow(
      { categoryId: p.category.categoryId, name: p.category.name, ...(p.category.color ? { color: p.category.color } : {}), targetWeight: p.category.targetWeight },
      p.current,
      p.current + (ledger.categoryDelta.get(p.category.categoryId) ?? 0),
      basis,
    ),
  );
  const loose = sum(holdings.filter((h) => h.categoryId === null || !known.has(h.categoryId)).map((h) => h.marketValue));
  const unallocated = makeRow(
    { categoryId: null, name: 'Unallocated', targetWeight: round(100 - sum(categories.map((c) => c.targetWeight))) },
    loose,
    loose,
    basis,
  );

  const trades = [...ledger.trades.values()].sort(
    (a, b) => Number(a.action === 'BUY') - Number(b.action === 'BUY') || b.value - a.value || a.symbol.localeCompare(b.symbol),
  );
  return {
    mode,
    amount: round(amount),
    totalBefore: round(totalBefore),
    basis: round(basis),
    rows,
    unallocated,
    trades,
    leftoverCash: round(Math.max(0, leftoverCash)),
    warnings,
  };
}

/** Plain CSV of the suggested trades (header: symbol,name,action,units,price,value). */
export function rebalanceTradesToCsv(trades: readonly RebalanceTrade[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = trades.map((t) => [t.symbol, t.name, t.action, t.units, t.price, t.value].map(cell).join(','));
  return ['symbol,name,action,units,price,value', ...lines].join('\n') + '\n';
}
