import {
  assignHoldingsSchema,
  calculateCategoryAllocation,
  categoryTargetTotal,
  createCategorySchema,
  customSymbol,
  isCashSymbol,
  marketSymbols,
  MAX_CATEGORIES,
  portfolioSettingsSchema,
  updateCategorySchema,
  type Category,
  type CategoryAllocationResponse,
  type Holding,
  type ListCategoriesResponse,
  type PortfolioSettings,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { requirePathPortfolio } from './management-data.js';

const byCreatedAt = (a: Category, b: Category) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);
const sameName = (a: string, b: string) => a.toLocaleLowerCase('en') === b.toLocaleLowerCase('en');

// --- Portfolio settings -----------------------------------------------------------------------------------------

export async function getPortfolioSettings(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const stored = await ctx.deps.mgmt.getSettings(ctx.userId, portfolioId);
  const settings: PortfolioSettings = stored ?? { portfolioId, userId: ctx.userId, trackCash: false, updatedAt: ctx.deps.now().toISOString() };
  return ok(settings);
}

export async function updatePortfolioSettings(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const input = validate(portfolioSettingsSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid settings');
  const settings: PortfolioSettings = {
    portfolioId,
    userId: ctx.userId,
    trackCash: input.trackCash,
    ...(typeof input.withholdingTaxRate === 'number' ? { withholdingTaxRate: input.withholdingTaxRate } : {}),
    updatedAt: ctx.deps.now().toISOString(),
  };
  await ctx.deps.mgmt.putSettings(settings);
  return ok(settings);
}

// --- Categories -------------------------------------------------------------------------------------------------

async function loadCategories(ctx: RouteContext, portfolioId: string): Promise<ListCategoriesResponse> {
  const [categories, assignments] = await Promise.all([
    ctx.deps.mgmt.listCategories(ctx.userId, portfolioId),
    ctx.deps.mgmt.listAssignments(ctx.userId, portfolioId),
  ]);
  const totalTarget = categoryTargetTotal(categories);
  const known = new Set(categories.map((c) => c.categoryId));
  const sortedCategories = [...categories].sort(byCreatedAt);
  const sortedAssignments = assignments.filter((a) => known.has(a.categoryId));
  sortedAssignments.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    categories: sortedCategories,
    assignments: sortedAssignments,
    totalTarget,
    unallocated: Math.round((100 - totalTarget) * 100) / 100,
  };
}

export async function listCategories(ctx: RouteContext): Promise<RouteResult> {
  return ok(await loadCategories(ctx, await requirePathPortfolio(ctx)));
}

function assertTargets(others: readonly Category[], targetWeight: number): void {
  const total = categoryTargetTotal([...others, { targetWeight }]);
  if (total > 100) {
    throw new HttpError(422, 'UNPROCESSABLE', `Target weights would add up to ${total}% (at most 100%)`, { totalTarget: total });
  }
}

function assertUniqueName(others: readonly Category[], name: string): void {
  if (others.some((c) => sameName(c.name, name))) throw new HttpError(409, 'CONFLICT', `A category named "${name}" already exists`);
}

export async function createCategory(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const input = validate(createCategorySchema.safeParse(parseJsonBody(ctx.body)), 'Invalid category');
  const { mgmt, now, uuid } = ctx.deps;
  const existing = await mgmt.listCategories(ctx.userId, portfolioId);
  if (existing.length >= MAX_CATEGORIES) throw new HttpError(422, 'UNPROCESSABLE', `A portfolio can have at most ${MAX_CATEGORIES} categories`);
  assertUniqueName(existing, input.name);
  assertTargets(existing, input.targetWeight);
  const ts = now().toISOString();
  const category: Category = { categoryId: uuid().toLowerCase(), userId: ctx.userId, portfolioId, ...input, createdAt: ts, updatedAt: ts };
  await mgmt.putCategory(category);
  return ok(category, 201);
}

