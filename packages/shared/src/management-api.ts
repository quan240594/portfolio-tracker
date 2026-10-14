/**
 * Portfolio management contract: entities, request/response types and the extra REST routes.
 * Leaf module (types + constants only) so `schemas.ts` can use the symbol helpers without import cycles.
 *
 * Routes are scoped by the portfolio id in the path (`/portfolios/{id}/...`, 404 for an unknown portfolio) except
 * the per-user watchlist and the exports, which take an optional `?portfolioId=` like the read endpoints.
 *
 * - `GET /allocation?by=category` (existing route) needs a single `portfolioId` (400 otherwise).
 * - `GET /export/transactions` answers `text/csv` (same columns the CSV importer accepts), `GET /export/backup` JSON.
 * - Adding a watchlist symbol registers it as TRACKED and publishes TransactionsChanged (portfolioId `watchlist`),
 *   which the prices service already consumes for enrichment.
 */
import type { AllocationSlice, AssetClass, Portfolio, Transaction } from './types.js';
import type { RebalanceMode, RebalanceResult } from './rebalance.js';

export const MANAGEMENT_ROUTES = {
  getPortfolioSettings: 'GET /portfolios/{id}/settings',
  updatePortfolioSettings: 'PUT /portfolios/{id}/settings',
  listCategories: 'GET /portfolios/{id}/categories',
  createCategory: 'POST /portfolios/{id}/categories',
  updateCategory: 'PATCH /portfolios/{id}/categories/{cid}',
  deleteCategory: 'DELETE /portfolios/{id}/categories/{cid}',
  assignCategoryHoldings: 'PUT /portfolios/{id}/categories/{cid}/holdings',
  rebalance: 'GET /portfolios/{id}/rebalance',
  listAssets: 'GET /portfolios/{id}/assets',
  createAsset: 'POST /portfolios/{id}/assets',
  updateAsset: 'PATCH /portfolios/{id}/assets/{aid}',
  deleteAsset: 'DELETE /portfolios/{id}/assets/{aid}',
  putValuation: 'PUT /portfolios/{id}/assets/{aid}/valuations',
  deleteValuation: 'DELETE /portfolios/{id}/assets/{aid}/valuations/{date}',
  listWatchlist: 'GET /watchlist',
  addWatchlist: 'POST /watchlist',
  removeWatchlist: 'DELETE /watchlist/{symbol}',
  exportTransactions: 'GET /export/transactions',
  exportBackup: 'GET /export/backup',
} as const;

export const MAX_CATEGORIES = 20;
export const MAX_CUSTOM_ASSETS = 50;
export const MAX_VALUATIONS = 500;
export const MAX_WATCHLIST = 100;
/** `portfolioId` carried by the TransactionsChanged event published for watchlist additions. */
export const WATCHLIST_EVENT_PORTFOLIO_ID = 'watchlist';

export const CASH_SYMBOL_PREFIX = 'CASH.';
export const CUSTOM_SYMBOL_PREFIX = 'CUSTOM:';

/** Types that only move cash (symbol `CASH.<ccy>`, amount = quantity * price). */
export const CASH_TRANSACTION_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'FEE', 'INTEREST'] as const;
export type CashTransactionType = (typeof CASH_TRANSACTION_TYPES)[number];
export const isCashTransactionType = (type: string): type is CashTransactionType =>
  (CASH_TRANSACTION_TYPES as readonly string[]).includes(type);

export const cashSymbol = (currency: string): string => `${CASH_SYMBOL_PREFIX}${currency.toUpperCase()}`;
/** `CASH.<3 letters>`; the fixed length keeps exchange-suffixed tickers (CASH.AS) out. */
export const isCashSymbol = (symbol: string): boolean => /^CASH\.[A-Za-z]{3}$/.test(symbol);
export const customSymbol = (assetId: string): string => `${CUSTOM_SYMBOL_PREFIX}${assetId}`;
export const isCustomSymbol = (symbol: string): boolean => symbol.startsWith(CUSTOM_SYMBOL_PREFIX);
/** True for symbols a market-data provider can price; cash and custom assets have no price feed. */
export const isMarketSymbol = (symbol: string): boolean => !isCashSymbol(symbol) && !isCustomSymbol(symbol);
export const marketSymbols = (symbols: readonly string[]): string[] => symbols.filter(isMarketSymbol);

