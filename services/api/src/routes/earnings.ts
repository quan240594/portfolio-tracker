import {
  EARNINGS_DEFAULT_LIMIT,
  assetSymbolSchema,
  earningsListQuerySchema,
  earningsPeriodSchema,
  currentHoldings,
  hasEarnings,
  type EARNINGS_ROUTES,
  type EarningsBackfillResponse,
  type EarningsListResponse,
  type EarningsStatusResponse,
  type EarningsSummary,
} from '@portfolio/shared';
import type { EarningsDeps, RouteContext } from '../deps.js';
import { HttpError, ok, validate, type RouteResult } from '../lib/http.js';
import { withConsensus } from '../lib/consensus.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';

/**
 * The symbols the caller holds today (above the dust threshold) and the ones traded but sold out: a summary is public, but only what you
 * hold now is listed, counted and checked (the sold-out ones are only counted, for the status page).
 */
async function ownHoldings(ctx: RouteContext): Promise<{ held: string[]; former: string[] }> {
  const transactions = await ctx.deps.repo.listTransactions(ctx.userId);
  return currentHoldings(transactions, ctx.deps.now().toISOString().slice(0, 10));
}

const ownSymbols = async (ctx: RouteContext): Promise<string[]> => (await ownHoldings(ctx)).held;

function requireEarnings(ctx: RouteContext): EarningsDeps {
  if (!ctx.deps.earnings) throw new HttpError(404, 'NOT_AVAILABLE', 'Earnings summaries are not available on this deployment');
  return ctx.deps.earnings;
}

const symbolParam = (ctx: RouteContext): string => validate(assetSymbolSchema.safeParse(ctx.pathParams.symbol), 'Invalid symbol');

/** `GET /earnings?symbol=&limit=`: the newest summaries of the symbols you hold now, newest first, each with its analyst consensus (`consensus`) where there is one. */
async function listEarnings(ctx: RouteContext): Promise<RouteResult> {
  if (!ctx.deps.earnings) return ok({ available: false, summaries: [], symbols: [] } satisfies EarningsListResponse);
  const query = validate(earningsListQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const own = await ownSymbols(ctx);
  const limit = query.limit ?? EARNINGS_DEFAULT_LIMIT;
  const wanted = query.symbol === undefined ? own : own.filter((symbol) => symbol === query.symbol);
  const lists = await Promise.all(own.map((symbol) => ctx.deps.repo.getEarningsSummaries(symbol, wanted.includes(symbol) ? limit : 1)));
  const symbols = own.filter((_symbol, index) => lists[index]!.length > 0);
  const listed = lists.flatMap((list, index) => (wanted.includes(own[index]!) ? list : []));
  const newest = [...listed].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || a.symbol.localeCompare(b.symbol)).slice(0, limit);
  const summaries = await withConsensus(ctx.deps.repo, newest, ctx.deps.earnings.estimatesConfigured);
  return ok({ available: true, summaries, symbols } satisfies EarningsListResponse);
}

/** `GET /earnings/status`: is the feature configured, what was checked last, how many neurons are used today. */
async function earningsStatus(ctx: RouteContext): Promise<RouteResult> {
  if (!ctx.deps.earnings) return ok({ available: false, configured: false, missing: [], estimatesConfigured: false, symbols: [] } satisfies EarningsStatusResponse);
  const { held, former } = await ownHoldings(ctx);
  const profiles = await loadProfiles(ctx, held);
  const symbols = held.map((symbol) => ({ symbol, eligible: hasEarnings(profiles[symbol]?.assetClass, profiles[symbol]?.name) }));
  return ok({ ...(await ctx.deps.earnings.status(symbols)), ...(former.length === 0 ? {} : { notHeld: former.length }) });
}

/** `GET /earnings/{symbol}/{period}`: one summary (`period` is its report date). */
async function getEarnings(ctx: RouteContext): Promise<RouteResult> {
  requireEarnings(ctx);
  const symbol = symbolParam(ctx);
  const period = validate(earningsPeriodSchema.safeParse(ctx.pathParams.period), 'Invalid period');
  const own = await ownSymbols(ctx);
  const summary: EarningsSummary | null = own.includes(symbol) ? await ctx.deps.repo.getEarningsSummary(symbol, period) : null;
  if (summary === null) throw new HttpError(404, 'NOT_FOUND', 'No earnings summary for this symbol and period');
  return ok((await withConsensus(ctx.deps.repo, [summary], ctx.deps.earnings?.estimatesConfigured))[0]);
}

/** `POST /earnings/{symbol}/refresh`: the owner asks for a re-check; once per symbol per hour. */
async function refreshEarnings(ctx: RouteContext): Promise<RouteResult> {
  const earnings = requireEarnings(ctx);
  const symbol = symbolParam(ctx);
  const own = await ownSymbols(ctx);
  if (!own.includes(symbol)) throw new HttpError(404, 'NOT_FOUND', 'You do not hold this symbol');
  const profiles = await loadProfiles(ctx, [symbol]);
  const result = await earnings.refresh(symbol, hasEarnings(profiles[symbol]?.assetClass, profiles[symbol]?.name));
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

/** `POST /earnings/backfill`: "Fetch all now" (rescan all) starts the backfill of every current holding over (the sold-out ones are dropped); once per hour. */
async function backfillEarnings(ctx: RouteContext): Promise<RouteResult> {
  const result: EarningsBackfillResponse = await requireEarnings(ctx).backfill();
  if (result.accepted) return ok(result, 202);
  if (result.reason === 'rate-limited') {
    return { statusCode: 429, body: { error: { code: 'RATE_LIMITED', message: 'Fetch all was started less than an hour ago', details: { retryAfterSeconds: result.retryAfterSeconds } } }, headers: { 'retry-after': String(result.retryAfterSeconds ?? 3600) } };
  }
  throw new HttpError(503, 'NOT_CONFIGURED', 'Earnings summaries are not configured on the server (SEC_CONTACT or the Workers AI binding is missing)');
}

export const earningsHandlers: Record<keyof typeof EARNINGS_ROUTES, RouteHandler> = {
  earningsList: listEarnings,
  earningsStatus: earningsStatus,
  earningsGet: getEarnings,
  earningsRefresh: refreshEarnings,
  earningsBackfill: backfillEarnings,
};
