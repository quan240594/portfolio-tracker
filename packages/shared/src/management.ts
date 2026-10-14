/**
 * Portfolio management engine: cash tracking, custom assets, categories/target allocation, exports.
 * Pure functions only (no I/O); see docs/architecture.md "Portfolio management".
 *
 * Cash model: with `trackCash` on for a portfolio, every transaction of that portfolio moves its cash balance in the
 * transaction's own currency (BUY -(qty*price+fee), SELL/DIVIDEND +(qty*price-fee), DEPOSIT/INTEREST +qty*price,
 * WITHDRAWAL/FEE -qty*price). The balance per currency is valued at the latest FX rate, shown as `CASH.<ccy>` holdings
 * and included in totalValue/totalCost (cash has no P&L). With `trackCash` off cash movements are ignored entirely.
 */
import { z } from 'zod';
import { FxTimeline } from './fx.js';
import {
  MAX_VALUATIONS,
  cashSymbol,
  customSymbol,
  isCustomSymbol,
  isMarketSymbol,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
} from './management-api.js';
import { buildPositions, sortTransactions, txRate, type PortfolioResult, type ValueHistoryExtra } from './portfolio.js';
import type { RebalanceHolding } from './rebalance.js';
import { ASSET_CLASSES, type AllocationSlice, type FxDay, type FxRates, type Holding, type Transaction } from './types.js';
import { CSV_COLUMNS, currencySchema, isoDateSchema, symbolSchema } from './schemas.js';

export * from './rebalance.js';

// --- DynamoDB keys (single table, scoped by user; none of these prefixes overlaps PORTFOLIO#/TXN#/IMPORT#) ---------

export const MANAGEMENT_ENTITY = {
  settings: 'PORTFOLIO_SETTINGS',
  category: 'CATEGORY',
  categoryAssignment: 'CATEGORY_ASSIGNMENT',
  customAsset: 'CUSTOM_ASSET',
  watchlist: 'WATCHLIST',
} as const;

/**
 * | Entity              | PK            | SK                                 | entityType          |
 * |---------------------|---------------|------------------------------------|---------------------|
 * | Portfolio settings  | USER#{userId} | PSETTINGS#{portfolioId}            | PORTFOLIO_SETTINGS  |
 * | Category            | USER#{userId} | CATEGORY#{portfolioId}#{categoryId}| CATEGORY            |
 * | Category assignment | USER#{userId} | CATASSIGN#{portfolioId}#{symbol}   | CATEGORY_ASSIGNMENT |
 * | Custom asset        | USER#{userId} | ASSET#{portfolioId}#{assetId}      | CUSTOM_ASSET        |
 * | Watchlist entry     | USER#{userId} | WATCH#{symbol}                     | WATCHLIST           |
 */
export const managementKeys = {
  settings: (userId: string, portfolioId: string) => ({ PK: `USER#${userId}`, SK: `PSETTINGS#${portfolioId}` }),
  settingsPrefix: 'PSETTINGS#',
  category: (userId: string, portfolioId: string, categoryId: string) => ({ PK: `USER#${userId}`, SK: `CATEGORY#${portfolioId}#${categoryId}` }),
  categoryPrefix: (portfolioId?: string) => (portfolioId === undefined ? 'CATEGORY#' : `CATEGORY#${portfolioId}#`),
  assignment: (userId: string, portfolioId: string, symbol: string) => ({ PK: `USER#${userId}`, SK: `CATASSIGN#${portfolioId}#${symbol}` }),
  assignmentPrefix: (portfolioId?: string) => (portfolioId === undefined ? 'CATASSIGN#' : `CATASSIGN#${portfolioId}#`),
  customAsset: (userId: string, portfolioId: string, assetId: string) => ({ PK: `USER#${userId}`, SK: `ASSET#${portfolioId}#${assetId}` }),
  customAssetPrefix: (portfolioId?: string) => (portfolioId === undefined ? 'ASSET#' : `ASSET#${portfolioId}#`),
  watchlist: (userId: string, symbol: string) => ({ PK: `USER#${userId}`, SK: `WATCH#${symbol}` }),
  watchlistPrefix: 'WATCH#',
} as const;

// --- Request schemas -------------------------------------------------------------------------------------------

