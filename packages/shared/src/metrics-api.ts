/**
 * Metrics REST contract: the five cards of the Analytics → Metrics tab in one read.
 *
 * - GET /analytics/metrics   `?benchmark=` (default IWDA.AS) and the usual `?portfolioId=` scope
 *
 * Percentages are plain numbers (12.5 = 12.5 %) in fields suffixed `Pct` or documented as percent; ratios (Sharpe,
 * Sortino, beta, P/E) are unitless. Errors use the standard envelope: 400 VALIDATION_ERROR for a malformed
 * `benchmark`/`portfolioId`, 404 for an unknown portfolio. A benchmark without end-of-day prices is not an error:
 * `benchmark.available` is false (with a `message`) and every benchmark figure is null.
 */
import type { BenchmarkInfo } from './analytics-api.js';

export const METRICS_ROUTES = {
  analyticsMetrics: 'GET /analytics/metrics',
} as const;

/** Same query as GET /analytics/risk: `portfolioId` scope + a validated, upper-cased `benchmark` symbol. */
export { analyticsRiskQuerySchema as analyticsMetricsQuerySchema } from './analytics-api.js';

/** Fewer weekday returns than this still produce figures, but the UI warns that they are not reliable yet. */
export const SHORT_HISTORY_OBSERVATIONS = 60;

/** Quality of a ratio: how the UI colours the verdict chip. */
export type VerdictTone = 'positive' | 'neutral' | 'caution' | 'negative';

export const VOLATILITY_LEVELS = ['lower', 'in-line', 'higher'] as const;
export const SHARPE_LEVELS = ['poor', 'attention', 'good', 'very-good'] as const;
export const SORTINO_LEVELS = ['poor', 'attention', 'acceptable', 'good'] as const;
export type VolatilityLevel = (typeof VOLATILITY_LEVELS)[number];
export type SharpeLevel = (typeof SHARPE_LEVELS)[number];
export type SortinoLevel = (typeof SORTINO_LEVELS)[number];

export interface Verdict<L extends string = string> {
  level: L;
  /** Short phrase, e.g. "lower than the market" or "requires attention". */
  label: string;
  tone: VerdictTone;
}

export interface TwrMetric {
  /** Time-weighted return since the first investment transaction (dividends included), percent. */
  portfolio: number | null;
  /** Benchmark price return over its window (see `benchmarkFrom`), percent; null without benchmark data. */
  benchmark: number | null;
  /** Portfolio TWR over the benchmark's window minus the benchmark return, percentage points. */
  difference: number | null;
  /** First investment transaction; null for an empty portfolio. */
  from: string | null;
  to: string;
  days: number;
  /** Start of the benchmark window; later than `from` when the benchmark's price history starts after your first buy. */
  benchmarkFrom: string | null;
}

export type PeExclusionReason = 'missing' | 'non-positive';

export interface PeExclusion {
  symbol: string;
  name: string;
  reason: PeExclusionReason;
  /** Market value in the base currency. */
  marketValue: number;
}

export interface PeCoverage {
  /** Individual stocks whose P/E went into the figure. */
  includedStocks: number;
  /** Individual stocks held (asset class STOCK). */
  totalStocks: number;
  /** ETFs, crypto, bonds and everything else that is never part of a P/E. */
  nonStockHoldings: number;
  includedValue: number;
  stockValue: number;
  /** Market value of all holdings the calculation looked at. */
  portfolioValue: number;
  /** Covered value as percent of the portfolio value. */
  portfolioSharePct: number;
  /** Covered value as percent of the value of the stocks held. */
  stockSharePct: number;
}

export interface PeMetric {
  /** Weighted harmonic mean P/E of the covered stocks; null when no stock has a usable P/E. */
  portfolio: number | null;
  /** The benchmark's own P/E when its profile has one (ETFs usually do not); otherwise null. */
  benchmark: number | null;
  coverage: PeCoverage;
  excluded: PeExclusion[];
  /** Oldest `fundamentalsAsOf` among the covered stocks (YYYY-MM-DD). */
  asOf: string | null;
}

interface RatioBase {
  /** Weekday returns the portfolio figures are based on. */
  observations: number;
  /** Weekday returns of the benchmark over the same window. */
  benchmarkObservations: number;
}

export interface VolatilityMetric extends RatioBase {
  /** Annualised volatility, percent. */
  portfolio: number | null;
  benchmark: number | null;
  /** Portfolio beta against the benchmark. */
  beta: number | null;
  verdict: Verdict<VolatilityLevel> | null;
}

export interface SharpeMetric extends RatioBase {
  portfolio: number | null;
  benchmark: number | null;
  verdict: Verdict<SharpeLevel> | null;
}

export interface SortinoMetric extends RatioBase {
  portfolio: number | null;
  benchmark: number | null;
  verdict: Verdict<SortinoLevel> | null;
}

export interface AnalyticsMetricsResponse {
  baseCurrency: string;
  riskFreeRatePct: number;
  benchmark: BenchmarkInfo;
  twr: TwrMetric;
  pe: PeMetric;
  volatility: VolatilityMetric;
  sharpe: SharpeMetric;
  sortino: SortinoMetric;
}