async function requireCategory(ctx: RouteContext, portfolioId: string): Promise<{ category: Category; others: Category[] }> {
  const id = ctx.pathParams.cid!;
  const all = await ctx.deps.mgmt.listCategories(ctx.userId, portfolioId);
  const category = all.find((c) => c.categoryId === id);
  if (!category) throw new HttpError(404, 'NOT_FOUND', `Category ${id} not found`);
  return { category, others: all.filter((c) => c.categoryId !== id) };
}

export async function updateCategory(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const input = validate(updateCategorySchema.safeParse(parseJsonBody(ctx.body)), 'Invalid category');
  const { category, others } = await requireCategory(ctx, portfolioId);
  if (input.name !== undefined) assertUniqueName(others, input.name);
  const next: Category = { ...category, ...input, updatedAt: ctx.deps.now().toISOString() };
  assertTargets(others, next.targetWeight);
  await ctx.deps.mgmt.putCategory(next);
  return ok(next);
}

export async function deleteCategory(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const { category } = await requireCategory(ctx, portfolioId);
  await ctx.deps.mgmt.deleteCategory(ctx.userId, portfolioId, category.categoryId);
  return ok(undefined, 204);
}

/** Symbols a holding of this portfolio can have: traded market symbols, any cash currency and its custom assets. */
async function isAssignable(ctx: RouteContext, portfolioId: string): Promise<(symbol: string) => boolean> {
  const [transactions, assets] = await Promise.all([
    ctx.deps.repo.listTransactions(ctx.userId, portfolioId),
    ctx.deps.mgmt.listCustomAssets(ctx.userId, portfolioId),
  ]);
  const known = new Set([...marketSymbols(transactions.map((t) => t.symbol)), ...assets.map((a) => customSymbol(a.assetId))]);
  return (symbol) => isCashSymbol(symbol) || known.has(symbol);
}

/** Replaces the holdings of a category; a symbol listed here leaves any other category (one category per holding). */
export async function assignCategoryHoldings(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const { symbols } = validate(assignHoldingsSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid holdings');
  const { category } = await requireCategory(ctx, portfolioId);
  const wanted = [...new Set(symbols)];
  const assignable = await isAssignable(ctx, portfolioId);
  const unknown = wanted.filter((s) => !assignable(s));
  if (unknown.length > 0) throw new HttpError(422, 'UNPROCESSABLE', `Not a holding of this portfolio: ${unknown.join(', ')}`, { unknownSymbols: unknown });

  const { mgmt } = ctx.deps;
  const current = await mgmt.listAssignments(ctx.userId, portfolioId);
  const removed = current.filter((a) => a.categoryId === category.categoryId && !wanted.includes(a.symbol)).map((a) => a.symbol);
  await mgmt.deleteAssignments(ctx.userId, portfolioId, removed);
  await mgmt.putAssignments(wanted.map((symbol) => ({ userId: ctx.userId, portfolioId, symbol, categoryId: category.categoryId })));
  return ok(await loadCategories(ctx, portfolioId));
}

// --- Allocation by category -------------------------------------------------------------------------------------

/** `by=category` needs one portfolio: categories belong to a portfolio. */
export function assertCategoryScope(scope: string | undefined): string {
  if (scope === undefined) throw new HttpError(400, 'VALIDATION_ERROR', 'by=category requires a single portfolioId');
  return scope;
}

export async function categoryAllocation(
  ctx: RouteContext,
  portfolioId: string,
  baseCurrency: string,
  holdings: readonly Holding[],
): Promise<CategoryAllocationResponse> {
  const [categories, assignments] = await Promise.all([
    ctx.deps.mgmt.listCategories(ctx.userId, portfolioId),
    ctx.deps.mgmt.listAssignments(ctx.userId, portfolioId),
  ]);
  return { by: 'category', baseCurrency, slices: calculateCategoryAllocation(holdings, categories, assignments) };
}
