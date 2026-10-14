import {
  calculateRebalance,
  rebalanceQuerySchema,
  toRebalanceHoldings,
  type GetRebalanceResponse,
} from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { requirePathPortfolio } from './management-data.js';
import { computePortfolio } from './portfolio.js';

/** Suggested trades to move the portfolio towards its category targets (see calculateRebalance). */
export async function getRebalance(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const query = validate(rebalanceQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const [{ holdings }, categories, assignments] = await Promise.all([
    computePortfolio({ ...ctx, query: { portfolioId } }),
    ctx.deps.mgmt.listCategories(ctx.userId, portfolioId),
    ctx.deps.mgmt.listAssignments(ctx.userId, portfolioId),
  ]);
  const result = calculateRebalance({
    holdings: toRebalanceHoldings(holdings, categories, assignments),
    categories: categories.map((c) => ({ categoryId: c.categoryId, name: c.name, color: c.color, targetWeight: c.targetWeight })),
    ...query,
  });
  return ok(result satisfies GetRebalanceResponse);
}
