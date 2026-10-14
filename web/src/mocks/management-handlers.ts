/** MSW handlers of the portfolio-management routes; they mirror services/api (validation, status codes, shapes). */
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  calculateCategoryAllocation,
  calculateRebalance,
  marketSymbols,
  rebalanceQuerySchema,
  toRebalanceHoldings,
  transactionsToCsv,
  type BackupResponse,
  type CategoryAllocationResponse,
  type ListAssetsResponse,
} from '@portfolio/shared';
import * as db from './db';
import * as mgmt from './management-db';
import { MockHttpError, api, guard, latency } from './utils';

interface Call {
  request: Request;
  params: Record<string, string | readonly string[] | undefined>;
}

const param = (c: Call, name: string): string => String(c.params[name]);
const bodyOf = (c: Call): Promise<unknown> => c.request.json().catch(() => null);
const portfolioId = (c: Call): string => db.requirePortfolio(param(c, 'id')).portfolioId;

/** Wraps a handler body: simulated latency, MockHttpError → API error response, `undefined` → 204. */
const route =
  (fn: (c: Call) => unknown, status = 200) =>
  async (c: Call) => {
    await latency();
    return guard(async () => {
      const out = await fn(c);
      return out === undefined ? new HttpResponse(null, { status: 204 }) : HttpResponse.json(out, { status });
    })();
  };

/** Symbols that can be assigned to a category: traded market symbols and the portfolio's custom assets. */
function assignable(id: string): (symbol: string) => boolean {
  const known = new Set([...marketSymbols(db.scoped(id).map((t) => t.symbol)), ...mgmt.assetSymbols(id)]);
  return (symbol) => known.has(symbol);
}

function categoryData(id: string) {
  const { categories, assignments } = mgmt.listCategories(id);
  return { categories, assignments };
}

/** `by=category` of GET /allocation (one portfolio only, like the API). */
export function categoryAllocation(scope: string | undefined): CategoryAllocationResponse {
  if (scope === undefined) throw new MockHttpError(400, 'VALIDATION_ERROR', 'by=category requires a single portfolioId');
  const { summary, holdings } = db.portfolio(db.requirePortfolio(scope).portfolioId);
  const { categories, assignments } = categoryData(scope);
  return { by: 'category', baseCurrency: summary.baseCurrency, slices: calculateCategoryAllocation(holdings, categories, assignments) };
}

function rebalance(c: Call) {
  const id = portfolioId(c);
  const parsed = rebalanceQuerySchema.safeParse(Object.fromEntries(new URL(c.request.url).searchParams));
  if (!parsed.success) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.flatten());
  const { categories, assignments } = categoryData(id);
  return calculateRebalance({
    holdings: toRebalanceHoldings(db.portfolio(id).holdings, categories, assignments),
    categories: categories.map(({ categoryId, name, color, targetWeight }) => ({ categoryId, name, color, targetWeight })),
    ...parsed.data,
  });
}

function backup(): BackupResponse {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    baseCurrency: 'EUR',
    portfolios: db.listPortfolios(),
    transactions: db.scoped(undefined),
    ...mgmt.backupParts(),
  };
}

function exportCsv(c: Call): Response {
  const raw = new URL(c.request.url).searchParams.get('portfolioId') ?? undefined;
  const scope = raw === undefined || raw === 'all' ? undefined : db.requirePortfolio(raw).portfolioId;
  return new Response(transactionsToCsv(db.scoped(scope)), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="transactions-${scope ?? 'all'}.csv"` },
  });
}

export const managementHandlers: HttpHandler[] = [
  http.get(api('/portfolios/:id/settings'), route((c) => mgmt.getSettings(portfolioId(c)))),
  http.put(api('/portfolios/:id/settings'), route(async (c) => mgmt.updateSettings(portfolioId(c), await bodyOf(c)))),

  http.get(api('/portfolios/:id/categories'), route((c) => mgmt.listCategories(portfolioId(c)))),
  http.post(api('/portfolios/:id/categories'), route(async (c) => mgmt.createCategory(portfolioId(c), await bodyOf(c)), 201)),
  http.patch(api('/portfolios/:id/categories/:cid'), route(async (c) => mgmt.updateCategory(portfolioId(c), param(c, 'cid'), await bodyOf(c)))),
  http.delete(api('/portfolios/:id/categories/:cid'), route((c) => mgmt.deleteCategory(portfolioId(c), param(c, 'cid')))),
  http.put(
    api('/portfolios/:id/categories/:cid/holdings'),
    route(async (c) => {
      const id = portfolioId(c);
      return mgmt.assignHoldings(id, param(c, 'cid'), await bodyOf(c), assignable(id));
    }),
  ),

  http.get(api('/portfolios/:id/rebalance'), route(rebalance)),

  http.get(api('/portfolios/:id/assets'), route((c) => ({ baseCurrency: 'EUR', assets: mgmt.listAssets(portfolioId(c)) }) satisfies ListAssetsResponse)),
  http.post(api('/portfolios/:id/assets'), route(async (c) => mgmt.createAsset(portfolioId(c), await bodyOf(c)), 201)),
  http.patch(api('/portfolios/:id/assets/:aid'), route(async (c) => mgmt.updateAsset(portfolioId(c), param(c, 'aid'), await bodyOf(c)))),
  http.delete(api('/portfolios/:id/assets/:aid'), route((c) => mgmt.deleteAsset(portfolioId(c), param(c, 'aid')))),
  http.put(api('/portfolios/:id/assets/:aid/valuations'), route(async (c) => mgmt.putValuation(portfolioId(c), param(c, 'aid'), await bodyOf(c)))),
  http.delete(api('/portfolios/:id/assets/:aid/valuations/:date'), route((c) => mgmt.deleteValuation(portfolioId(c), param(c, 'aid'), param(c, 'date')))),

  http.get(api('/watchlist'), route(() => ({ items: mgmt.listWatchlist() }))),
  http.post(api('/watchlist'), route(async (c) => mgmt.addWatchlist(await bodyOf(c)), 201)),
  http.delete(api('/watchlist/:symbol'), route((c) => mgmt.removeWatchlist(param(c, 'symbol')))),

  http.get(api('/export/transactions'), async (c) => {
    await latency();
    return guard(() => exportCsv(c))();
  }),
  http.get(api('/export/backup'), route(backup)),
];
