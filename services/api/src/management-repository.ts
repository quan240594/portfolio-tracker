import { cond, listByPrefix, type Item, type ItemKey, type ItemStore } from '@portfolio/platform';
import {
  CLASSIFICATION_ENTITY,
  GOAL_ENTITY,
  LAYOUT_BREAKPOINTS,
  LAYOUT_ENTITY,
  MANAGEMENT_ENTITY,
  classificationKeys,
  fromItem,
  goalKeys,
  keys,
  layoutKeys,
  managementKeys,
  type Category,
  type ClassificationOverrideItem,
  type CategoryAssignment,
  type CustomAsset,
  type GoalItem,
  type LayoutBreakpoint,
  type LayoutPageId,
  type PageLayoutItem,
  type PortfolioSettings,
  type WatchlistEntry,
} from '@portfolio/shared';

/** Persistence of the portfolio-management entities (settings, categories, custom assets, watchlist). */
export interface ManagementRepository {
  getSettings(userId: string, portfolioId: string): Promise<PortfolioSettings | null>;
  /** Settings of every portfolio of the user that has any. */
  listSettings(userId: string): Promise<PortfolioSettings[]>;
  putSettings(settings: PortfolioSettings): Promise<void>;
  /** Categories of one portfolio, or of all portfolios when `portfolioId` is omitted. */
  listCategories(userId: string, portfolioId?: string): Promise<Category[]>;
  putCategory(category: Category): Promise<void>;
  /** Deletes the category and every assignment that points at it. */
  deleteCategory(userId: string, portfolioId: string, categoryId: string): Promise<void>;
  listAssignments(userId: string, portfolioId?: string): Promise<CategoryAssignment[]>;
  putAssignments(assignments: readonly CategoryAssignment[]): Promise<void>;
  deleteAssignments(userId: string, portfolioId: string, symbols: readonly string[]): Promise<void>;
  listCustomAssets(userId: string, portfolioId?: string): Promise<CustomAsset[]>;
  getCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<CustomAsset | null>;
  putCustomAsset(asset: CustomAsset): Promise<void>;
  deleteCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<void>;
  listWatchlist(userId: string): Promise<WatchlistEntry[]>;
  /** Create-only put; resolves false when the symbol is already on the watchlist. */
  addWatchlistEntry(entry: WatchlistEntry): Promise<boolean>;
  deleteWatchlistEntry(userId: string, symbol: string): Promise<boolean>;
  /** The saved goal of a scope (a portfolio id or `all`). */
  getGoal(userId: string, scope: string): Promise<GoalItem | null>;
  putGoal(goal: GoalItem): Promise<void>;
  deleteGoal(userId: string, scope: string): Promise<void>;
  /** The user's classification overrides among `symbols`, by symbol. */
  getClassificationOverrides(userId: string, symbols: readonly string[]): Promise<Record<string, ClassificationOverrideItem>>;
  listClassificationOverrides(userId: string): Promise<ClassificationOverrideItem[]>;
  putClassificationOverrides(items: readonly ClassificationOverrideItem[]): Promise<void>;
  deleteClassificationOverride(userId: string, symbol: string): Promise<void>;
  /** The stored layouts (desktop and/or mobile) of one page. */
  getLayouts(userId: string, page: LayoutPageId): Promise<PageLayoutItem[]>;
  /** Every stored layout of the user, for the backup. */
  listLayouts(userId: string): Promise<PageLayoutItem[]>;
  putLayout(item: PageLayoutItem): Promise<void>;
  /** Clears one breakpoint of a page (no error when nothing is stored). */
  deleteLayout(userId: string, page: LayoutPageId, breakpoint: LayoutBreakpoint): Promise<void>;
  /** Removes settings, categories, assignments, custom assets and the goal of a deleted portfolio. */
  deletePortfolioData(userId: string, portfolioId: string): Promise<void>;
}

/** ManagementRepository on an ItemStore: every item lives under `PK = USER#{userId}` (see `managementKeys`). */
export class ItemManagementRepository implements ManagementRepository {
  constructor(private readonly store: ItemStore) {}

  private listUser<T>(userId: string, prefix: string): Promise<T[]> {
    return listByPrefix<T>(this.store, keys.user(userId).PK, prefix, { consistent: true });
  }

  private async getOne<T>(key: ItemKey): Promise<T | null> {
    const item = await this.store.get(key, { consistent: true });
    return item ? fromItem<T>(item) : null;
  }

  private put(key: ItemKey, entityType: string, item: object, createOnly = false): Promise<boolean> {
    const stored: Item = { ...key, entityType, ...item };
    return this.store.put(stored, createOnly ? { condition: cond.notExists } : undefined);
  }

  private async remove(key: ItemKey): Promise<void> {
    await this.store.delete(key);
  }

  getSettings(userId: string, portfolioId: string): Promise<PortfolioSettings | null> {
    return this.getOne(managementKeys.settings(userId, portfolioId));
  }

  listSettings(userId: string): Promise<PortfolioSettings[]> {
    return this.listUser(userId, managementKeys.settingsPrefix);
  }

  async putSettings(s: PortfolioSettings): Promise<void> {
    await this.put(managementKeys.settings(s.userId, s.portfolioId), MANAGEMENT_ENTITY.settings, s);
  }

  listCategories(userId: string, portfolioId?: string): Promise<Category[]> {
    return this.listUser(userId, managementKeys.categoryPrefix(portfolioId));
  }

  async putCategory(c: Category): Promise<void> {
    await this.put(managementKeys.category(c.userId, c.portfolioId, c.categoryId), MANAGEMENT_ENTITY.category, c);
  }

