import { computeDividendsOverview, type DividendsOverviewResponse, type DIVIDENDS_ROUTES } from '@portfolio/shared';
import { ok, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';
import { heldSymbols, loadFx } from './portfolio.js';
import { scopedTransactions } from './portfolios.js';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** GET /dividends/overview: forward income, yield, growth and payment consistency per holding of the requested scope. */
export async function getDividendsOverview(ctx: RouteContext): Promise<RouteResult> {
  const { repo, now } = ctx.deps;
  const transactions = await scopedTransactions(ctx);
  const held = heldSymbols(transactions);
  const [quotes, profiles, events, { fx, fxHistory }] = await Promise.all([
    held.length ? repo.getQuotes(held) : {},
    held.length ? loadProfiles(ctx, held) : {},
    Promise.all(held.map((s) => repo.getDividendEvents(s))),
    loadFx(ctx.deps, transactions),
  ]);
  const overview = computeDividendsOverview({
    transactions,
    quotes,
    profiles,
    fx,
    fxHistory,
    eod: {},
    dividendEvents: events.flat(),
    today: isoDay(now()),
    now: now(),
  });
  return ok(overview satisfies DividendsOverviewResponse);
}

export const dividendsOverviewHandlers: Record<keyof typeof DIVIDENDS_ROUTES, RouteHandler> = {
  dividendsOverview: getDividendsOverview,
};

