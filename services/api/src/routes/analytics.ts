import {
  analyticsBenchmarkQuerySchema,
  analyticsGoalQuerySchema,
  analyticsReturnsQuerySchema,
  analyticsRiskQuerySchema,
  computeAnalyticsSummary,
  computeBenchmark,
  computeDividendGrowth,
  computeGoal,
  computeReturns,
  computeRisk,
  type ANALYTICS_ROUTES,
  type AnalyticsBenchmarkResponse,
  type AnalyticsData,
  type AnalyticsDividendGrowthResponse,
  type AnalyticsGoalResponse,
  type AnalyticsReturnsResponse,
  type AnalyticsRiskResponse,
  type AnalyticsSummaryResponse,
  type EodPrice,
  type Transaction,
} from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';
import { heldSymbols, loadFx } from './portfolio.js';
import { scopedTransactions } from './portfolios.js';

/** Extra days of EOD loaded before the first transaction so carry-forward closes are seeded. */
const EOD_LOOKBACK_DAYS = 14;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

export interface Needs {
  /** Quotes + profiles of the held symbols (current holdings, insights). */
  holdings?: boolean;
  /** Announced dividend events of the held symbols. */
  events?: boolean;
  /** End-of-day prices of every traded symbol (value history). */
  eod?: boolean;
  /** Also load end-of-day prices of this benchmark symbol (or symbols). */
  benchmark?: string | readonly string[];
}

async function loadEod(ctx: RouteContext, transactions: readonly Transaction[], extra: Needs['benchmark']): Promise<Record<string, EodPrice[]>> {
  const today = isoDay(ctx.deps.now());
  let first = today;
  for (const t of transactions) if (t.date < first) first = t.date;
  const symbols = [...new Set([...transactions.map((t) => t.symbol), ...(extra === undefined ? [] : [extra].flat())])];
  const from = addDays(first, -EOD_LOOKBACK_DAYS);
  const series = await Promise.all(symbols.map((s) => ctx.deps.repo.getEod(s, from, today)));
  return Object.fromEntries(symbols.map((s, i) => [s, series[i]!]));
}

/** Loads exactly the stored data the requested calculation needs, scoped like every other read endpoint. */
export async function loadAnalyticsData(ctx: RouteContext, needs: Needs): Promise<AnalyticsData> {
  const { repo, now } = ctx.deps;
  const transactions = await scopedTransactions(ctx);
  const held = heldSymbols(transactions);
  const [quotes, profiles, events, { fx, fxHistory }, eod] = await Promise.all([
    needs.holdings && held.length ? repo.getQuotes(held) : {},
    needs.holdings && held.length ? loadProfiles(ctx, held) : {},
    needs.events ? Promise.all(held.map((s) => repo.getDividendEvents(s))) : [],
    loadFx(ctx.deps, transactions),
    needs.eod && transactions.length > 0 ? loadEod(ctx, transactions, needs.benchmark) : {},
  ]);
  return { transactions, quotes, profiles, fx, fxHistory, eod, dividendEvents: events.flat(), today: isoDay(now()), now: now() };
}

export async function getSummary(ctx: RouteContext): Promise<RouteResult> {
  const data = await loadAnalyticsData(ctx, { holdings: true, events: true, eod: true });
  return ok(computeAnalyticsSummary(data) satisfies AnalyticsSummaryResponse);
}

export async function getReturns(ctx: RouteContext): Promise<RouteResult> {
  const { period } = validate(analyticsReturnsQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const data = await loadAnalyticsData(ctx, { eod: true });
  return ok(computeReturns(data, period) satisfies AnalyticsReturnsResponse);
}

export async function getRisk(ctx: RouteContext): Promise<RouteResult> {
  const { benchmark } = validate(analyticsRiskQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const data = await loadAnalyticsData(ctx, { eod: true, benchmark });
  return ok(computeRisk(data, benchmark) satisfies AnalyticsRiskResponse);
}

export async function getBenchmark(ctx: RouteContext): Promise<RouteResult> {
  const { benchmark, range } = validate(analyticsBenchmarkQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const data = await loadAnalyticsData(ctx, { eod: true, benchmark });
  return ok(computeBenchmark(data, benchmark, range) satisfies AnalyticsBenchmarkResponse);
}

export async function getDividendGrowth(ctx: RouteContext): Promise<RouteResult> {
  const data = await loadAnalyticsData(ctx, {});
  return ok(computeDividendGrowth(data) satisfies AnalyticsDividendGrowthResponse);
}

export async function getGoal(ctx: RouteContext): Promise<RouteResult> {
  const { portfolioId: _scope, ...query } = validate(analyticsGoalQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const data = await loadAnalyticsData(ctx, { holdings: true, events: true });
  return ok(computeGoal(data, query) satisfies AnalyticsGoalResponse);
}

export const analyticsHandlers: Record<keyof typeof ANALYTICS_ROUTES, RouteHandler> = {
  analyticsSummary: getSummary,
  analyticsReturns: getReturns,
  analyticsRisk: getRisk,
  analyticsBenchmark: getBenchmark,
  analyticsDividendGrowth: getDividendGrowth,
  analyticsGoal: getGoal,
};

