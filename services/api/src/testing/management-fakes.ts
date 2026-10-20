import type { Category, CategoryAssignment, ClassificationOverrideItem, CustomAsset, GoalItem, PortfolioSettings, WatchlistEntry } from '@portfolio/shared';
import type { ManagementRepository } from '../management-repository.js';

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory ManagementRepository for route tests. */
export class InMemoryManagementRepository implements ManagementRepository {
  settings: PortfolioSettings[] = [];
  categories: Category[] = [];
  assignments: CategoryAssignment[] = [];
  assets: CustomAsset[] = [];
  watchlist: WatchlistEntry[] = [];
  goals: GoalItem[] = [];
  overrides: ClassificationOverrideItem[] = [];

  getSettings(userId: string, portfolioId: string) {
    return Promise.resolve(clone(this.settings.find((s) => s.userId === userId && s.portfolioId === portfolioId) ?? null));
  }
  listSettings(userId: string) {
    return Promise.resolve(clone(this.settings.filter((s) => s.userId === userId)));
  }
  putSettings(s: PortfolioSettings) {
    this.settings = [...this.settings.filter((x) => !(x.userId === s.userId && x.portfolioId === s.portfolioId)), clone(s)];
    return Promise.resolve();
  }
  listCategories(userId: string, portfolioId?: string) {
    return Promise.resolve(clone(this.categories.filter((c) => c.userId === userId && (portfolioId === undefined || c.portfolioId === portfolioId))));
  }
  putCategory(c: Category) {
    this.categories = [...this.categories.filter((x) => !(x.userId === c.userId && x.portfolioId === c.portfolioId && x.categoryId === c.categoryId)), clone(c)];
    return Promise.resolve();
  }
  deleteCategory(userId: string, portfolioId: string, categoryId: string) {
    this.categories = this.categories.filter((c) => !(c.userId === userId && c.portfolioId === portfolioId && c.categoryId === categoryId));
    this.assignments = this.assignments.filter((a) => !(a.userId === userId && a.portfolioId === portfolioId && a.categoryId === categoryId));
    return Promise.resolve();
  }
  listAssignments(userId: string, portfolioId?: string) {
    return Promise.resolve(clone(this.assignments.filter((a) => a.userId === userId && (portfolioId === undefined || a.portfolioId === portfolioId))));
  }
  putAssignments(assignments: readonly CategoryAssignment[]) {
    for (const a of assignments) {
      this.assignments = [...this.assignments.filter((x) => !(x.userId === a.userId && x.portfolioId === a.portfolioId && x.symbol === a.symbol)), clone(a)];
    }
    return Promise.resolve();
  }
  deleteAssignments(userId: string, portfolioId: string, symbols: readonly string[]) {
    this.assignments = this.assignments.filter((a) => !(a.userId === userId && a.portfolioId === portfolioId && symbols.includes(a.symbol)));
    return Promise.resolve();
  }
  listCustomAssets(userId: string, portfolioId?: string) {
    return Promise.resolve(clone(this.assets.filter((a) => a.userId === userId && (portfolioId === undefined || a.portfolioId === portfolioId))));
  }
  getCustomAsset(userId: string, portfolioId: string, assetId: string) {
    return Promise.resolve(clone(this.assets.find((a) => a.userId === userId && a.portfolioId === portfolioId && a.assetId === assetId) ?? null));
  }
  putCustomAsset(asset: CustomAsset) {
    this.assets = [...this.assets.filter((a) => !(a.userId === asset.userId && a.portfolioId === asset.portfolioId && a.assetId === asset.assetId)), clone(asset)];
    return Promise.resolve();
  }
  deleteCustomAsset(userId: string, portfolioId: string, assetId: string) {
    this.assets = this.assets.filter((a) => !(a.userId === userId && a.portfolioId === portfolioId && a.assetId === assetId));
    return Promise.resolve();
  }
  listWatchlist(userId: string) {
    return Promise.resolve(clone(this.watchlist.filter((w) => w.userId === userId)));
  }
  addWatchlistEntry(entry: WatchlistEntry) {
    if (this.watchlist.some((w) => w.userId === entry.userId && w.symbol === entry.symbol)) return Promise.resolve(false);
    this.watchlist.push(clone(entry));
    return Promise.resolve(true);
  }
  deleteWatchlistEntry(userId: string, symbol: string) {
    const before = this.watchlist.length;
    this.watchlist = this.watchlist.filter((w) => !(w.userId === userId && w.symbol === symbol));
    return Promise.resolve(this.watchlist.length < before);
  }
  getGoal(userId: string, scope: string) {
    return Promise.resolve(clone(this.goals.find((g) => g.userId === userId && g.portfolioId === scope) ?? null));
  }
  putGoal(goal: GoalItem) {
    this.goals = [...this.goals.filter((g) => !(g.userId === goal.userId && g.portfolioId === goal.portfolioId)), clone(goal)];
    return Promise.resolve();
  }
  deleteGoal(userId: string, scope: string) {
    this.goals = this.goals.filter((g) => !(g.userId === userId && g.portfolioId === scope));
    return Promise.resolve();
  }
  getClassificationOverrides(userId: string, symbols: readonly string[]) {
    const wanted = new Set(symbols);
    return Promise.resolve(clone(Object.fromEntries(this.overrides.filter((o) => o.userId === userId && wanted.has(o.symbol)).map((o) => [o.symbol, o]))));
  }
  listClassificationOverrides(userId: string) {
    return Promise.resolve(clone(this.overrides.filter((o) => o.userId === userId).sort((a, b) => a.symbol.localeCompare(b.symbol))));
  }
  putClassificationOverrides(items: readonly ClassificationOverrideItem[]) {
    for (const item of items) this.overrides = [...this.overrides.filter((o) => !(o.userId === item.userId && o.symbol === item.symbol)), clone(item)];
    return Promise.resolve();
  }
  deleteClassificationOverride(userId: string, symbol: string) {
    this.overrides = this.overrides.filter((o) => !(o.userId === userId && o.symbol === symbol));
    return Promise.resolve();
  }
  async deletePortfolioData(userId: string, portfolioId: string) {
    this.settings = this.settings.filter((s) => !(s.userId === userId && s.portfolioId === portfolioId));
    this.categories = this.categories.filter((c) => !(c.userId === userId && c.portfolioId === portfolioId));
    this.assignments = this.assignments.filter((a) => !(a.userId === userId && a.portfolioId === portfolioId));
    this.assets = this.assets.filter((a) => !(a.userId === userId && a.portfolioId === portfolioId));
    this.goals = this.goals.filter((g) => !(g.userId === userId && g.portfolioId === portfolioId));
    await Promise.resolve();
  }
}