const CATEGORY_COLOR = /^#[0-9a-fA-F]{6}$/;
const categoryName = z.string().trim().min(1, 'Name is required').max(40);
const categoryColor = z
  .string()
  .regex(CATEGORY_COLOR, 'Color must look like #1a2b3c')
  .transform((c) => c.toLowerCase());
const percent = z.coerce.number().min(0).max(100);

export const createCategorySchema = z.object({ name: categoryName, color: categoryColor, targetWeight: percent });
export const updateCategorySchema = z
  .object({ name: categoryName, color: categoryColor, targetWeight: percent })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** Holding symbols keep the lower-case id of custom assets (`CUSTOM:<id>`); everything else is upper-cased. */
export function normalizeHoldingSymbol(raw: string): string {
  const s = raw.trim();
  return isCustomSymbol(s.toUpperCase()) ? `${s.slice(0, 7).toUpperCase()}${s.slice(7).toLowerCase()}` : s.toUpperCase();
}
const holdingSymbol = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9.\-:^=]+$/, 'Invalid symbol')
  .transform(normalizeHoldingSymbol);
export const assignHoldingsSchema = z.object({ symbols: z.array(holdingSymbol).max(200) });

export const portfolioSettingsSchema = z.object({
  trackCash: z.boolean(),
  withholdingTaxRate: z.union([z.null(), percent]).optional(),
});

const assetName = z.string().trim().min(1, 'Name is required').max(60);
const assetClass = z.enum(ASSET_CLASSES);
const growthRate = z.union([z.null(), z.coerce.number().min(-100).max(1000)]).optional();
const nonNegative = z.coerce.number().nonnegative();
export const createCustomAssetSchema = z.object({
  name: assetName,
  assetClass: assetClass.default('OTHER'),
  currency: currencySchema,
  value: nonNegative,
  date: isoDateSchema.optional(),
  costBasis: nonNegative.optional(),
  growthRate,
});
export const updateCustomAssetSchema = z
  .object({ name: assetName, assetClass, costBasis: nonNegative, growthRate })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const valuationSchema = z.object({ date: isoDateSchema, value: nonNegative });
export const addWatchlistSchema = z.object({ symbol: symbolSchema });

const queryBoolean = z.preprocess((v) => (v === undefined || v === '' ? undefined : v === true || v === 'true' || v === '1'), z.boolean().optional());
export const rebalanceQuerySchema = z.object({
  mode: z.enum(['buy-only', 'full']).default('buy-only'),
  amount: z.coerce.number().nonnegative().default(0),
  wholeUnits: queryBoolean,
  minTrade: z.coerce.number().nonnegative().default(0),
});

// --- Helpers ---------------------------------------------------------------------------------------------------

const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const CASH_DUST = 0.005;
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Fee for a dividend: `ratePct` percent of the gross amount, rounded to cents. */
export const withholdingFee = (quantity: number, price: number, ratePct: number): number => round((quantity * price * ratePct) / 100);

// --- Cash ------------------------------------------------------------------------------------------------------

/** Effect of a transaction on the cash balance, in the transaction's currency (0 for SPLIT). */
export function cashDelta(t: Transaction): number {
  switch (t.type) {
    case 'BUY':
      return -(t.quantity * t.price + t.fee);
    case 'SELL':
    case 'DIVIDEND':
      return t.quantity * t.price - t.fee;
    case 'DEPOSIT':
    case 'INTEREST':
      return t.quantity * t.price;
    case 'WITHDRAWAL':
    case 'FEE':
      return -(t.quantity * t.price);
    case 'SPLIT':
      return 0;
  }
}

/** Cash balance per currency from the transactions of the portfolios in `cashPortfolioIds` (up to `upTo` inclusive). */
export function cashBalances(
  transactions: readonly Transaction[],
  cashPortfolioIds: ReadonlySet<string>,
  upTo?: string,
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const t of transactions) {
    if (!cashPortfolioIds.has(t.portfolioId) || (upTo !== undefined && t.date > upTo)) continue;
    balances.set(t.currency, (balances.get(t.currency) ?? 0) + cashDelta(t));
  }
  return balances;
}

export interface ExternalCashFlow {
  date: string;
  /** Base currency, from the portfolio's perspective: money paid in is positive, money taken out negative. */
  amount: number;
  portfolioId: string;
}

