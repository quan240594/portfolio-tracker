/**
 * Asset detail REST contract. All endpoints are reads. Authentication: the caller's identity comes from the request
 * context only; nothing in the path or query selects a user.
 *
 * - GET /assets/{symbol}            public part: profile, quote, stats, announced/paid dividend history per share
 * - GET /assets/{symbol}/history    `?range=&benchmarks=&portfolioId=` price series, benchmarks (as in the Growth view) and the
 *                                   user's trade markers
 * - GET /assets/{symbol}/positions  `?portfolioId=` the user's position in the symbol, one card per portfolio
 * - GET /securities/closed          `?portfolioId=` symbols the user traded but no longer holds
 *
 * `{symbol}` is a canonical symbol (`ASML.AS`, `BTC-EUR`) and may be URL-encoded. A symbol without any stored data and
 * without any transaction of the user is a `404 NOT_FOUND`. `CASH.*` and `CUSTOM:*` are never market symbols (404).
 * Prices are in the instrument's currency (`currency`); the user's money (positions, markers' `amountBase`) is in the
 * base currency, converted at historical rates as described in docs/architecture.md. Percentages are plain numbers.
 */
import { z } from 'zod';
import { portfolioScopeSchema, symbolSchema } from './schemas.js';
import { isMarketSymbol } from './management-api.js';
import {
  DEFAULT_GROWTH_RANGE,
  GROWTH_RANGES,
  benchmarkListSchema,
  type GrowthBenchmark,
  type GrowthBenchmarkOption,
  type GrowthRange,
} from './growth-api.js';
import type { AssetClass } from './types.js';

export const ASSET_DETAIL_ROUTES = {
  assetDetail: 'GET /assets/{symbol}',
  assetHistory: 'GET /assets/{symbol}/history',
  assetPositions: 'GET /assets/{symbol}/positions',
  closedSecurities: 'GET /securities/closed',
} as const;

/** Same ranges as the Growth view. */
export const ASSET_RANGES = GROWTH_RANGES;
export type AssetRange = GrowthRange;
export const DEFAULT_ASSET_RANGE: AssetRange = DEFAULT_GROWTH_RANGE;
/** Upper bound of points in the price series. */
export const MAX_ASSET_POINTS = 400;
/** Largest number of calendar years used for the dividend growth figures. */
export const DIVIDEND_GROWTH_YEARS = 5;

// --- Query schemas ---------------------------------------------------------------------------------

export const assetSymbolSchema = symbolSchema.refine(isMarketSymbol, 'Not a market symbol');

/**
 * `benchmarks` is a comma separated list as in the Growth view (at most MAX_GROWTH_BENCHMARKS symbols): omitted = the
 * default benchmark, empty = none.
 */
export const assetHistoryQuerySchema = portfolioScopeSchema.extend({
  range: z.enum(ASSET_RANGES).default(DEFAULT_ASSET_RANGE),
  benchmarks: benchmarkListSchema,
});
export type AssetHistoryQuery = z.infer<typeof assetHistoryQuerySchema>;

// --- GET /assets/{symbol} --------------------------------------------------------------------------

export interface AssetProfileInfo {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector: string | null;
  country: string | null;
  exchange: string | null;
  currency: string;
  description: string | null;
  isin: string | null;
}

export interface AssetQuoteInfo {
  /** `quote` = latest stored quote, `eod` = derived from the last two stored closes. */
  source: 'quote' | 'eod';
  price: number;
  previousClose: number;
  /** price − previousClose, in `currency`. */
  change: number;
  changePct: number;
  currency: string;
  asOf: string;
  /** Latest price in the base currency at today's rate; null when no rate is stored. */
  priceBase: number | null;
}

export interface AssetDividendGrowth {
  /** Number of year-over-year steps the rate is based on (1..DIVIDEND_GROWTH_YEARS). */
  years: number;
  /** Compound annual growth of the yearly dividend per share. */
  cagrPct: number;
}

/** Every field is null when it cannot be sourced from the stored free data or derived from it (never invented). */
export interface AssetStats {
  /** From the profile (Alpha Vantage OVERVIEW, US stocks). */
  peRatio: number | null;
  eps: number | null;
  beta: number | null;
  /** In the instrument's currency. */
  marketCap: number | null;
  /** Trailing-12-month dividend per share ÷ price, percent. */
  dividendYieldPct: number | null;
  /** Dividend per share paid by ex-dates within the last 365 days, in `dividends.currency`. */
  annualDividend: number | null;
  nextExDate: string | null;
  nextDividendAmount: number | null;
  /** annualDividend ÷ EPS; only with a positive EPS in the same currency. */
  payoutRatioPct: number | null;
  dividendGrowth: AssetDividendGrowth | null;
  /** Consecutive most recent years in which the yearly dividend per share rose. */
  dividendIncreaseStreak: number | null;
  /** Reserved: no free source is stored, so this is always null. */
  nextEarningsDate: string | null;
}

