/** Rules engine producing plain-language portfolio insights from the current holdings and income forecast. */
import { calculateAllocation } from './portfolio.js';
import type { PassiveIncome } from './analytics-income.js';
import type { AllocationDimension, AllocationSlice, Holding } from './types.js';

export type InsightSeverity = 'info' | 'warning';

export interface Insight {
  /** Stable rule id, e.g. `concentration-top-holding`. */
  id: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  symbols: string[];
}

/** A rule fires when its measure is strictly above the threshold (below for the dead-weight return). */
export const INSIGHT_THRESHOLDS = {
  /** Largest single holding, share of portfolio value. */
  topHoldingWeight: 0.25,
  /** Largest sector (broad "Diversified" funds and unknown sectors are ignored). */
  sectorWeight: 0.4,
  /** Largest country (funds with country "Global" and unknown countries are ignored). */
  countryWeight: 0.5,
  /** Largest single non-base currency, while total foreign exposure is not already high. */
  currencyWeight: 0.4,
  /** Total share of value in non-base currencies. */
  fxExposure: 0.5,
  /** Dead weight: unrealized return (percent) below this ... */
  deadWeightReturnPct: -15,
  /** ... and portfolio weight below this. */
  deadWeightMaxWeight: 0.02,
  /** Largest holding's share of forward dividend income. */
  incomeShare: 0.4,
} as const;

/** Allocation keys that carry no information about concentration. */
const NEUTRAL_KEYS = new Set(['Diversified', 'Global', 'Unknown']);

const whole = (ratio: number): string => `${Math.round(ratio * 100)}%`;
const bySeverityThenId = (a: Insight, b: Insight) =>
  Number(b.severity === 'warning') - Number(a.severity === 'warning') || a.id.localeCompare(b.id);

/** The largest slice above `threshold`, ignoring neutral keys. */
function largestOver(holdings: readonly Holding[], by: AllocationDimension, threshold: number, ignore: ReadonlySet<string> = NEUTRAL_KEYS): AllocationSlice | undefined {
  return calculateAllocation(holdings, by).find((s) => !ignore.has(s.key) && s.weight > threshold);
}

const symbolsWhere = (holdings: readonly Holding[], predicate: (h: Holding) => boolean): string[] =>
  holdings.filter(predicate).map((h) => h.symbol).sort((a, b) => a.localeCompare(b));

function concentrationInsight(holdings: readonly Holding[]): Insight[] {
  const top = holdings.reduce<Holding | undefined>((best, h) => (!best || h.weight > best.weight ? h : best), undefined);
  if (!top || top.weight <= INSIGHT_THRESHOLDS.topHoldingWeight) return [];
  return [
    {
      id: 'concentration-top-holding',
      severity: 'warning',
      title: `${top.symbol} dominates your portfolio`,
      detail: `${top.name} is ${whole(top.weight)} of your portfolio value (guideline: at most ${whole(INSIGHT_THRESHOLDS.topHoldingWeight)}). A setback in one position would weigh heavily on the total.`,
      symbols: [top.symbol],
    },
  ];
}

function sectorInsight(holdings: readonly Holding[]): Insight[] {
  const slice = largestOver(holdings, 'sector', INSIGHT_THRESHOLDS.sectorWeight);
  if (!slice) return [];
  return [
    {
      id: 'sector-imbalance',
      severity: 'warning',
      title: `Heavy in ${slice.label}`,
      detail: `${whole(slice.weight)} of your portfolio sits in the ${slice.label} sector (guideline: at most ${whole(INSIGHT_THRESHOLDS.sectorWeight)}).`,
      symbols: symbolsWhere(holdings, (h) => h.sector === slice.key),
    },
  ];
}