/**
 * External cash flows for performance measures such as XIRR. Portfolios with cash tracking contribute their
 * DEPOSIT (+) and WITHDRAWAL (-) transactions; portfolios without it contribute what actually crossed the boundary of the
 * invested money: BUY cost (+), SELL proceeds (-) and DIVIDEND net (-). Converted at the transaction's rate.
 * Analytics flips the sign if it needs the investor's perspective.
 */
export function externalCashFlows(
  transactions: readonly Transaction[],
  cashPortfolioIds: ReadonlySet<string>,
  fx: FxRates,
  fxHistory?: readonly FxDay[],
): ExternalCashFlow[] {
  const timeline = new FxTimeline(fx, fxHistory);
  const flows: ExternalCashFlow[] = [];
  for (const t of sortTransactions(transactions)) {
    const tracked = cashPortfolioIds.has(t.portfolioId);
    let local = 0;
    if (tracked && t.type === 'DEPOSIT') local = t.quantity * t.price;
    else if (tracked && t.type === 'WITHDRAWAL') local = -(t.quantity * t.price);
    else if (!tracked && t.type === 'BUY') local = t.quantity * t.price + t.fee;
    else if (!tracked && (t.type === 'SELL' || t.type === 'DIVIDEND')) local = -(t.quantity * t.price - t.fee);
    else continue;
    flows.push({ date: t.date, amount: local / txRate(t, timeline), portfolioId: t.portfolioId });
  }
  return flows;
}

// --- Custom assets ---------------------------------------------------------------------------------------------

