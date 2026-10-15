/**
 * Response builder of GET /analytics/metrics. Like the other analytics builders it takes the raw stored data, so the
 * Lambda and the web demo's mock backend share one implementation. Portfolio and benchmark go through the same
 * calculators (`riskFigures`, `betaOf`, …) over the same window, so their figures are directly comparable.
 */
import { DEFAULT_RISK_FREE_RATE, addIsoDays, chainReturns, daysBetween, ratioToPct, roundTo } from './analytics.js';
import { DEFAULT_BENCHMARK, type BenchmarkInfo } from './analytics-api.js';
import {
  NO_TRANSACTIONS_MESSAGE,
  benchmarkPrices,
  buildContext,
  currentPortfolio,
  noBenchmarkMessage,
  priceReturns,
  type AnalyticsData,
  type Context,
  type PricePoint,
} from './analytics-compute.js';
import { benchmarkPe, betaOf, calculatePortfolioPe, riskFigures, sharpeVerdict, sortinoVerdict, volatilityVerdict } from './metrics.js';
import type { AnalyticsMetricsResponse, TwrMetric } from './metrics-api.js';

/** Time-weighted return of the whole lifetime next to the benchmark's price return over the same period. */
function twrMetric(ctx: Context | null, prices: readonly PricePoint[], today: string): TwrMetric {
  const from = ctx?.firstDate ?? null;
  const returns = ctx?.returns ?? [];
  const base: TwrMetric = {
    portfolio: returns.length > 0 ? ratioToPct(chainReturns(returns.map((r) => r.r))) : null,
    benchmark: null,
    difference: null,
    from,
    to: today,
    days: from ? daysBetween(from, today) : 0,
    benchmarkFrom: null,
  };
  const first = prices[0];
  const last = prices.at(-1);
  if (!first || !last || prices.length < 2) return base;
  const benchmark = ratioToPct(last.price / first.price - 1);
  // Like with like: the portfolio over the window the benchmark has data for (all of it unless the benchmark started later).
  const comparable = returns.filter((r) => r.date > first.date).map((r) => r.r);
  const difference = comparable.length > 0 ? roundTo(ratioToPct(chainReturns(comparable)) - benchmark) : null;
  return { ...base, benchmark, difference, benchmarkFrom: first.date };
}

function benchmarkInfo(symbol: string, hasTransactions: boolean, hasPrices: boolean): BenchmarkInfo {
  if (!hasTransactions) return { symbol, available: false, message: NO_TRANSACTIONS_MESSAGE };
  return hasPrices ? { symbol, available: true } : { symbol, available: false, message: noBenchmarkMessage(symbol) };
}

export function computeMetrics(data: AnalyticsData, benchmark: string = DEFAULT_BENCHMARK, riskFreeRate: number = DEFAULT_RISK_FREE_RATE): AnalyticsMetricsResponse {
  const ctx = buildContext(data);
  const holdings = currentPortfolio(data).holdings;
  const returns = ctx?.returns ?? [];
  const firstReturn = returns[0];
  const eod = data.eod[benchmark];

  const prices = ctx ? benchmarkPrices(eod, ctx.timeline, ctx.firstDate, data.today) : [];
  // Same window as computeRisk: daily returns from the day before the portfolio's first return.
  const marketReturns = ctx && firstReturn ? priceReturns(benchmarkPrices(eod, ctx.timeline, addIsoDays(firstReturn.date, -1), data.today)) : [];
  const mine = riskFigures(returns, riskFreeRate);
  const market = riskFigures(marketReturns, riskFreeRate);
  const beta = betaOf(returns, marketReturns);
  const counts = { observations: mine.observations, benchmarkObservations: market.observations };

  return {
    baseCurrency: data.fx.base,
    riskFreeRatePct: ratioToPct(riskFreeRate),
    benchmark: benchmarkInfo(benchmark, ctx !== null, prices.length >= 2),
    twr: twrMetric(ctx, prices, data.today),
    pe: { ...calculatePortfolioPe(holdings, data.profiles), benchmark: benchmarkPe(data.profiles[benchmark]) },
    volatility: { ...counts, portfolio: mine.volatilityPct, benchmark: market.volatilityPct, beta, verdict: volatilityVerdict(beta) },
    sharpe: { ...counts, portfolio: mine.sharpe, benchmark: market.sharpe, verdict: sharpeVerdict(mine.sharpe) },
    sortino: { ...counts, portfolio: mine.sortino, benchmark: market.sortino, verdict: sortinoVerdict(mine.sortino) },
  };
}