  async deleteCategory(userId: string, portfolioId: string, categoryId: string): Promise<void> {
    const assignments = await this.listAssignments(userId, portfolioId);
    await Promise.all(assignments.filter((a) => a.categoryId === categoryId).map((a) => this.remove(managementKeys.assignment(userId, portfolioId, a.symbol))));
    await this.remove(managementKeys.category(userId, portfolioId, categoryId));
  }

  listAssignments(userId: string, portfolioId?: string): Promise<CategoryAssignment[]> {
    return this.listUser(userId, managementKeys.assignmentPrefix(portfolioId));
  }

  async putAssignments(assignments: readonly CategoryAssignment[]): Promise<void> {
    await Promise.all(
      assignments.map((a) => this.put(managementKeys.assignment(a.userId, a.portfolioId, a.symbol), MANAGEMENT_ENTITY.categoryAssignment, a)),
    );
  }

  async deleteAssignments(userId: string, portfolioId: string, symbols: readonly string[]): Promise<void> {
    await Promise.all(symbols.map((symbol) => this.remove(managementKeys.assignment(userId, portfolioId, symbol))));
  }

  listCustomAssets(userId: string, portfolioId?: string): Promise<CustomAsset[]> {
    return this.listUser(userId, managementKeys.customAssetPrefix(portfolioId));
  }

  getCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<CustomAsset | null> {
    return this.getOne(managementKeys.customAsset(userId, portfolioId, assetId));
  }

  async putCustomAsset(a: CustomAsset): Promise<void> {
    await this.put(managementKeys.customAsset(a.userId, a.portfolioId, a.assetId), MANAGEMENT_ENTITY.customAsset, a);
  }

  deleteCustomAsset(userId: string, portfolioId: string, assetId: string): Promise<void> {
    return this.remove(managementKeys.customAsset(userId, portfolioId, assetId));
  }

  listWatchlist(userId: string): Promise<WatchlistEntry[]> {
    return this.listUser(userId, managementKeys.watchlistPrefix);
  }

  addWatchlistEntry(entry: WatchlistEntry): Promise<boolean> {
    return this.put(managementKeys.watchlist(entry.userId, entry.symbol), MANAGEMENT_ENTITY.watchlist, entry, true);
  }

  deleteWatchlistEntry(userId: string, symbol: string): Promise<boolean> {
    return this.store.delete(managementKeys.watchlist(userId, symbol), { condition: cond.exists });
  }

  getGoal(userId: string, scope: string): Promise<GoalItem | null> {
    return this.getOne(goalKeys.goal(userId, scope));
  }

  async putGoal(goal: GoalItem): Promise<void> {
    await this.put(goalKeys.goal(goal.userId, goal.portfolioId), GOAL_ENTITY, goal);
  }

  deleteGoal(userId: string, scope: string): Promise<void> {
    return this.remove(goalKeys.goal(userId, scope));
  }

  async getClassificationOverrides(userId: string, symbols: readonly string[]): Promise<Record<string, ClassificationOverrideItem>> {
    if (symbols.length === 0) return {};
    const items = await this.store.getMany(symbols.map((symbol) => classificationKeys.override(userId, symbol)));
    return Object.fromEntries(items.map((item) => [String(item.symbol), fromItem<ClassificationOverrideItem>(item)]));
  }

  listClassificationOverrides(userId: string): Promise<ClassificationOverrideItem[]> {
    return this.listUser(userId, classificationKeys.prefix);
  }

  putClassificationOverrides(items: readonly ClassificationOverrideItem[]): Promise<void> {
    return this.store.batchWrite(items.map((item) => ({ type: 'put', item: { ...classificationKeys.override(item.userId, item.symbol), entityType: CLASSIFICATION_ENTITY, ...item } })));
  }

  deleteClassificationOverride(userId: string, symbol: string): Promise<void> {
    return this.remove(classificationKeys.override(userId, symbol));
  }

  async getLayouts(userId: string, page: LayoutPageId): Promise<PageLayoutItem[]> {
    const items = await this.store.getMany(LAYOUT_BREAKPOINTS.map((breakpoint) => layoutKeys.layout(userId, page, breakpoint)));
    return items.map((item) => fromItem<PageLayoutItem>(item));
  }

  listLayouts(userId: string): Promise<PageLayoutItem[]> {
    return this.listUser(userId, layoutKeys.prefix);
  }

  async putLayout(item: PageLayoutItem): Promise<void> {
    await this.put(layoutKeys.layout(item.userId, item.page, item.breakpoint), LAYOUT_ENTITY, item);
  }

  deleteLayout(userId: string, page: LayoutPageId, breakpoint: LayoutBreakpoint): Promise<void> {
    return this.remove(layoutKeys.layout(userId, page, breakpoint));
  }

  async deletePortfolioData(userId: string, portfolioId: string): Promise<void> {
    const [categories, assignments, assets] = await Promise.all([
      this.listCategories(userId, portfolioId),
      this.listAssignments(userId, portfolioId),
      this.listCustomAssets(userId, portfolioId),
    ]);
    await Promise.all([
      ...assignments.map((a) => this.remove(managementKeys.assignment(userId, portfolioId, a.symbol))),
      ...categories.map((c) => this.remove(managementKeys.category(userId, portfolioId, c.categoryId))),
      ...assets.map((a) => this.remove(managementKeys.customAsset(userId, portfolioId, a.assetId))),
      this.remove(managementKeys.settings(userId, portfolioId)),
      this.deleteGoal(userId, portfolioId),
    ]);
  }
}