/** Sorted copy of the points with one point per date (the later entry wins). */
export function sortValuations(points: readonly { date: string; value: number }[]): { date: string; value: number }[] {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export const firstValuationDate = (asset: Pick<CustomAsset, 'valuations'>): string | undefined => sortValuations(asset.valuations)[0]?.date;

/**
 * Value in the asset currency on `date`: the latest valuation point on or before it, compounded at `growthRate`
 * %/year (365-day basis) for the days since that point. 0 before the first point (not owned yet).
 */
export function customAssetValueLocal(asset: Pick<CustomAsset, 'valuations' | 'growthRate'>, date: string): number {
  let last: { date: string; value: number } | undefined;
  for (const p of sortValuations(asset.valuations)) {
    if (p.date > date) break;
    last = p;
  }
  if (!last) return 0;
  const growth = asset.growthRate ?? 0;
  if (growth === 0) return last.value;
  return last.value * (1 + growth / 100) ** (daysBetween(last.date, date) / 365);
}

/** Resulting asset (with sorted, deduplicated valuations) after upserting a valuation point; enforces MAX_VALUATIONS. */
export function upsertValuation<T extends Pick<CustomAsset, 'valuations'>>(asset: T, point: { date: string; value: number }): T | null {
  const valuations = sortValuations([...asset.valuations, point]);
  return valuations.length > MAX_VALUATIONS ? null : { ...asset, valuations };
}

// --- Applying cash & custom assets to a portfolio result -------------------------------------------------------

export interface ManagementInput {
  /** The same (scoped) transactions that were passed to calculatePortfolio. */
  transactions: readonly Transaction[];
  /** Portfolios (within the scope) with cash tracking on. */
  cashPortfolioIds: ReadonlySet<string>;
  customAssets: readonly CustomAsset[];
  fx: FxRates;
  fxHistory?: readonly FxDay[];
  /** YYYY-MM-DD used to value custom assets. */
  today: string;
}

function cashHolding(currency: string, balance: number, valueBase: number, rate: number): Holding {
  return {
    symbol: cashSymbol(currency),
    name: `Cash (${currency})`,
    assetClass: 'CASH',
    sector: 'Cash',
    country: 'Global',
    currency,
    quantity: round(balance, 4),
    averageCostLocal: 1,
    priceLocal: 1,
    averageCostBase: round(1 / rate, 4),
    priceBase: round(1 / rate, 4),
    priceStale: false,
    costBasis: valueBase,
    marketValue: valueBase,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    currencyEffect: 0,
    dayChange: 0,
    dayChangePct: 0,
    realizedPnl: 0,
    dividendsReceived: 0,
    weight: 0,
  };
}

function customHolding(asset: CustomAsset, valueLocal: number, timeline: FxTimeline): Holding & { costBase: number } {
  const first = firstValuationDate(asset)!;
  const costBase = timeline.toBase(asset.costBasis, asset.currency, first);
  const marketValue = timeline.toBase(valueLocal, asset.currency);
  const valueAtCostFx = asset.currency !== timeline.base && asset.costBasis > 0 ? (valueLocal * costBase) / asset.costBasis : marketValue;
  const pnl = marketValue - costBase;
  return {
    symbol: customSymbol(asset.assetId),
    name: asset.name,
    assetClass: asset.assetClass,
    sector: 'Custom assets',
    country: 'Unknown',
    currency: asset.currency,
    quantity: 1,
    averageCostLocal: round(asset.costBasis, 4),
    priceLocal: round(valueLocal, 4),
    averageCostBase: round(costBase, 4),
    priceBase: round(marketValue, 4),
    priceStale: false,
    costBasis: round(costBase),
    marketValue: round(marketValue),
    unrealizedPnl: round(pnl),
    unrealizedPnlPct: costBase > 0 ? round((pnl / costBase) * 100) : 0,
    currencyEffect: round(marketValue - valueAtCostFx),
    dayChange: 0,
    dayChangePct: 0,
    realizedPnl: 0,
    dividendsReceived: 0,
    weight: 0,
    costBase,
  };
}

/**
 * Adds cash (`CASH.<ccy>` rows) and custom assets (`CUSTOM:<id>` rows) to the result of calculatePortfolio and updates
 * totals, weights and returns. Cash counts as cost = value (no P&L); interest and account fees are part of the return.
 * Returns the input unchanged when there is neither cash tracking nor a custom asset.
 */
export function applyManagement(result: PortfolioResult, input: ManagementInput): PortfolioResult {
  const { cashPortfolioIds, customAssets, fx, fxHistory, today } = input;
  const cashActive = cashPortfolioIds.size > 0;
  const owned = customAssets.filter((a) => firstValuationDate(a) !== undefined && firstValuationDate(a)! <= today);
  if (!cashActive && owned.length === 0) return result;

  const timeline = new FxTimeline(fx, fxHistory);
  const cashRows: Holding[] = [];
  for (const [currency, balance] of [...cashBalances(input.transactions, cashPortfolioIds)].sort(([a], [b]) => a.localeCompare(b))) {
    if (Math.abs(balance) < CASH_DUST) continue;
    const valueBase = round(timeline.toBase(balance, currency));
    cashRows.push(cashHolding(currency, balance, valueBase, timeline.rate(currency)));
  }
  const customRows = owned.map((a) => customHolding(a, customAssetValueLocal(a, today), timeline));
  const cashValue = sum(cashRows.map((h) => h.marketValue));
  const customValue = sum(customRows.map((h) => h.marketValue));
  const customCost = sum(customRows.map((h) => h.costBase));

  const cashIncome = sum(
    input.transactions
      .filter((t) => cashPortfolioIds.has(t.portfolioId) && (t.type === 'INTEREST' || t.type === 'FEE'))
      .map((t) => cashDelta(t) / txRate(t, timeline)),
  );
  const invested = sum([...buildPositions(input.transactions, undefined, timeline).values()].map((p) => p.investedBase)) + customCost;

  const s = result.summary;
  const totalValue = s.totalValue + cashValue + customValue;
  const totalCost = s.totalCost + cashValue + customCost;
  const unrealizedPnl = totalValue - totalCost;
  const totalReturn = unrealizedPnl + s.realizedPnl + s.dividendsReceived + cashIncome;
  const customPlain: Holding[] = customRows.map(({ costBase: _cost, ...h }) => h);
  const holdings = [...result.holdings, ...cashRows, ...customPlain]
    .map((h) => ({ ...h, weight: totalValue > 0 ? round(h.marketValue / totalValue, 4) : 0 }))
    .sort((a, b) => b.marketValue - a.marketValue || a.symbol.localeCompare(b.symbol));
  const pct = (num: number, den: number) => (Math.abs(den) < 1e-9 ? 0 : round((num / den) * 100));

  return {
    holdings,
    summary: {
      ...s,
      totalValue: round(totalValue),
      totalCost: round(totalCost),
      unrealizedPnl: round(unrealizedPnl),
      unrealizedPnlPct: pct(unrealizedPnl, totalCost),
      currencyEffect: round(s.currencyEffect + sum(customRows.map((h) => h.currencyEffect))),
      totalReturn: round(totalReturn),
      totalReturnPct: pct(totalReturn, invested),
      dayChangePct: pct(s.dayChange, totalValue - s.dayChange),
      holdingsCount: holdings.length,
      ...(cashActive ? { cashValue: round(cashValue), cashIncome: round(cashIncome) } : {}),
      ...(owned.length > 0 ? { customAssetsValue: round(customValue) } : {}),
    },
  };
}

/**
 * Cash and custom-asset value/cost per day for `buildValueHistory(..., extra)`. Must be called with ascending dates.
 * Cash counts as cost = value, custom assets at their cost basis once owned.
 */
export function managementHistoryExtra(
  input: Pick<ManagementInput, 'transactions' | 'cashPortfolioIds' | 'customAssets'>,
): ValueHistoryExtra | undefined {
  const cashTxns = sortTransactions(input.transactions.filter((t) => input.cashPortfolioIds.has(t.portfolioId)));
  if (cashTxns.length === 0 && input.customAssets.length === 0) return undefined;
  const balances = new Map<string, number>();
  let next = 0;
  return (date, timeline) => {
    while (next < cashTxns.length && cashTxns[next]!.date <= date) {
      const t = cashTxns[next++]!;
      balances.set(t.currency, (balances.get(t.currency) ?? 0) + cashDelta(t));
    }
    let value = sum([...balances].map(([currency, balance]) => timeline.toBase(balance, currency, date)));
    let invested = value;
    for (const asset of input.customAssets) {
      const first = firstValuationDate(asset);
      if (first === undefined || first > date) continue;
      value += timeline.toBase(customAssetValueLocal(asset, date), asset.currency, date);
      invested += timeline.toBase(asset.costBasis, asset.currency, first);
    }
    return { value, invested };
  };
}

// --- Categories ------------------------------------------------------------------------------------------------

export const categoryTargetTotal = (categories: readonly Pick<Category, 'targetWeight'>[]): number => round(sum(categories.map((c) => c.targetWeight)));

export const UNCATEGORIZED_KEY = 'unassigned';

/** symbol -> categoryId; assignments pointing at an unknown category are ignored. */
export function assignmentMap(categories: readonly Category[], assignments: readonly CategoryAssignment[]): Map<string, string> {
  const known = new Set(categories.map((c) => c.categoryId));
  return new Map(assignments.filter((a) => known.has(a.categoryId)).map((a) => [a.symbol, a.categoryId]));
}

/** Allocation of the holdings' market value by category (`by=category`); uncategorized holdings form one slice. */
export function calculateCategoryAllocation(
  holdings: readonly Holding[],
  categories: readonly Category[],
  assignments: readonly CategoryAssignment[],
): AllocationSlice[] {
  const map = assignmentMap(categories, assignments);
  const names = new Map(categories.map((c) => [c.categoryId, c.name]));
  const groups = new Map<string, { label: string; value: number }>();
  for (const h of holdings) {
    const key = map.get(h.symbol) ?? UNCATEGORIZED_KEY;
    const g = groups.get(key) ?? { label: names.get(key) ?? 'Uncategorized', value: 0 };
    g.value += h.marketValue;
    groups.set(key, g);
  }
  const total = sum(holdings.map((h) => h.marketValue));
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, value: round(g.value), weight: total > 0 ? round(g.value / total, 4) : 0 }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Joins holdings with their category for `calculateRebalance`. Only market-priced holdings are tradable. */
export function toRebalanceHoldings(holdings: readonly Holding[], categories: readonly Category[], assignments: readonly CategoryAssignment[]): RebalanceHolding[] {
  const map = assignmentMap(categories, assignments);
  return holdings.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    categoryId: map.get(h.symbol) ?? null,
    marketValue: h.marketValue,
    priceBase: h.priceBase,
    tradable: isMarketSymbol(h.symbol) && h.assetClass !== 'CASH',
  }));
}

// --- Export ----------------------------------------------------------------------------------------------------

const csvCell = (v: string | number | undefined): string => {
  const s = v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * Transactions as CSV in the exact format the importer accepts (header = CSV_COLUMNS, oldest first, same-day order by
 * creation). Cash and split rows round-trip as well.
 */
export function transactionsToCsv(transactions: readonly Transaction[]): string {
  const rows = sortTransactions(transactions).map((t) =>
    [t.date, t.type, t.symbol, t.quantity, t.price, t.fee, t.currency, t.note, t.fxRate].map(csvCell).join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
