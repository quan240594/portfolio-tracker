/**
 * Growth view contract (Analytics → Growth). Reads only; both endpoints accept the usual `?portfolioId=` scope
 * (omitted or `all` = every portfolio combined) and return amounts in the base currency. Percentages are plain
 * numbers (12.5 = 12.5 %) in fields suffixed `Pct`.
 *
 * - GET /analytics/growth               `?range=&benchmarks=a,b,c` portfolio value, invested, cumulative return and
 *                                       benchmark series (aligned by index), headline, monthly returns, benchmark options
 * - GET /analytics/holdings-performance `?range=` return per open holding over the range
 *
 * `benchmarks` is a comma separated list of at most {@link MAX_GROWTH_BENCHMARKS} symbols; omitted = the default
 * benchmark, empty = no benchmark. Errors use the standard envelope (400 VALIDATION_ERROR, 404 unknown portfolio).
 */
import { z } from 'zod';
import { DEFAULT_BENCHMARK, type BenchmarkComparison } from './analytics-api.js';
import { portfolioScopeSchema, symbolSchema } from './schemas.js';

export const GROWTH_ROUTES = {
  analyticsGrowth: 'GET /analytics/growth',
  analyticsHoldingsPerformance: 'GET /analytics/holdings-performance',
} as const;

export const GROWTH_RANGES = ['7D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'ALL'] as const;
export type GrowthRange = (typeof GROWTH_RANGES)[number];
export const DEFAULT_GROWTH_RANGE: GrowthRange = '1Y';
export const MAX_GROWTH_BENCHMARKS = 3;

/** Common index ETFs offered next to the tracked symbols; they only work once their prices are tracked. */
export const BENCHMARK_SUGGESTIONS = [
  { symbol: 'IWDA.AS', name: 'iShares Core MSCI World' },
  { symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World' },
  { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World (Acc)' },
  { symbol: 'SXR8.DE', name: 'iShares Core S&P 500' },
  { symbol: 'EXSA.DE', name: 'iShares STOXX Europe 600' },
] as const;

/**
 * Parses a `benchmarks` query value: comma separated symbols, upper-cased, de-duplicated, blanks ignored.
 * Returns null when a symbol is invalid or there are more than {@link MAX_GROWTH_BENCHMARKS}.
 */
export function parseBenchmarkList(raw: string): string[] | null {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const symbols: string[] = [];
  for (const part of parts) {
    const parsed = symbolSchema.safeParse(part);
    if (!parsed.success) return null;
    if (!symbols.includes(parsed.data)) symbols.push(parsed.data);
  }
  return symbols.length > MAX_GROWTH_BENCHMARKS ? null : symbols;
}

export const benchmarkListSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return [DEFAULT_BENCHMARK];
    const list = parseBenchmarkList(raw);
    if (list === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `benchmarks must be at most ${MAX_GROWTH_BENCHMARKS} valid symbols separated by commas` });
      return z.NEVER;
    }
    return list;
  });

export const growthQuerySchema = portfolioScopeSchema.extend({
  range: z.enum(GROWTH_RANGES).default(DEFAULT_GROWTH_RANGE),
  benchmarks: benchmarkListSchema,
});
export const holdingsPerformanceQuerySchema = portfolioScopeSchema.extend({
  range: z.enum(GROWTH_RANGES).default(DEFAULT_GROWTH_RANGE),
});

// --- Responses -------------------------------------------------------------------------------------

export interface GrowthPoint {
  date: string;
  /** Market value plus dividends received since the start of the range. */
  value: number;
  /** Value at the start of the range plus net contributions (cost basis of the range). */
  invested: number;
  /** Cumulative time-weighted return since the start of the range, percent (0 on the first day). */
  returnPct: number;
}

export interface GrowthBenchmarkPoint {
  /** The benchmark replayed with the portfolio's buys and sells; null when the benchmark has no data. */
  value: number | null;
  /** Benchmark price return since the start of the range, percent; null when the benchmark has no data. */
  returnPct: number | null;
}

export interface GrowthBenchmark {
  symbol: string;
  /** False when no end-of-day prices are tracked for the symbol (see `message`). */
  available: boolean;
  message?: string;
  /** Same length and order as `series`. */
  points: GrowthBenchmarkPoint[];
  /** Null when the benchmark is unavailable or the range is too short. */
  comparison: BenchmarkComparison | null;
}

export interface GrowthPeriod {
  from: string;
  to: string;
  startValue: number;
  endValue: number;
  /** Start value plus net contributions at the end of the range. */
  invested: number;
  /** Money made in the range: end value − invested. */
  gain: number;
  /** Time-weighted return of the range, percent. */
  returnPct: number;
}

/** "You are ahead of / behind <symbol> by …": positive numbers mean ahead. Based on the first available benchmark. */
export interface GrowthHeadline {
  symbol: string;
  from: string;
  to: string;
  /** Portfolio gain minus the gain of the same money in the benchmark. */
  amount: number;
  /** Portfolio return minus benchmark return, percentage points. */
  differencePct: number;
  portfolioReturnPct: number;
  benchmarkReturnPct: number;
}

export interface GrowthMonthRow {
  /** `YYYY-MM`. */
  month: string;
  /** Time-weighted return of the month, percent. */
  portfolioPct: number;
  /** Benchmark price return of the month by requested symbol; null when the benchmark has no data. */
  benchmarks: Record<string, number | null>;
}

export interface GrowthBenchmarkOption {
  symbol: string;
  name?: string;
  /** True when end-of-day prices are tracked (so it can be used right away). */
  hasData: boolean;
}

export interface AnalyticsGrowthResponse {
  range: GrowthRange;
  baseCurrency: string;
  /** Null without transactions. */
  period: GrowthPeriod | null;
  /** At most ~400 points. */
  series: GrowthPoint[];
  /** One entry per requested benchmark, in request order. */
  benchmarks: GrowthBenchmark[];
  headline: GrowthHeadline | null;
  /** Monthly returns over the whole history (independent of `range`). */
  monthly: GrowthMonthRow[];
  /** Symbols that can be chosen as benchmark: tracked symbols with data first, then suggestions. */
  options: GrowthBenchmarkOption[];
}

export interface HoldingPerformanceRow {
  symbol: string;
  name: string;
  /** Return of the holding over the range (time-weighted, incl. dividends), percent. */
  returnPct: number;
  /** Money made over the range: end − start − net purchases + dividends. */
  gain: number;
  /** First day measured: the range start, or the first purchase for holdings bought inside the range. */
  from: string;
  /** True when the holding was bought inside the range. */
  sincePurchase: boolean;
}

export interface AnalyticsHoldingsPerformanceResponse {
  range: GrowthRange;
  baseCurrency: string;
  /** Start of the range (first day of the portfolio at the earliest); null without transactions. */
  from: string | null;
  to: string;
  /** Open positions only, best first. */
  holdings: HoldingPerformanceRow[];
}
