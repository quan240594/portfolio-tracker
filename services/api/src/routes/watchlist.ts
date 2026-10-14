import {
  MAX_WATCHLIST,
  WATCHLIST_EVENT_PORTFOLIO_ID,
  addWatchlistSchema,
  type InstrumentProfile,
  type ListWatchlistResponse,
  type Quote,
  type WatchlistEntry,
  type WatchlistItem,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { publishChange } from './changes.js';

const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

function toItem(entry: WatchlistEntry, quote?: Quote, profile?: InstrumentProfile): WatchlistItem {
  const item: WatchlistItem = { symbol: entry.symbol, addedAt: entry.addedAt };
  if (profile) {
    item.name = profile.name;
    item.currency = profile.currency;
  }
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

async function itemsFor(ctx: RouteContext, entries: readonly WatchlistEntry[]): Promise<WatchlistItem[]> {
  const symbols = entries.map((e) => e.symbol);
  const [quotes, profiles] = symbols.length
    ? await Promise.all([ctx.deps.repo.getQuotes(symbols), ctx.deps.repo.getProfiles(symbols)])
    : [{}, {}];
  return [...entries]
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.symbol.localeCompare(b.symbol))
    .map((e) => toItem(e, quotes[e.symbol], profiles[e.symbol]));
}

export async function listWatchlist(ctx: RouteContext): Promise<RouteResult> {
  const entries = await ctx.deps.mgmt.listWatchlist(ctx.userId);
  return ok({ items: await itemsFor(ctx, entries) } satisfies ListWatchlistResponse);
}

/**
 * Adds a symbol, registers it as TRACKED and asks the prices service to enrich it by publishing the existing
 * TransactionsChanged event (the prices handler only reads `detail.symbols`).
 */
export async function addWatchlist(ctx: RouteContext): Promise<RouteResult> {
  const { symbol } = validate(addWatchlistSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)), 'Invalid symbol');
  const { mgmt, repo, now } = ctx.deps;
  if ((await mgmt.listWatchlist(ctx.userId)).length >= MAX_WATCHLIST) {
    throw new HttpError(422, 'UNPROCESSABLE', `The watchlist can hold at most ${MAX_WATCHLIST} symbols`);
  }
  const entry: WatchlistEntry = { userId: ctx.userId, symbol, addedAt: now().toISOString() };
  if (!(await mgmt.addWatchlistEntry(entry))) throw new HttpError(409, 'CONFLICT', `${symbol} is already on your watchlist`);
  await repo.registerUser(ctx.userId);
  await repo.trackTickers([{ symbol }]);
  await publishChange(ctx, WATCHLIST_EVENT_PORTFOLIO_ID, [symbol], 'CREATED');
  const [item] = await itemsFor(ctx, [entry]);
  return ok(item, 201);
}

export async function removeWatchlist(ctx: RouteContext): Promise<RouteResult> {
  const symbol = ctx.pathParams.symbol!.toUpperCase();
  if (!(await ctx.deps.mgmt.deleteWatchlistEntry(ctx.userId, symbol))) {
    throw new HttpError(404, 'NOT_FOUND', `${symbol} is not on your watchlist`);
  }
  return ok(undefined, 204);
}