export interface AssetDividendEvent {
  exDate: string;
  payDate: string | null;
  /** Per share, in `AssetDividends.currency`. */
  amount: number;
}

export interface AssetDividendYear {
  year: number;
  perShare: number;
  payments: number;
  /** False for the running year and for a first stored year that may start mid-year. */
  complete: boolean;
}

export interface AssetDividends {
  currency: string | null;
  /** Newest first. */
  events: AssetDividendEvent[];
  /** Oldest first. */
  byYear: AssetDividendYear[];
}

export interface AssetDetailResponse {
  symbol: string;
  baseCurrency: string;
  profile: AssetProfileInfo;
  quote: AssetQuoteInfo | null;
  stats: AssetStats;
  dividends: AssetDividends;
}

// --- GET /assets/{symbol}/history ------------------------------------------------------------------

export interface AssetPricePoint {
  date: string;
  /** Close in the instrument's currency. */
  close: number;
  /** Price change since the first point of the series, percent. */
  pct: number;
}

export const ASSET_MARKER_TYPES = ['BUY', 'SELL', 'DIVIDEND'] as const;
export type AssetMarkerType = (typeof ASSET_MARKER_TYPES)[number];

export interface AssetMarker {
  /** Transaction date. */
  date: string;
  /** Date of the series point the marker is drawn at (first point on or after `date`, else the last point). */
  plotDate: string;
  type: AssetMarkerType;
  portfolioId: string;
  quantity: number;
  /** Per unit, in the instrument's currency (dividends: gross per share). */
  price: number;
  /** BUY: cost incl. fee, SELL: proceeds net of fee, DIVIDEND: net received; all in the base currency. */
  amountBase: number;
}

export interface AssetHistoryCoverage {
  /** First/last stored close for the symbol (null without prices). */
  from: string | null;
  to: string | null;
  /** True when the range starts before the first stored close, i.e. the series is shorter than asked. */
  limited: boolean;
}

export interface AssetHistoryResponse {
  symbol: string;
  range: AssetRange;
  baseCurrency: string;
  currency: string;
  points: AssetPricePoint[];
  /**
   * One entry per requested benchmark, in request order. Same shape as in the Growth view: `points` are aligned with
   * the series above, `value` is the benchmark's close (carried forward over its non-trading days) and `returnPct`
   * its price change since the series start; both null before the benchmark has data. `comparison` is always null.
   */
  benchmarks: GrowthBenchmark[];
  /** Selectable benchmarks (tracked symbols with data first, then suggestions), for the benchmark picker. */
  options: GrowthBenchmarkOption[];
  markers: AssetMarker[];
  coverage: AssetHistoryCoverage;
}

// --- GET /assets/{symbol}/positions ----------------------------------------------------------------

export interface AssetPosition {
  portfolioId: string;
  portfolioName: string;
  status: 'open' | 'closed';
  /** 0 for a closed position. */
  quantity: number;
  /** Per share: base currency at purchase-date rates; the instrument currency alongside. 0 when closed. */
  averageCostBase: number;
  averageCostLocal: number;
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
  /** unrealized + realized price result, excluding dividends. */
  capitalGain: number;
  dividendsReceived: number;
  /** capitalGain + dividendsReceived. */
  profit: number;
  /** profit ÷ total ever invested in the position. */
  profitPct: number;
  /** Share of the portfolio's total value, 0..1; null for a closed position. */
  weight: number | null;
  firstTradeDate: string | null;
  lastTradeDate: string | null;
}

export interface AssetDividendReceived {
  date: string;
  portfolioId: string;
  quantity: number;
  perShareLocal: number;
  currency: string;
  /** Net amount in the base currency. */
  amount: number;
}

export interface AssetPositionsTotals {
  quantity: number;
  costBasis: number;
  marketValue: number;
  capitalGain: number;
  dividendsReceived: number;
  profit: number;
  profitPct: number;
}

export interface AssetPositionsResponse {
  symbol: string;
  baseCurrency: string;
  currency: string | null;
  /** Open positions first (largest value first), then closed ones. */
  positions: AssetPosition[];
  /** Combined figures; null unless more than one portfolio has a position. */
  totals: AssetPositionsTotals | null;
  /** Newest first. */
  received: AssetDividendReceived[];
}

// --- GET /securities/closed ------------------------------------------------------------------------

export interface ClosedSecurity {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector: string;
  country: string;
  currency: string;
  realizedPnl: number;
  dividendsReceived: number;
  profit: number;
  profitPct: number;
  /** Date of the last SELL. */
  lastSoldDate: string | null;
}

export interface GetClosedSecuritiesResponse {
  baseCurrency: string;
  securities: ClosedSecurity[];
}