function countryInsight(holdings: readonly Holding[]): Insight[] {
  const slice = largestOver(holdings, 'country', INSIGHT_THRESHOLDS.countryWeight);
  if (!slice) return [];
  return [
    {
      id: 'country-concentration',
      severity: 'info',
      title: `Concentrated in ${slice.label}`,
      detail: `${whole(slice.weight)} of your portfolio is invested in companies from ${slice.label}, excluding global funds (guideline: at most ${whole(INSIGHT_THRESHOLDS.countryWeight)}).`,
      symbols: symbolsWhere(holdings, (h) => h.country === slice.key),
    },
  ];
}

function currencyInsights(holdings: readonly Holding[], baseCurrency: string): Insight[] {
  const foreign = calculateAllocation(holdings, 'currency').filter((s) => s.key !== baseCurrency);
  const foreignShare = foreign.reduce((s, c) => s + c.weight, 0);
  const isForeign = (h: Holding) => h.currency !== baseCurrency;
  if (foreignShare > INSIGHT_THRESHOLDS.fxExposure) {
    return [
      {
        id: 'fx-exposure',
        severity: 'warning',
        title: 'High currency exposure',
        detail: `${whole(foreignShare)} of your portfolio is held in currencies other than ${baseCurrency} (guideline: at most ${whole(INSIGHT_THRESHOLDS.fxExposure)}). Exchange-rate moves can noticeably change your ${baseCurrency} value.`,
        symbols: symbolsWhere(holdings, isForeign),
      },
    ];
  }
  const biggest = foreign.find((s) => s.weight > INSIGHT_THRESHOLDS.currencyWeight);
  if (!biggest) return [];
  return [
    {
      id: 'currency-concentration',
      severity: 'info',
      title: `Large ${biggest.key} exposure`,
      detail: `${whole(biggest.weight)} of your portfolio is denominated in ${biggest.key} (guideline: at most ${whole(INSIGHT_THRESHOLDS.currencyWeight)} in one foreign currency).`,
      symbols: symbolsWhere(holdings, (h) => h.currency === biggest.key),
    },
  ];
}

function deadWeightInsight(holdings: readonly Holding[]): Insight[] {
  const symbols = symbolsWhere(
    holdings,
    (h) => h.unrealizedPnlPct < INSIGHT_THRESHOLDS.deadWeightReturnPct && h.weight < INSIGHT_THRESHOLDS.deadWeightMaxWeight,
  );
  if (symbols.length === 0) return [];
  return [
    {
      id: 'dead-weight',
      severity: 'info',
      title: symbols.length === 1 ? 'A small position is deep in the red' : `${symbols.length} small positions are deep in the red`,
      detail: `${symbols.join(', ')} ${symbols.length === 1 ? 'is' : 'are'} down more than ${Math.abs(INSIGHT_THRESHOLDS.deadWeightReturnPct)}% yet ${symbols.length === 1 ? 'makes' : 'make'} up under ${whole(INSIGHT_THRESHOLDS.deadWeightMaxWeight)} of your portfolio. Decide whether to keep, add to or sell.`,
      symbols,
    },
  ];
}

function incomeInsight(income: PassiveIncome): Insight[] {
  const top = income.holdings[0];
  if (!top || top.sharePct / 100 <= INSIGHT_THRESHOLDS.incomeShare) return [];
  return [
    {
      id: 'income-concentration',
      severity: 'warning',
      title: `Dividend income relies on ${top.symbol}`,
      detail: `${top.name} provides ${whole(top.sharePct / 100)} of your expected dividend income (guideline: at most ${whole(INSIGHT_THRESHOLDS.incomeShare)}). A dividend cut there would hit your income hard.`,
      symbols: [top.symbol],
    },
  ];
}

/** Warnings first, then by rule id. Empty when the portfolio looks balanced (or is empty). */
export function generateInsights(holdings: readonly Holding[], income: PassiveIncome): Insight[] {
  return [
    ...concentrationInsight(holdings),
    ...sectorInsight(holdings),
    ...countryInsight(holdings),
    ...currencyInsights(holdings, income.baseCurrency),
    ...deadWeightInsight(holdings),
    ...incomeInsight(income),
  ].sort(bySeverityThenId);
}
