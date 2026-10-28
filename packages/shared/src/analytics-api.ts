/**
 * Analytics REST contract. All endpoints are reads, accept the usual `?portfolioId=` scope
 * (omitted or `all` = every portfolio combined) and return values in the base currency. Percentages are
 * plain numbers (12.5 = 12.5 %) in fields suffixed `Pct`; ratios such as Sharpe/beta are unitless.
 * Errors use the standard envelope (400 VALIDATION_ERROR for malformed query parameters).
 *
 * - GET /analytics/summary          IRR, TWR, passive income, top day movers and portfolio insights; `?period=ttm|ytd|5y|10y|all` adds `periodPerformance`
 * - GET /analytics/returns          `?period=year|quarter|month` TWR bars (+ IRR for years)
 * - GET /analytics/risk             `?benchmark=` volatility, Sharpe, Sortino, max drawdown, beta
 * - GET /analytics/benchmark        `?benchmark=&range=` portfolio value vs the benchmark replayed with the same flows
 * - GET /analytics/dividend-growth  year-over-year dividend growth by year, month and per share
 * - GET /analytics/goal             `?targetIncome=&dividendGrowthPct=&yieldOnNewMoneyPct=&monthlyContribution=&…` income projection
 */
import { z } from 'zod';
import { HISTORY_RANGES, portfolioScopeSchema, type HistoryRange } from './schemas.js';
import { RETURN_PERIODS, type GoalScenario, type Mover, type ReturnPeriod } from './analytics.js';
import type { DividendGrowth, PassiveIncome } from './analytics-income.js';
import type { Insight } from './analytics-insights.js';

export const ANALYTICS_ROUTES = {
  analyticsSummary: 'GET /analytics/summary',
  analyticsReturns: 'GET /analytics/returns',
  analyticsRisk: 'GET /analytics/risk',
  analyticsBenchmark: 'GET /analytics/benchmark',
  analyticsDividendGrowth: 'GET /analytics/dividend-growth',
  analyticsGoal: 'GET /analytics/goal',
} as const;

export const DEFAULT_BENCHMARK = 'IWDA.AS';
/** Benchmarks offered by the UI; any symbol with tracked end-of-day prices is accepted by the API. */
export const BENCHMARK_SYMBOLS = ['IWDA.AS', 'VWRL.AS'] as const;
export const MAX_GOAL_YEARS = 50;
export const DEFAULT_GOAL = {
  targetIncome: 12_000,
  dividendGrowthPct: 5,
  yieldOnNewMoneyPct: 3.5,
  monthlyContribution: 250,
  years: 30,
} as const;

// --- Query schemas ---------------------------------------------------------------------------------

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const benchmarkSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.\-:^=]+$/, 'Invalid symbol')
  .transform((s) => s.toUpperCase())
  .default(DEFAULT_BENCHMARK);
const queryNumber = (min: number, max: number) => z.coerce.number().min(min).max(max);
/** Query values arrive as strings; an empty value counts as omitted so the default applies. */
const withDefault = <T extends z.ZodTypeAny>(schema: z.ZodDefault<T>) => z.preprocess(emptyToUndefined, schema);

