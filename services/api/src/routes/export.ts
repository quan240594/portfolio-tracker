import { transactionsToCsv, type BackupResponse } from '@portfolio/shared';
import { ok, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { resolveScope } from './portfolios.js';

/** CSV in the importer's format; `?portfolioId=` limits it to one portfolio. */
export async function exportTransactions(ctx: RouteContext): Promise<RouteResult> {
  const scope = await resolveScope(ctx);
  const transactions = await ctx.deps.repo.listTransactions(ctx.userId, scope);
  const day = ctx.deps.now().toISOString().slice(0, 10);
  return {
    statusCode: 200,
    body: transactionsToCsv(transactions),
    contentType: 'text/csv; charset=utf-8',
    headers: { 'content-disposition': `attachment; filename="transactions-${scope ?? 'all'}-${day}.csv"` },
  };
}

/** Everything the user stored, as one JSON document. Contains no credentials or secrets. */
export async function exportBackup(ctx: RouteContext): Promise<RouteResult> {
  const { repo, mgmt, config, now } = ctx.deps;
  const [portfolios, transactions, settings, categories, categoryAssignments, customAssets, watchlist, classificationOverrides] = await Promise.all([
    repo.listPortfolios(ctx.userId),
    repo.listTransactions(ctx.userId),
    mgmt.listSettings(ctx.userId),
    mgmt.listCategories(ctx.userId),
    mgmt.listAssignments(ctx.userId),
    mgmt.listCustomAssets(ctx.userId),
    mgmt.listWatchlist(ctx.userId),
    mgmt.listClassificationOverrides(ctx.userId),
  ]);
  const sortedPortfolios = [...portfolios].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.portfolioId.localeCompare(b.portfolioId));
  const backup: BackupResponse = {
    version: 1,
    exportedAt: now().toISOString(),
    baseCurrency: config.baseCurrency,
    portfolios: sortedPortfolios,
    settings,
    transactions,
    categories,
    categoryAssignments,
    customAssets,
    watchlist,
    classificationOverrides,
  };
  return ok(backup);
}
