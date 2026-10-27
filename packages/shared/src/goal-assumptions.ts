/**
 * Suggested values for the goal assumptions (pure, no I/O): "Dividend growth per year", "Yield on new money" and "Inflation per
 * year", worked out from the portfolio's own dividend figures and from the ECB inflation series. The goal calculations are
 * unchanged: they still receive plain numbers, these functions only propose them. Definitions: docs/architecture.md "Goal
 * assumption helpers".
 */
import { roundTo } from './analytics.js';
import type { DividendCagrGrowth } from './dividend-growth-stats.js';
import type { DividendOverviewHolding, DividendOverviewSummary } from './dividends-overview.js';
import type { InflationPoint } from './inflation-api.js';

/** The range an input accepts: suggestions are clamped to it (`clamped` says so). */
export interface AssumptionRange {
  min: number;
  max: number;
}

const clamp = (value: number, { min, max }: AssumptionRange): number => Math.min(max, Math.max(min, value));

export interface Clamped {
  /** The figure before clamping (rounded). */
  rawPct: number;
  /** The figure to use: `rawPct` within the range. */
  pct: number;
  clamped: boolean;
}

function clampedPct(raw: number, range: AssumptionRange, digits: number): Clamped {
  const rawPct = roundTo(raw, digits);
  const pct = roundTo(clamp(raw, range), digits);
  return { rawPct, pct, clamped: pct !== rawPct };
}

// --- Dividend growth -----------------------------------------------------------------------------------------------------

/** Decimals of the suggested growth and inflation rates (the yield keeps two, like the Dividends page). */
export const SUGGESTION_DIGITS = 1;
export const YIELD_DIGITS = 2;

/** The per-share growth of the holdings used must cover at least this share of the forward dividend income. */
export const MIN_GROWTH_COVERAGE = 0.5;

export type DividendGrowthHolding = Pick<DividendOverviewHolding, 'symbol' | 'forward12m' | 'growthPct' | 'growthYears'>;

export interface PortfolioGrowthBasis {
  method: 'PER_SHARE' | 'INCOME';
  /** Dividend-paying holdings (forward income above zero). */
  payers: number;
  /** PER_SHARE: holdings with at least one full year of per-share history; INCOME: the same as `payers`. */
  holdings: number;
  /** PER_SHARE: share of the forward dividend income those holdings produce, percent. */
  coveragePct: number;
  /** PER_SHARE: shortest and longest per-share history used, full years. INCOME: both the years between `fromYear` and `toYear`. */
  minYears: number;
  maxYears: number;
  /** INCOME only: the first and last complete calendar year of the income. */
  fromYear?: number;
  toYear?: number;
}

export type DividendGrowthSuggestion =
  | ({ available: true; basis: PortfolioGrowthBasis } & Clamped)
  | { available: false; reason: 'NO_PAYERS' | 'TOO_LITTLE_HISTORY'; payers: number; withHistory: number };

/**
 * Dividend growth per year of the portfolio: the forward-income-weighted average of the compound annual growth of the
 * dividend PER SHARE of every dividend-paying holding (the "Growth" column of the Dividends page: full years of payments, first
 * against last). Per share means buying more shares is not growth, and each holding is compared with itself (like for like).
 * Each holding's rate is limited to +/- the range's maximum so one special dividend cannot dominate; weights are the holdings'
 * forward 12-month income. Needs holdings with at least one full year of history that produce `MIN_GROWTH_COVERAGE` of the
 * forward income; otherwise it falls back to the compound growth of the total dividends received (`incomeCagr`, includes the
 * effect of buying or selling shares), and is unavailable when that is missing too.
 */
export function suggestDividendGrowth(holdings: readonly DividendGrowthHolding[], incomeCagr: DividendCagrGrowth | null | undefined, range: AssumptionRange): DividendGrowthSuggestion {
  const payers = holdings.filter((h) => h.forward12m > 0);
  if (payers.length === 0) return { available: false, reason: 'NO_PAYERS', payers: 0, withHistory: 0 };
  const usable = payers.filter((h) => h.growthPct !== null && h.growthYears >= 1);
  const totalWeight = payers.reduce((sum, h) => sum + h.forward12m, 0);
  const usableWeight = usable.reduce((sum, h) => sum + h.forward12m, 0);
  if (usable.length > 0 && usableWeight / totalWeight >= MIN_GROWTH_COVERAGE) {
    const weighted = usable.reduce((sum, h) => sum + h.forward12m * clamp(h.growthPct!, { min: -range.max, max: range.max }), 0) / usableWeight;
    const years = usable.map((h) => h.growthYears);
    const basis: PortfolioGrowthBasis = {
      method: 'PER_SHARE',
      payers: payers.length,
      holdings: usable.length,
      coveragePct: roundTo((usableWeight / totalWeight) * 100, 0),
      minYears: Math.min(...years),
      maxYears: Math.max(...years),
    };
    return { available: true, basis, ...clampedPct(weighted, range, SUGGESTION_DIGITS) };
  }
  if (incomeCagr && incomeCagr.years >= 1) {
    const basis: PortfolioGrowthBasis = {
      method: 'INCOME',
      payers: payers.length,
      holdings: payers.length,
      coveragePct: 100,
      minYears: incomeCagr.years,
      maxYears: incomeCagr.years,
      fromYear: incomeCagr.startYear,
      toYear: incomeCagr.endYear,
    };
    return { available: true, basis, ...clampedPct(incomeCagr.pct, range, SUGGESTION_DIGITS) };
  }
  return { available: false, reason: 'TOO_LITTLE_HISTORY', payers: payers.length, withHistory: usable.length };
}

// --- Yield on new money --------------------------------------------------------------------------------------------------