export interface PortfolioSettings {
  portfolioId: string;
  userId: string;
  /** Cash tracking: BUY/SELL/DIVIDEND and cash movements maintain a cash balance that counts in totals. Default off. */
  trackCash: boolean;
  /** Default dividend withholding tax in percent (0-100), used by the transaction form to prefill `fee`. */
  withholdingTaxRate?: number;
  updatedAt: string;
}
export type UpdatePortfolioSettingsRequest = { trackCash: boolean; withholdingTaxRate?: number | null };

export interface Category {
  categoryId: string;
  userId: string;
  portfolioId: string;
  name: string;
  /** `#rrggbb` */
  color: string;
  /** Target weight in percent (0-100); targets of a portfolio sum to at most 100, the remainder is unallocated. */
  targetWeight: number;
  createdAt: string;
  updatedAt: string;
}

/** A holding (symbol incl. `CASH.<ccy>` / `CUSTOM:<id>`) belongs to at most one category per portfolio. */
export interface CategoryAssignment {
  userId: string;
  portfolioId: string;
  symbol: string;
  categoryId: string;
}

export interface ListCategoriesResponse {
  categories: Category[];
  assignments: CategoryAssignment[];
  /** Sum of target weights. */
  totalTarget: number;
  /** 100 - totalTarget. */
  unallocated: number;
}
export type CreateCategoryRequest = { name: string; color: string; targetWeight: number };
export type UpdateCategoryRequest = Partial<CreateCategoryRequest>;
/** Replaces the holdings of the category; symbols currently in another category are moved. */
export type AssignCategoryHoldingsRequest = { symbols: string[] };

export interface RebalanceQuery {
  mode?: RebalanceMode;
  amount?: number;
  wholeUnits?: boolean;
  minTrade?: number;
}
export type GetRebalanceResponse = RebalanceResult;

export interface ValuationPoint {
  date: string;
  /** Value in the asset currency. */
  value: number;
}

/**
 * Non-market asset (real estate, savings, P2P loans, private equity). Valued from `valuations` (step function, the
 * latest point on or before the date) grown at `growthRate` %/year after that point. Symbol: `CUSTOM:<assetId>`.
 */
export interface CustomAsset {
  assetId: string;
  userId: string;
  portfolioId: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  /** Amount invested (asset currency); unrealized P&L = value - costBasis. */
  costBasis: number;
  /** Optional annual growth in percent, applied after the last valuation point (365-day compounding). */
  growthRate?: number;
  /** Sorted by date, at least one point. */
  valuations: ValuationPoint[];
  createdAt: string;
  updatedAt: string;
}
export type CreateCustomAssetRequest = {
  name: string;
  assetClass?: AssetClass;
  currency: string;
  value: number;
  /** Date of the initial valuation (default: today). */
  date?: string;
  costBasis?: number;
  growthRate?: number | null;
};
export type UpdateCustomAssetRequest = {
  name?: string;
  assetClass?: AssetClass;
  costBasis?: number;
  growthRate?: number | null;
};
export type PutValuationRequest = ValuationPoint;
export type CustomAssetWithValue = CustomAsset & { currentValueLocal: number; currentValue: number };
export type ListAssetsResponse = { baseCurrency: string; assets: CustomAssetWithValue[] };

export interface WatchlistEntry {
  userId: string;
  symbol: string;
  addedAt: string;
}
export interface WatchlistItem {
  symbol: string;
  name?: string;
  currency?: string;
  /** Latest price in the quote currency; absent until the prices service has enriched the symbol. */
  price?: number;
  previousClose?: number;
  change?: number;
  /** Percent. */
  changePct?: number;
  asOf?: string;
  addedAt: string;
}
export type ListWatchlistResponse = { items: WatchlistItem[] };
export type AddWatchlistRequest = { symbol: string };

export type CategoryAllocationResponse = {
  by: 'category';
  baseCurrency: string;
  slices: AllocationSlice[];
};

export interface BackupResponse {
  version: 1;
  exportedAt: string;
  baseCurrency: string;
  portfolios: Portfolio[];
  settings: PortfolioSettings[];
  transactions: Transaction[];
  categories: Category[];
  categoryAssignments: CategoryAssignment[];
  customAssets: CustomAsset[];
  watchlist: WatchlistEntry[];
}