/** Dashboard windows of `GET /analytics/summary?period=`: trailing 365 days, calendar year to date, 5 and 10 years of 365 days, or everything. */
export const DASHBOARD_PERIODS = ['ttm', 'ytd', '5y', '10y', 'all'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
/** An omitted or empty `period` leaves the response exactly as it was before the parameter existed (no `periodPerformance`). */
export const analyticsSummaryQuerySchema = portfolioScopeSchema.extend({ period: z.preprocess(emptyToUndefined, z.enum(DASHBOARD_PERIODS).optional()) });

export const analyticsReturnsQuerySchema = portfolioScopeSchema.extend({ period: z.enum(RETURN_PERIODS).default('year') });
export const analyticsRiskQuerySchema = portfolioScopeSchema.extend({ benchmark: benchmarkSchema });
export const analyticsBenchmarkQuerySchema = portfolioScopeSchema.extend({
  benchmark: benchmarkSchema,
  range: z.enum(HISTORY_RANGES).default('1Y'),
});
export const analyticsGoalQuerySchema = portfolioScopeSchema.extend({
  targetIncome: withDefault(z.coerce.number().positive().max(1e9).default(DEFAULT_GOAL.targetIncome)),
  dividendGrowthPct: withDefault(queryNumber(0, 30).default(DEFAULT_GOAL.dividendGrowthPct)),
  yieldOnNewMoneyPct: withDefault(queryNumber(0, 20).default(DEFAULT_GOAL.yieldOnNewMoneyPct)),
  monthlyContribution: withDefault(queryNumber(0, 1e7).default(DEFAULT_GOAL.monthlyContribution)),
  /** Overrides the portfolio's own yield (percent) as the starting point. */
  currentYieldPct: z.preprocess(emptyToUndefined, queryNumber(0, 50).optional()),
  years: withDefault(z.coerce.number().int().min(1).max(MAX_GOAL_YEARS).default(DEFAULT_GOAL.years)),
  reinvestDividends: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});
export type AnalyticsGoalQuery = z.infer<typeof analyticsGoalQuerySchema>;
/** Client-side parameters of GET /analytics/goal (everything optional; the API applies DEFAULT_GOAL). */
export type AnalyticsGoalParams = Partial<Omit<AnalyticsGoalQuery, 'portfolioId'>>;

// --- Responses -------------------------------------------------------------------------------------

export interface PerformanceSummary {
  /** First transaction date; null for an empty portfolio. */
  since: string | null;
  days: number;
  /** Money-weighted return: annualised XIRR when `since` is a year or more ago, else the return over the period. */
  irrPct: number | null;
  irrAnnualised: boolean;
  /** Cumulative time-weighted return since the first transaction (incl. dividends). */
  twrPct: number | null;
  /** Annualised TWR; null for less than a year of history. */
  twrAnnualisedPct: number | null;
}

/** The figures of one dashboard window, computed like their all-time counterparts (same cost, FX and dividend rules). */
export interface PeriodPerformance {
  period: DashboardPeriod;
  /** First day the figures cover: the window start, or the first transaction when the history is shorter (see `truncated`). Null without transactions. */
  from: string | null;
  to: string;
  /** True when the history starts after the requested window start, so `from` is later than the window asked for. */
  truncated: boolean;
  days: number;
  /** Money-weighted return over the window: annualised when it spans a year or more, else the return over the window. */
  irrPct: number | null;
  irrAnnualised: boolean;
  /** Time-weighted return over the window (incl. dividends). */
  twrPct: number | null;
  /** Annualised TWR; null for windows shorter than a year. */
  twrAnnualisedPct: number | null;
  /** Portfolio value the day before the window starts (0 when the window starts with the history). */
  startValue: number;
  endValue: number;
  /** Net dividends received inside the window. */
  dividends: number;
  /** Realized P&L of the sales inside the window. */
  realizedPnl: number;
  /** Change of the unrealized P&L over the window + realized P&L + dividends. */
  totalReturn: number;
  /** `totalReturn` on the cost basis at the window start plus what was bought inside it, percent. */
  totalReturnPct: number;
}

export interface AnalyticsSummaryResponse {
  baseCurrency: string;
  asOf: string;
  performance: PerformanceSummary;
  passiveIncome: PassiveIncome;
  /** Day change % of the current holdings, at most 5 each. */
  gainers: Mover[];
  losers: Mover[];
  insights: Insight[];
  /** Only present when the request carried `?period=`. */
  periodPerformance?: PeriodPerformance;
}

export interface ReturnPeriodRow {
  /** `2026`, `2026-Q3` or `2026-09`. */
  period: string;
  start: string;
  end: string;
  /** Time-weighted return of the period, percent. */
  twrPct: number;
  /** Money-weighted return (years only; null otherwise). Short first/current years are not annualised. */
  irrPct: number | null;
  startValue: number;
  endValue: number;
  /** Buys minus sells during the period. */
  contributions: number;
  /** Net dividends received during the period. */
  income: number;
  /** Money made: end − start − contributions + income. */
  gain: number;
}

export interface AnalyticsReturnsResponse {
  period: ReturnPeriod;
  baseCurrency: string;
  rows: ReturnPeriodRow[];
}

export interface BenchmarkInfo {
  symbol: string;
  /** False when no end-of-day prices are available for the symbol (see `message`). */
  available: boolean;
  message?: string;
}

export interface DrawdownSummary {
  /** Peak-to-trough decline, percent (negative). */
  depthPct: number;
  peakDate: string | null;
  troughDate: string | null;
  recoveryDate: string | null;
}

export interface AnalyticsRiskResponse {
  baseCurrency: string;
  riskFreeRatePct: number;
  /** Number of weekday returns the figures are based on; fewer than 20 → metrics are null. */
  observations: number;
  from: string | null;
  to: string | null;
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: DrawdownSummary | null;
  benchmark: BenchmarkInfo & { beta: number | null; correlation: number | null };
}

export interface BenchmarkPoint {
  date: string;
  /** Portfolio market value plus dividends received since the start of the comparison. */
  portfolio: number;
  /** Benchmark ETF replayed with the same buys/sells; null before the comparison starts. */
  benchmark: number | null;
  /** Start value plus net contributions. */
  invested: number;
}

export interface BenchmarkComparison {
  from: string;
  to: string;
  portfolioReturnPct: number;
  benchmarkReturnPct: number;
  /** Portfolio minus benchmark, percentage points. */
  differencePct: number;
  portfolioGain: number;
  benchmarkGain: number;
}

export interface AnalyticsBenchmarkResponse {
  range: HistoryRange;
  baseCurrency: string;
  benchmark: BenchmarkInfo;
  points: BenchmarkPoint[];
  /** Null when the benchmark is unavailable or the comparison window is too short. */
  comparison: BenchmarkComparison | null;
}

export type AnalyticsDividendGrowthResponse = DividendGrowth;

export interface GoalInputsEcho {
  targetIncome: number;
  currentValue: number;
  /** Annual income the projection starts from. */
  currentIncome: number;
  currentYieldPct: number;
  dividendGrowthPct: number;
  yieldOnNewMoneyPct: number;
  monthlyContribution: number;
  reinvestDividends: boolean;
  years: number;
}

export interface AnalyticsGoalResponse {
  baseCurrency: string;
  inputs: GoalInputsEcho;
  scenarios: GoalScenario[];
}
