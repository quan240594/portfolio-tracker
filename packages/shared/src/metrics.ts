/**
 * Pure helpers of the Metrics tab: portfolio P/E, verdict bands, gauge geometry and the risk figures of a return
 * series. Everything is built on the existing analytics calculators (`riskStats`, `betaVs`, …); the response builder
 * lives in `metrics-compute.ts`.
 */
import { MIN_RISK_OBSERVATIONS, DEFAULT_RISK_FREE_RATE, betaVs, riskStats, roundTo, toTradingDayReturns, type DailyReturn } from './analytics.js';
import {
  SHORT_HISTORY_OBSERVATIONS,
  type PeCoverage,
  type PeExclusion,
  type PeMetric,
  type SharpeLevel,
  type SortinoLevel,
  type Verdict,
  type VolatilityLevel,
} from './metrics-api.js';
import type { Holding, InstrumentProfile } from './types.js';

// --- Portfolio P/E ---------------------------------------------------------------------------------

const isUsablePe = (pe: number | undefined): pe is number => pe !== undefined && Number.isFinite(pe) && pe > 0;

const pctOf = (part: number, whole: number): number => (whole > 0 ? roundTo((part / whole) * 100, 2) : 0);

/**
 * Weighted harmonic mean of price/earnings ratios: Σ value / Σ (value / P/E), i.e. the total value of the covered
 * stocks divided by the total earnings they represent (1 / the value-weighted earnings yield). Averaging the P/Es
 * arithmetically would overweight expensive stocks: P/E 10 and 40 at equal value give 16, not 25.
 * Null when there is nothing to average.
 */
export function weightedHarmonicPe(items: readonly { value: number; pe: number }[]): number | null {
  const value = items.reduce((s, i) => s + i.value, 0);
  const earnings = items.reduce((s, i) => s + i.value / i.pe, 0);
  return value > 0 && earnings > 0 ? value / earnings : null;
}

/**
 * Portfolio P/E over individual stocks only: ETFs, crypto, bonds and other holdings are ignored, as are stocks whose
 * profile has no (or a non-positive) trailing P/E. Coverage says how much of the portfolio the figure represents.
 */
export function calculatePortfolioPe(holdings: readonly Holding[], profiles: Readonly<Record<string, InstrumentProfile>>): Omit<PeMetric, 'benchmark'> {
  const stocks = holdings.filter((h) => h.assetClass === 'STOCK');
  const covered: { value: number; pe: number; asOf?: string }[] = [];
  const excluded: PeExclusion[] = [];
  for (const h of stocks) {
    const profile = profiles[h.symbol];
    const pe = profile?.peRatio;
    if (isUsablePe(pe)) covered.push({ value: h.marketValue, pe, asOf: profile?.fundamentalsAsOf });
    else excluded.push({ symbol: h.symbol, name: h.name, reason: pe === undefined ? 'missing' : 'non-positive', marketValue: roundTo(h.marketValue) });
  }
  const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);
  const includedValue = sum(covered.map((c) => c.value));
  const stockValue = sum(stocks.map((h) => h.marketValue));
  const portfolioValue = sum(holdings.map((h) => h.marketValue));
  const coverage: PeCoverage = {
    includedStocks: covered.length,
    totalStocks: stocks.length,
    nonStockHoldings: holdings.length - stocks.length,
    includedValue: roundTo(includedValue),
    stockValue: roundTo(stockValue),
    portfolioValue: roundTo(portfolioValue),
    portfolioSharePct: pctOf(includedValue, portfolioValue),
    stockSharePct: pctOf(includedValue, stockValue),
  };
  const pe = weightedHarmonicPe(covered);
  const dates = covered.flatMap((c) => (c.asOf ? [c.asOf] : []));
  const byValue = [...excluded].sort((a, b) => b.marketValue - a.marketValue || a.symbol.localeCompare(b.symbol));
  const oldest = [...dates].sort((a, b) => a.localeCompare(b))[0];
  return { portfolio: pe === null ? null : roundTo(pe), coverage, excluded: byValue, asOf: oldest ?? null };
}

/** A P/E the benchmark's profile can contribute: positive and finite, rounded like the portfolio's. */
export const benchmarkPe = (profile: InstrumentProfile | undefined): number | null => (isUsablePe(profile?.peRatio) ? roundTo(profile.peRatio) : null);

// --- Verdicts --------------------------------------------------------------------------------------

/** Beta bands: below 0.9 lower than the market, 0.9 to 1.1 (inclusive) in line, above 1.1 higher. */
export const BETA_BANDS = { lowerBelow: 0.9, higherAbove: 1.1 } as const;
/** Sharpe: below 0 poor, below 1 requires attention, 1 to 2 (inclusive) good, above 2 very good. */
export const SHARPE_BANDS = { attentionFrom: 0, goodFrom: 1, veryGoodAbove: 2 } as const;
/** Sortino: below 0 poor, below 1 requires attention, 1 to 2 (inclusive) acceptable, above 2 good. */
export const SORTINO_BANDS = { attentionFrom: 0, acceptableFrom: 1, goodAbove: 2 } as const;

