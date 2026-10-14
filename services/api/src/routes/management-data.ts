import { portfolioIdSchema, type CustomAsset } from '@portfolio/shared';
import type { RouteContext } from '../deps.js';
import { HttpError } from '../lib/http.js';
import { requirePortfolio } from './portfolios.js';

export interface ManagementScope {
  /** Portfolios in scope with cash tracking on. */
  cashPortfolioIds: ReadonlySet<string>;
  customAssets: CustomAsset[];
}

/** Cash-tracking settings and custom assets for a read scope (`undefined` = all portfolios combined). */
export async function loadManagementScope(ctx: RouteContext, scope: string | undefined): Promise<ManagementScope> {
  const { mgmt } = ctx.deps;
  const [settings, customAssets] = await Promise.all([mgmt.listSettings(ctx.userId), mgmt.listCustomAssets(ctx.userId, scope)]);
  const cashPortfolioIds = new Set(settings.filter((s) => s.trackCash && (scope === undefined || s.portfolioId === scope)).map((s) => s.portfolioId));
  return { cashPortfolioIds, customAssets };
}

/**
 * Portfolio id of `/portfolios/{id}/...` routes: malformed ids can never exist (404), unknown ones are a 404 too.
 * Returns the id of the existing portfolio.
 */
export async function requirePathPortfolio(ctx: RouteContext): Promise<string> {
  const id = ctx.pathParams.id!;
  if (!portfolioIdSchema.safeParse(id).success) throw new HttpError(404, 'NOT_FOUND', `Portfolio ${id} not found`);
  return (await requirePortfolio(ctx, id)).portfolioId;
}
