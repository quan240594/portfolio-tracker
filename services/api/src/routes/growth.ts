import {
  BENCHMARK_SUGGESTIONS,
  CASH_SYMBOL_PREFIX,
  CUSTOM_SYMBOL_PREFIX,
  GROWTH_ROUTES,
  addIsoDays,
  buildBenchmarkOptions,
  computeGrowth,
  computeHoldingsPerformance,
  growthQuerySchema,
  holdingsPerformanceQuerySchema,
  type AnalyticsData,
  type AnalyticsGrowthResponse,
  type AnalyticsHoldingsPerformanceResponse,
  type GrowthBenchmarkOption,
} from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';
import { loadAnalyticsData } from './analytics.js';

/** Window checked for "does this symbol have end-of-day prices" when its history was not loaded already. */
const RECENT_PRICE_DAYS = 45;

const isMarketSymbol = (symbol: string): boolean => !symbol.startsWith(CASH_SYMBOL_PREFIX) && !symbol.startsWith(CUSTOM_SYMBOL_PREFIX);

/** Tracked symbols (held + watchlist), the selected benchmarks and the suggestions, flagged by whether prices exist. */
export async function benchmarkOptions(ctx: RouteContext, data: Pick<AnalyticsData, 'transactions' | 'eod' | 'today'>, selected: readonly string[]): Promise<GrowthBenchmarkOption[]> {
  const { repo, mgmt } = ctx.deps;
  const watchlist = await mgmt.listWatchlist(ctx.userId);
  const symbols = [
    ...new Set([...data.transactions.map((t) => t.symbol).filter(isMarketSymbol), ...watchlist.map((w) => w.symbol), ...selected, ...BENCHMARK_SUGGESTIONS.map((s) => s.symbol)]),
  ];
  const from = addIsoDays(data.today, -RECENT_PRICE_DAYS);
  const [profiles, hasData] = await Promise.all([
    loadProfiles(ctx, symbols),
    Promise.all(
      symbols.map(async (s) => {
        const loaded = data.eod[s];
        return (loaded ?? (await repo.getEod(s, from, data.today))).length > 0;
      }),
    ),
  ]);
  return buildBenchmarkOptions(symbols.map((symbol, i) => ({ symbol, hasData: hasData[i]!, ...(profiles[symbol] ? { name: profiles[symbol].name } : {}) })));
}

export async function getGrowth(ctx: RouteContext): Promise<RouteResult> {
  const { range, benchmarks } = validate(growthQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const data = await loadAnalyticsData(ctx, { eod: true, benchmark: benchmarks });
  const options = await benchmarkOptions(ctx, data, benchmarks);
  return ok(computeGrowth(data, range, benchmarks, options) satisfies AnalyticsGrowthResponse);
}

export async function getHoldingsPerformance(ctx: RouteContext): Promise<RouteResult> {
  const { range } = validate(holdingsPerformanceQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const data = await loadAnalyticsData(ctx, { holdings: true, eod: true });
  return ok(computeHoldingsPerformance(data, range) satisfies AnalyticsHoldingsPerformanceResponse);
}

export const growthHandlers: Record<keyof typeof GROWTH_ROUTES, RouteHandler> = {
  analyticsGrowth: getGrowth,
  analyticsHoldingsPerformance: getHoldingsPerformance,
};