export function volatilityVerdict(beta: number | null): Verdict<VolatilityLevel> | null {
  if (beta === null) return null;
  if (beta < BETA_BANDS.lowerBelow) return { level: 'lower', label: 'lower than the market', tone: 'positive' };
  if (beta <= BETA_BANDS.higherAbove) return { level: 'in-line', label: 'in line with the market', tone: 'neutral' };
  return { level: 'higher', label: 'higher than the market', tone: 'caution' };
}

export function sharpeVerdict(sharpe: number | null): Verdict<SharpeLevel> | null {
  if (sharpe === null) return null;
  if (sharpe < SHARPE_BANDS.attentionFrom) return { level: 'poor', label: 'poor', tone: 'negative' };
  if (sharpe < SHARPE_BANDS.goodFrom) return { level: 'attention', label: 'requires attention', tone: 'caution' };
  if (sharpe <= SHARPE_BANDS.veryGoodAbove) return { level: 'good', label: 'good', tone: 'positive' };
  return { level: 'very-good', label: 'very good', tone: 'positive' };
}

export function sortinoVerdict(sortino: number | null): Verdict<SortinoLevel> | null {
  if (sortino === null) return null;
  if (sortino < SORTINO_BANDS.attentionFrom) return { level: 'poor', label: 'poor', tone: 'negative' };
  if (sortino < SORTINO_BANDS.acceptableFrom) return { level: 'attention', label: 'requires attention', tone: 'caution' };
  if (sortino <= SORTINO_BANDS.goodAbove) return { level: 'acceptable', label: 'acceptable', tone: 'neutral' };
  return { level: 'good', label: 'good', tone: 'positive' };
}

export const isShortHistory = (observations: number): boolean => observations < SHORT_HISTORY_OBSERVATIONS;

// --- Gauges ----------------------------------------------------------------------------------------

export interface GaugeScale {
  min: number;
  max: number;
}

export const PE_GAUGE_SCALE: GaugeScale = { min: 0, max: 70 };
export const SHARPE_GAUGE_SCALE: GaugeScale = { min: -1, max: 3 };
export const SORTINO_GAUGE_SCALE: GaugeScale = { min: -1, max: 4 };
const MIN_VOLATILITY_SCALE_MAX = 40;

/** Annualised-volatility scale from 0 to at least 40 %, widened in steps of 10 so every marker fits. */
export function volatilityScale(values: readonly (number | null)[]): GaugeScale {
  const highest = Math.max(0, ...values.filter((v): v is number => v !== null));
  return { min: 0, max: Math.max(MIN_VOLATILITY_SCALE_MAX, Math.ceil(highest / 10) * 10) };
}

/** Position of `value` on the scale as a fraction 0..1; values outside the scale pin to the nearest end. */
export function gaugePosition(value: number, scale: GaugeScale): number {
  return Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min)));
}

// --- Risk figures of a return series ---------------------------------------------------------------

export interface RiskFigures {
  /** Weekday returns the figures are based on (before the minimum-history cut-off). */
  observations: number;
  /** Annualised volatility, percent; null below MIN_RISK_OBSERVATIONS. */
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
}

/**
 * Volatility, Sharpe and Sortino of daily returns, computed identically for the portfolio and the benchmark so the
 * two are comparable: weekday returns, 252-day annualisation, the same risk-free rate, null below 20 observations.
 */
export function riskFigures(returns: readonly DailyReturn[], riskFreeRate: number = DEFAULT_RISK_FREE_RATE): RiskFigures {
  const trading = toTradingDayReturns(returns);
  const stats = riskStats(trading.length >= MIN_RISK_OBSERVATIONS ? trading.map((r) => r.r) : [], riskFreeRate);
  return {
    observations: trading.length,
    volatilityPct: stats.volatility === null ? null : roundTo(stats.volatility * 100),
    sharpe: stats.sharpe === null ? null : roundTo(stats.sharpe, 3),
    sortino: stats.sortino === null ? null : roundTo(stats.sortino, 3),
  };
}

/** Beta of the portfolio against the benchmark over their shared weekdays; null below MIN_RISK_OBSERVATIONS. */
export function betaOf(portfolio: readonly DailyReturn[], benchmark: readonly DailyReturn[]): number | null {
  const result = betaVs(toTradingDayReturns(portfolio), toTradingDayReturns(benchmark));
  if (!result || result.observations < MIN_RISK_OBSERVATIONS || result.beta === null) return null;
  return roundTo(result.beta, 3);
}
