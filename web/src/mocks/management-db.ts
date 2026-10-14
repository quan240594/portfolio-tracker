/**
 * In-memory mock of the portfolio-management endpoints (cash tracking settings, categories, custom assets, watchlist).
 * Mirrors the API's validation; every number is derived with the shared calculators. Independent of db.ts (which owns the
 * transactions and calls into this module), so there is no import cycle.
 */
import {
  MAX_CATEGORIES,
  MAX_CUSTOM_ASSETS,
  MAX_WATCHLIST,
  PortfolioError,
  assignHoldingsSchema,
  categoryTargetTotal,
  createCategorySchema,
  createCustomAssetSchema,
  customAssetValueLocal,
  isCashSymbol,
  toBase,
  updateCategorySchema,
  updateCustomAssetSchema,
  upsertValuation,
  valuationSchema,
  addWatchlistSchema,
  portfolioSettingsSchema,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
  type CustomAssetWithValue,
  type ListCategoriesResponse,
  type PortfolioSettings,
  type WatchlistEntry,
  type WatchlistItem,
} from '@portfolio/shared';
import { MOCK_USER_ID, type MockSeed } from './fixtures';
import { MockHttpError } from './utils';

interface ManagementState {
  seed: MockSeed;
  settings: PortfolioSettings[];
  categories: Category[];
  assignments: CategoryAssignment[];
  assets: CustomAsset[];
  watchlist: WatchlistEntry[];
  nextId: number;
}

function init(seed: MockSeed, empty = false): ManagementState {
  const m = seed.management;
  return {
    seed,
    settings: empty ? [] : [...m.settings],
    categories: empty ? [] : [...m.categories],
    assignments: empty ? [] : [...m.assignments],
    assets: empty ? [] : [...m.assets],
    watchlist: empty ? [] : [...m.watchlist],
    nextId: 1,
  };
}

let state: ManagementState | undefined;
const s = (): ManagementState => {
  if (!state) throw new Error('Mock management store is not initialised');
  return state;
};

/** Called by db.ts whenever the main mock store is (re)created. */
export function resetManagement(seed: MockSeed, options: { empty?: boolean } = {}): void {
  state = init(seed, options.empty);
}