export const YIELD_PRESETS = ['portfolio', 'payers', 'cost'] as const;
export type YieldPreset = (typeof YIELD_PRESETS)[number];
export const YIELD_PRESET_LABELS: Record<YieldPreset, string> = {
  portfolio: 'Portfolio forward yield (all holdings)',
  payers: 'Dividend payers only',
  cost: 'Yield on cost',
};

export type YieldHolding = Pick<DividendOverviewHolding, 'forward12m' | 'marketValue'>;
export type YieldSummary = Pick<DividendOverviewSummary, 'forward12m' | 'yieldOnValuePct' | 'yieldOnCostPct'>;

export interface YieldBasis {
  preset: YieldPreset;
  /** Forward 12-month income the yield is based on (the whole portfolio's, or the payers'). */
  forward12m: number;
  /** Dividend-paying holdings. */
  payers: number;
}

export type YieldSuggestion = ({ available: true; basis: YieldBasis } & Clamped) | { available: false; reason: 'NO_INCOME' };

/**
 * Yield on new money: the dividend yield expected on money invested from now on, assumed to be the portfolio's current forward
 * yield. `portfolio` = forward 12-month income / market value of all holdings and `cost` = the same income / what was paid
 * (both exactly the figures of the Dividends page); `payers` = forward income / market value of only the holdings that pay.
 */
export function suggestYieldOnNewMoney(preset: YieldPreset, summary: YieldSummary, holdings: readonly YieldHolding[], range: AssumptionRange): YieldSuggestion {
  const payers = holdings.filter((h) => h.forward12m > 0);
  if (summary.forward12m <= 0 || payers.length === 0) return { available: false, reason: 'NO_INCOME' };
  const payersValue = payers.reduce((sum, h) => sum + h.marketValue, 0);
  const payersIncome = payers.reduce((sum, h) => sum + h.forward12m, 0);
  const raw = { portfolio: summary.yieldOnValuePct, cost: summary.yieldOnCostPct, payers: payersValue > 0 ? (payersIncome / payersValue) * 100 : 0 }[preset];
  const basis: YieldBasis = { preset, forward12m: preset === 'payers' ? roundTo(payersIncome) : summary.forward12m, payers: payers.length };
  return { available: true, basis, ...clampedPct(raw, range, YIELD_DIGITS) };
}

// --- Inflation -----------------------------------------------------------------------------------------------------------

export const INFLATION_HORIZONS = ['5y', '10y', '20y', 'all'] as const;
export type InflationHorizon = (typeof INFLATION_HORIZONS)[number];
export const INFLATION_HORIZON_LABELS: Record<InflationHorizon, string> = { '5y': 'Last 5 years', '10y': 'Last 10 years', '20y': 'Last 20 years', all: 'Long run (since 1999)' };
const HORIZON_YEARS: Record<InflationHorizon, number | null> = { '5y': 5, '10y': 10, '20y': 20, all: null };

/** The ECB's medium-term inflation target, a reference value the owner can pick instead of history. */
export const ECB_INFLATION_TARGET_PCT = 2;

const MONTHS = 12;
const monthIndex = (month: string): number => Number(month.slice(0, 4)) * MONTHS + Number(month.slice(5, 7)) - 1;
const monthOf = (index: number): string => `${Math.floor(index / MONTHS)}-${String((index % MONTHS) + 1).padStart(2, '0')}`;

export interface InflationBasis {
  horizon: InflationHorizon;
  /** Whole years averaged. */
  years: number;
  /** The price index is compared between these two months (`YYYY-MM`): `from` is `years` years before `to`, the latest published month. */
  fromMonth: string;
  toMonth: string;
}

export type InflationSuggestion = ({ available: true; basis: InflationBasis } & Clamped) | { available: false; reason: 'TOO_SHORT'; availableYears: number };

/**
 * Average annual inflation over the last N years: the geometric mean of the N annual rates published for the latest month and
 * every 12 months before it, `(prod(1 + r_k))^(1/N) - 1`. Because an annual rate is `index(t) / index(t - 12) - 1`, the product
 * telescopes to `index(latest) / index(latest - 12 N)`: this IS the compound annual growth of the price level over N years,
 * from the same month N years ago to the latest month (no seasonal effects, no overlap). `all` uses every whole year the series
 * covers. A horizon the series is too short for is unavailable rather than shortened.
 */
export function averageInflation(points: readonly InflationPoint[], horizon: InflationHorizon, range: AssumptionRange): InflationSuggestion {
  const byMonth = new Map(points.map((p) => [monthIndex(p.month), p.ratePct]));
  const latest = points.length === 0 ? Number.NaN : Math.max(...byMonth.keys());
  const rates: number[] = [];
  const wanted = HORIZON_YEARS[horizon] ?? Number.POSITIVE_INFINITY;
  for (let k = 0; k < wanted; k++) {
    const rate = byMonth.get(latest - k * MONTHS);
    if (rate === undefined) break;
    rates.push(rate);
  }
  const years = rates.length;
  if (years === 0 || years < (HORIZON_YEARS[horizon] ?? 1)) return { available: false, reason: 'TOO_SHORT', availableYears: years };
  const logSum = rates.reduce((sum, rate) => sum + Math.log1p(rate / 100), 0);
  const raw = (Math.exp(logSum / years) - 1) * 100;
  const basis: InflationBasis = { horizon, years, fromMonth: monthOf(latest - years * MONTHS), toMonth: monthOf(latest) };
  return { available: true, basis, ...clampedPct(raw, range, SUGGESTION_DIGITS) };
}

/** The ECB target as a suggestion (always available), within the range. */
export function ecbTargetInflation(range: AssumptionRange): Clamped {
  return clampedPct(ECB_INFLATION_TARGET_PCT, range, SUGGESTION_DIGITS);
}
