import type { MANAGEMENT_ROUTES } from '@portfolio/shared';
import type { RouteHandler } from '../router.js';
import * as assets from './assets.js';
import * as categories from './categories.js';
import { exportBackup, exportTransactions } from './export.js';
import { getRebalance } from './rebalance.js';
import * as watchlist from './watchlist.js';

/** Handlers of the portfolio-management routes (registered by router.ts next to the core ones). */
export const managementHandlers: Record<keyof typeof MANAGEMENT_ROUTES, RouteHandler> = {
  getPortfolioSettings: categories.getPortfolioSettings,
  updatePortfolioSettings: categories.updatePortfolioSettings,
  listCategories: categories.listCategories,
  createCategory: categories.createCategory,
  updateCategory: categories.updateCategory,
  deleteCategory: categories.deleteCategory,
  assignCategoryHoldings: categories.assignCategoryHoldings,
  rebalance: getRebalance,
  listAssets: assets.listAssets,
  createAsset: assets.createAsset,
  updateAsset: assets.updateAsset,
  deleteAsset: assets.deleteAsset,
  putValuation: assets.putValuation,
  deleteValuation: assets.deleteValuation,
  listWatchlist: watchlist.listWatchlist,
  addWatchlist: watchlist.addWatchlist,
  removeWatchlist: watchlist.removeWatchlist,
  exportTransactions,
  exportBackup,
};