const nowIso = () => new Date().toISOString();
const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${s().nextId++}`;

function parse<T>(result: { success: true; data: T } | { success: false; error: { issues: { message: string }[]; flatten: () => unknown } }, message: string): T {
  if (!result.success) throw new MockHttpError(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? message, result.error.flatten());
  return result.data;
}

// --- Scope for the portfolio calculators ------------------------------------------------------------------------

/** Cash-tracking portfolios and custom assets inside a read scope (`undefined` = all portfolios). */
export function managementScope(scope: string | undefined): { cashPortfolioIds: Set<string>; customAssets: CustomAsset[] } {
  const inScope = (portfolioId: string) => scope === undefined || portfolioId === scope;
  return {
    cashPortfolioIds: new Set(s().settings.filter((x) => x.trackCash && inScope(x.portfolioId)).map((x) => x.portfolioId)),
    customAssets: s().assets.filter((a) => inScope(a.portfolioId)),
  };
}

export function deleteManagementData(portfolioId: string): void {
  const keep = <T extends { portfolioId: string }>(items: T[]) => items.filter((i) => i.portfolioId !== portfolioId);
  const st = s();
  st.settings = keep(st.settings);
  st.categories = keep(st.categories);
  st.assignments = keep(st.assignments);
  st.assets = keep(st.assets);
}

// --- Settings ---------------------------------------------------------------------------------------------------

export function getSettings(portfolioId: string): PortfolioSettings {
  return s().settings.find((x) => x.portfolioId === portfolioId) ?? { portfolioId, userId: MOCK_USER_ID, trackCash: false, updatedAt: nowIso() };
}

export function updateSettings(portfolioId: string, body: unknown): PortfolioSettings {
  const input = parse(portfolioSettingsSchema.safeParse(body), 'Invalid settings');
  const next: PortfolioSettings = {
    portfolioId,
    userId: MOCK_USER_ID,
    trackCash: input.trackCash,
    ...(typeof input.withholdingTaxRate === 'number' ? { withholdingTaxRate: input.withholdingTaxRate } : {}),
    updatedAt: nowIso(),
  };
  s().settings = [...s().settings.filter((x) => x.portfolioId !== portfolioId), next];
  return next;
}

// --- Categories -------------------------------------------------------------------------------------------------

export function listCategories(portfolioId: string): ListCategoriesResponse {
  const categories = s().categories.filter((c) => c.portfolioId === portfolioId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const known = new Set(categories.map((c) => c.categoryId));
  const totalTarget = categoryTargetTotal(categories);
  return {
    categories,
    assignments: s().assignments.filter((a) => a.portfolioId === portfolioId && known.has(a.categoryId)),
    totalTarget,
    unallocated: round(100 - totalTarget),
  };
}

function assertTargets(others: readonly Category[], targetWeight: number) {
  const total = categoryTargetTotal([...others, { targetWeight }]);
  if (total > 100) throw new MockHttpError(422, 'UNPROCESSABLE', `Target weights would add up to ${total}% (at most 100%)`, { totalTarget: total });
}

function assertUniqueName(others: readonly Category[], name: string) {
  if (others.some((c) => sameName(c.name, name))) throw new MockHttpError(409, 'CONFLICT', `A category named “${name}” already exists.`);
}

export function createCategory(portfolioId: string, body: unknown): Category {
  const input = parse(createCategorySchema.safeParse(body), 'Invalid category');
  const existing = s().categories.filter((c) => c.portfolioId === portfolioId);
  if (existing.length >= MAX_CATEGORIES) throw new MockHttpError(422, 'UNPROCESSABLE', `A portfolio can have at most ${MAX_CATEGORIES} categories.`);
  assertUniqueName(existing, input.name);
  assertTargets(existing, input.targetWeight);
  const ts = nowIso();
  const category: Category = { categoryId: newId('cat'), userId: MOCK_USER_ID, portfolioId, ...input, createdAt: ts, updatedAt: ts };
  s().categories = [...s().categories, category];
  return category;
}

function requireCategory(portfolioId: string, categoryId: string): { category: Category; others: Category[] } {
  const all = s().categories.filter((c) => c.portfolioId === portfolioId);
  const category = all.find((c) => c.categoryId === categoryId);
  if (!category) throw new MockHttpError(404, 'NOT_FOUND', `Category ${categoryId} not found`);
  return { category, others: all.filter((c) => c.categoryId !== categoryId) };
}

export function updateCategory(portfolioId: string, categoryId: string, body: unknown): Category {
  const input = parse(updateCategorySchema.safeParse(body), 'Invalid category');
  const { category, others } = requireCategory(portfolioId, categoryId);
  if (input.name !== undefined) assertUniqueName(others, input.name);
  const next = { ...category, ...input, updatedAt: nowIso() };
  assertTargets(others, next.targetWeight);
  s().categories = s().categories.map((c) => (c.categoryId === categoryId && c.portfolioId === portfolioId ? next : c));
  return next;
}

export function deleteCategory(portfolioId: string, categoryId: string): void {
  requireCategory(portfolioId, categoryId);
  s().categories = s().categories.filter((c) => !(c.portfolioId === portfolioId && c.categoryId === categoryId));
  s().assignments = s().assignments.filter((a) => !(a.portfolioId === portfolioId && a.categoryId === categoryId));
}

/** `assignable` tells which symbols are holdings of the portfolio (transactions + custom assets); cash symbols always are. */
export function assignHoldings(portfolioId: string, categoryId: string, body: unknown, assignable: (symbol: string) => boolean): ListCategoriesResponse {
  const { symbols } = parse(assignHoldingsSchema.safeParse(body), 'Invalid holdings');
  requireCategory(portfolioId, categoryId);
  const wanted = [...new Set(symbols)];
  const unknown = wanted.filter((x) => !isCashSymbol(x) && !assignable(x));
  if (unknown.length > 0) throw new MockHttpError(422, 'UNPROCESSABLE', `Not a holding of this portfolio: ${unknown.join(', ')}`, { unknownSymbols: unknown });
  const others = s().assignments.filter((a) => !(a.portfolioId === portfolioId && (a.categoryId === categoryId || wanted.includes(a.symbol))));
  s().assignments = [...others, ...wanted.map((symbol) => ({ userId: MOCK_USER_ID, portfolioId, symbol, categoryId }))];
  return listCategories(portfolioId);
}

export const listAssignments = (portfolioId: string) => s().assignments.filter((a) => a.portfolioId === portfolioId);

// --- Custom assets ----------------------------------------------------------------------------------------------

function withValue(asset: CustomAsset): CustomAssetWithValue {
  const { seed } = s();
  const local = customAssetValueLocal(asset, seed.today);
  return { ...asset, currentValueLocal: round(local), currentValue: round(toBase(local, asset.currency, seed.fx)) };
}

export const listAssets = (portfolioId: string): CustomAssetWithValue[] =>
  s().assets.filter((a) => a.portfolioId === portfolioId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(withValue);

export const assetSymbols = (portfolioId: string): string[] => s().assets.filter((a) => a.portfolioId === portfolioId).map((a) => `CUSTOM:${a.assetId}`);

export function createAsset(portfolioId: string, body: unknown): CustomAssetWithValue {
  const input = parse(createCustomAssetSchema.safeParse(body), 'Invalid asset');
  if (s().assets.filter((a) => a.portfolioId === portfolioId).length >= MAX_CUSTOM_ASSETS) {
    throw new MockHttpError(422, 'UNPROCESSABLE', `A portfolio can have at most ${MAX_CUSTOM_ASSETS} custom assets.`);
  }
  const ts = nowIso();
  const asset: CustomAsset = {
    assetId: newId('asset'),
    userId: MOCK_USER_ID,
    portfolioId,
    name: input.name,
    assetClass: input.assetClass,
    currency: input.currency,
    costBasis: input.costBasis ?? input.value,
    ...(typeof input.growthRate === 'number' ? { growthRate: input.growthRate } : {}),
    valuations: [{ date: input.date ?? s().seed.today, value: input.value }],
    createdAt: ts,
    updatedAt: ts,
  };
  s().assets = [...s().assets, asset];
  return withValue(asset);
}

function requireAsset(portfolioId: string, assetId: string): CustomAsset {
  const asset = s().assets.find((a) => a.portfolioId === portfolioId && a.assetId === assetId);
  if (!asset) throw new MockHttpError(404, 'NOT_FOUND', `Asset ${assetId} not found`);
  return asset;
}

function saveAsset(asset: CustomAsset): CustomAssetWithValue {
  const saved = { ...asset, updatedAt: nowIso() };
  s().assets = s().assets.map((a) => (a.portfolioId === saved.portfolioId && a.assetId === saved.assetId ? saved : a));
  return withValue(saved);
}

export function updateAsset(portfolioId: string, assetId: string, body: unknown): CustomAssetWithValue {
  const { growthRate, ...fields } = parse(updateCustomAssetSchema.safeParse(body), 'Invalid asset');
  const { growthRate: previous, ...current } = requireAsset(portfolioId, assetId);
  const nextGrowth = growthRate === undefined ? previous : (growthRate ?? undefined);
  return saveAsset({ ...current, ...fields, ...(nextGrowth === undefined ? {} : { growthRate: nextGrowth }) });
}

export function deleteAsset(portfolioId: string, assetId: string): void {
  requireAsset(portfolioId, assetId);
  s().assets = s().assets.filter((a) => !(a.portfolioId === portfolioId && a.assetId === assetId));
  s().assignments = s().assignments.filter((a) => !(a.portfolioId === portfolioId && a.symbol === `CUSTOM:${assetId}`));
}

export function putValuation(portfolioId: string, assetId: string, body: unknown): CustomAssetWithValue {
  const point = parse(valuationSchema.safeParse(body), 'Invalid valuation');
  const next = upsertValuation(requireAsset(portfolioId, assetId), point);
  if (!next) throw new MockHttpError(422, 'UNPROCESSABLE', 'Too many valuation points.');
  return saveAsset(next);
}

export function deleteValuation(portfolioId: string, assetId: string, date: string): CustomAssetWithValue {
  const asset = requireAsset(portfolioId, assetId);
  if (!asset.valuations.some((v) => v.date === date)) throw new MockHttpError(404, 'NOT_FOUND', `No valuation on ${date}`);
  if (asset.valuations.length === 1) throw new MockHttpError(422, 'UNPROCESSABLE', new PortfolioError('An asset needs at least one valuation').message);
  return saveAsset({ ...asset, valuations: asset.valuations.filter((v) => v.date !== date) });
}

// --- Watchlist --------------------------------------------------------------------------------------------------

function toItem(entry: WatchlistEntry): WatchlistItem {
  const { quotes, profiles } = s().seed;
  const quote = quotes[entry.symbol];
  const profile = profiles[entry.symbol];
  const item: WatchlistItem = { symbol: entry.symbol, addedAt: entry.addedAt };
  if (profile) Object.assign(item, { name: profile.name, currency: profile.currency });
  if (quote) {
    const change = quote.price - quote.previousClose;
    Object.assign(item, {
      currency: quote.currency,
      price: quote.price,
      previousClose: quote.previousClose,
      change: round(change, 4),
      changePct: quote.previousClose > 0 ? round((change / quote.previousClose) * 100) : 0,
      asOf: quote.asOf,
    });
  }
  return item;
}

export const listWatchlist = (): WatchlistItem[] =>
  [...s().watchlist].sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.symbol.localeCompare(b.symbol)).map(toItem);

export function addWatchlist(body: unknown): WatchlistItem {
  const { symbol } = parse(addWatchlistSchema.safeParse(body), 'Invalid symbol');
  if (s().watchlist.length >= MAX_WATCHLIST) throw new MockHttpError(422, 'UNPROCESSABLE', `The watchlist can hold at most ${MAX_WATCHLIST} symbols.`);
  if (s().watchlist.some((w) => w.symbol === symbol)) throw new MockHttpError(409, 'CONFLICT', `${symbol} is already on your watchlist.`);
  const entry: WatchlistEntry = { userId: MOCK_USER_ID, symbol, addedAt: nowIso() };
  s().watchlist = [...s().watchlist, entry];
  return toItem(entry);
}

export function removeWatchlist(symbol: string): void {
  const upper = symbol.toUpperCase();
  if (!s().watchlist.some((w) => w.symbol === upper)) throw new MockHttpError(404, 'NOT_FOUND', `${upper} is not on your watchlist.`);
  s().watchlist = s().watchlist.filter((w) => w.symbol !== upper);
}

export const backupParts = () => {
  const { settings, categories, assignments, assets, watchlist } = s();
  return { settings, categories, categoryAssignments: assignments, customAssets: assets, watchlist };
};
