import {
  EARNINGS_DEFAULT_LIMIT,
  assetSymbolSchema,
  earningsListQuerySchema,
  earningsPeriodSchema,
  hasEarnings,
  marketSymbols,
  type EARNINGS_ROUTES,
  type EarningsListResponse,
  type EarningsStatusResponse,
  type EarningsSummary,
} from '@portfolio/shared';
import type { EarningsDeps, RouteContext } from '../deps.js';
import { HttpError, ok, validate, type RouteResult } from '../lib/http.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';

/** Symbols the caller holds or ever held: a summary is public, but only what you own is listed. */
async function ownSymbols(ctx: RouteContext): Promise<string[]> {
  const transactions = await ctx.deps.repo.listTransactions(ctx.userId);
  return [...new Set(marketSymbols(transactions.map((t) => t.symbol)))].sort((a, b) => a.localeCompare(b));
}

function requireEarnings(ctx: RouteContext): EarningsDeps {
  if (!ctx.deps.earnings) throw new HttpError(404, 'NOT_AVAILABLE', 'Earnings summaries are not available on this deployment');
  return ctx.deps.earnings;
}

const symbolParam = (ctx: RouteContext): string => validate(assetSymbolSchema.safeParse(ctx.pathParams.symbol), 'Invalid symbol');

/** `GET /earnings?symbol=&limit=`: the newest summaries of the symbols you hold or held, newest first. */
async function listEarnings(ctx: RouteContext): Promise<RouteResult> {
  if (!ctx.deps.earnings) return ok({ available: false, summaries: [], symbols: [] } satisfies EarningsListResponse);
  const query = validate(earningsListQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const own = await ownSymbols(ctx);
  const limit = query.limit ?? EARNINGS_DEFAULT_LIMIT;
  const wanted = query.symbol === undefined ? own : own.filter((symbol) => symbol === query.symbol);
  const lists = await Promise.all(own.map((symbol) => ctx.deps.repo.getEarningsSummaries(symbol, wanted.includes(symbol) ? limit : 1)));
  const symbols = own.filter((_symbol, index) => lists[index]!.length > 0);
  const listed = lists.flatMap((list, index) => (wanted.includes(own[index]!) ? list : []));
  const summaries = [...listed].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || a.symbol.localeCompare(b.symbol)).slice(0, limit);
  return ok({ available: true, summaries, symbols } satisfies EarningsListResponse);
}

/** `GET /earnings/status`: is the feature configured, what was checked last, how many neurons are used today. */
async function earningsStatus(ctx: RouteContext): Promise<RouteResult> {
  if (!ctx.deps.earnings) return ok({ available: false, configured: false, missing: [], estimatesConfigured: false, symbols: [] } satisfies EarningsStatusResponse);
  const own = await ownSymbols(ctx);
  const profiles = await loadProfiles(ctx, own);
  const symbols = own.map((symbol) => ({ symbol, eligible: hasEarnings(profiles[symbol]?.assetClass) }));
  return ok(await ctx.deps.earnings.status(symbols));
}

/** `GET /earnings/{symbol}/{period}`: one summary (`period` is its report date). */
async function getEarnings(ctx: RouteContext): Promise<RouteResult> {
  requireEarnings(ctx);
  const symbol = symbolParam(ctx);
  const period = validate(earningsPeriodSchema.safeParse(ctx.pathParams.period), 'Invalid period');
  const own = await ownSymbols(ctx);
  const summary: EarningsSummary | null = own.includes(symbol) ? await ctx.deps.repo.getEarningsSummary(symbol, period) : null;
  if (summary === null) throw new HttpError(404, 'NOT_FOUND', 'No earnings summary for this symbol and period');
  return ok(summary);
}

/** `POST /earnings/{symbol}/refresh`: the owner asks for a re-check; once per symbol per hour. */
async function refreshEarnings(ctx: RouteContext): Promise<RouteResult> {
  const earnings = requireEarnings(ctx);
  const symbol = symbolParam(ctx);
  const own = await ownSymbols(ctx);
  if (!own.includes(symbol)) throw new HttpError(404, 'NOT_FOUND', 'You do not hold this symbol');
  const profiles = await loadProfiles(ctx, [symbol]);
  const result = await earnings.refresh(symbol, hasEarnings(profiles[symbol]?.assetClass));
  if (result.accepted) return ok(result, 202);
  switch (result.reason) {
    case 'rate-limited':
      return { statusCode: 429, body: { error: { code: 'RATE_LIMITED', message: 'This symbol was refreshed less than an hour ago', details: { retryAfterSeconds: result.retryAfterSeconds } } }, headers: { 'retry-after': String(result.retryAfterSeconds ?? 3600) } };
    case 'not-configured':
      throw new HttpError(503, 'NOT_CONFIGURED', 'Earnings summaries are not configured on the server (SEC_CONTACT or the Workers AI binding is missing)');
    default:
      throw new HttpError(422, 'NOT_ELIGIBLE', 'This instrument has no quarterly earnings (an ETF, crypto or similar)');
  }
}

export const earningsHandlers: Record<keyof typeof EARNINGS_ROUTES, RouteHandler> = {
  earningsList: listEarnings,
  earningsStatus: earningsStatus,
  earningsGet: getEarnings,
  earningsRefresh: refreshEarnings,
};
