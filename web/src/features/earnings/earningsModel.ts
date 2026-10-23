/**
 * What the earnings cards say, as plain data: the formats, the scorecard rows and the growth lines are decided here, the components only draw them.
 * Numbers follow the app (nl-NL: `US$ 6,92`, `17,2%`), the compact sums are English like the press ("$20.71B"); a figure that was not disclosed is said so,
 * never filled in.
 */
import {
  CORE_METRIC_META,
  KPI_TEMPLATES,
  formatCompactMoney,
  type CoreMetricKey,
  type EarningsBasis,
  type EarningsGuidance,
  type EarningsMetric,
  type EarningsSummary,
  type EarningsVerdict,
  type GuidanceDirection,
  type MetricUnit,
} from '@portfolio/shared';
import { formatCount, formatMoney, formatPercent } from '../../lib/format';

export const NOT_DISCLOSED = 'not disclosed';
export const NO_ESTIMATE = 'no estimate available';
export const FIRST_QUARTER_NOTE = 'n/a, first stored quarter';

/** A compact English count: `758M`, `41M`, `1.2B`. */
export function compactCount(value: number): string {
  return formatCompactMoney(value, '').replace(/^(-?)\s*/, '$1');
}

const trimDigits = (value: number): number => Math.round(value * 100) / 100;

/** One figure in the unit it has: money compact and in English, per-share amounts and percentages in the app's locale. */
export function formatMetric(value: number, unit: MetricUnit, currency: string): string {
  switch (unit) {
    case 'money':
      return formatCompactMoney(value, currency);
    case 'perShare':
      return formatMoney(value, currency, { maxDigits: 2 });
    case 'percent':
      return formatPercent(value, { digits: 1 });
    case 'ratio':
      return `${trimDigits(value)}x`;
    default:
      return compactCount(value);
  }
}

/** `+11%`, `-3,4%`: whole percentages from 10 up, one decimal below. */
export const formatGrowth = (pct: number): string => formatPercent(pct, { signed: true, digits: Math.abs(pct) >= 10 ? 0 : 1 });

/** `+0,3 pt`: a change of a percentage metric, in percentage points. */
export const formatPoints = (points: number): string => `${points > 0 ? '+' : ''}${formatCount(points, 1)} pt`;

export const BASIS_LABELS: Readonly<Record<EarningsBasis, string>> = { GAAP: 'GAAP', adjusted: 'adjusted', reported: 'reported', calculated: 'calculated' };

export const VERDICT_LABELS: Readonly<Record<EarningsVerdict, string>> = { beat: 'Beat', miss: 'Miss', inline: 'In line' };

export const DIRECTION_LABELS: Readonly<Record<GuidanceDirection, string>> = { raised: 'Raised', lowered: 'Lowered', maintained: 'Maintained', new: 'New' };

/** The label of a key: a core figure or a slot of the summary's template. */
export function labelOf(summary: EarningsSummary, key: string): string {
  const slot = KPI_TEMPLATES[summary.template].slots.find((entry) => entry.key === key);
  if (slot !== undefined) return slot.label;
  return key in CORE_METRIC_META ? CORE_METRIC_META[key as CoreMetricKey].label : key;
}

/** The stored figure of a key: a headline metric or a template slot (absent = not disclosed). */
export function metricOf(summary: EarningsSummary, key: string): EarningsMetric | undefined {
  return summary.headline[key as CoreMetricKey] ?? summary.kpis.find((kpi) => kpi.key === key)?.metric;
}

export interface ScorecardRow {
  key: string;
  label: string;
  basis?: EarningsBasis;
  /** Text of the expected cell: the estimate, or "no estimate available". */
  expected: string;
  hasEstimate: boolean;
  /** Text of the actual cell, or "not disclosed". */
  actual: string;
  disclosed: boolean;
  verdict?: EarningsVerdict;
  /** `+7,3%`: the surprise next to the verdict. */
  surprise?: string;
}

/** The two rows of the card (per-share result and revenue; AFFO for a REIT) with expected, actual and the verdict. */
export function scorecardRows(summary: EarningsSummary): ScorecardRow[] {
  return KPI_TEMPLATES[summary.template].scorecard.map((key) => {
    const metric = metricOf(summary, key);
    const unit = metric?.unit ?? 'money';
    return {
      key,
      label: labelOf(summary, key),
      ...(metric?.basis === undefined ? {} : { basis: metric.basis }),
      expected: metric?.estimate === undefined ? NO_ESTIMATE : formatMetric(metric.estimate, unit, summary.reportingCurrency),
      hasEstimate: metric?.estimate !== undefined,
      actual: metric === undefined ? NOT_DISCLOSED : formatMetric(metric.value, unit, summary.reportingCurrency),
      disclosed: metric !== undefined,
      ...(metric?.verdict === undefined ? {} : { verdict: metric.verdict }),
      ...(metric?.surprisePct === undefined ? {} : { surprise: formatGrowth(metric.surprisePct) }),
    };
  });
}

export interface GrowthLine {
  key: string;
  text: string;
  /** `yoy` or `qoq`: the accessible expansion is added by the component. */
  period: 'yoy' | 'qoq';
}

const direction = (pct: number): string => {
  if (pct > 0) return 'up';
  return pct < 0 ? 'down' : 'flat';
};

function lineOf(label: string, pct: number, period: GrowthLine['period']): string {
  const word = direction(pct);
  const size = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.round(Math.abs(pct) * 10) / 10;
  return word === 'flat' ? `${label} flat ${period === 'yoy' ? 'YoY' : 'QoQ'}` : `${label} ${word} ${formatCount(size, 1)}% ${period === 'yoy' ? 'YoY' : 'QoQ'}`;
}

/** The keys the growth lines cover: the scorecard rows, then free cash flow and per share where the template shows it. */
export function growthKeys(summary: EarningsSummary): string[] {
  const template = KPI_TEMPLATES[summary.template];
  return [...template.scorecard, ...(template.showFcf ? ['fcf', 'fcfPerShare'] : [])].filter((key) => metricOf(summary, key) !== undefined);
}

/** `EPS up 161% YoY`, `Revenue up 17% QoQ`: only the comparisons that could be computed. */
export function growthLines(summary: EarningsSummary): GrowthLine[] {
  const lines: GrowthLine[] = [];
  for (const key of growthKeys(summary)) {
    const metric = metricOf(summary, key)!;
    const label = labelOf(summary, key);
    if (metric.yoyPct !== undefined) lines.push({ key: `${key}-yoy`, text: lineOf(label, metric.yoyPct, 'yoy'), period: 'yoy' });
  }
  for (const key of growthKeys(summary)) {
    const metric = metricOf(summary, key)!;
    if (metric.qoqPct !== undefined) lines.push({ key: `${key}-qoq`, text: lineOf(labelOf(summary, key), metric.qoqPct, 'qoq'), period: 'qoq' });
  }
  return lines;
}

/** Whether any quarter-over-quarter figure could be computed (the first stored quarter has none). */
export const hasQuarterComparison = (summary: EarningsSummary): boolean => summary.previousReportDate !== undefined;

/** `$80.0B to $81.5B` (the release's own words) or the point figure. */
export const guidanceText = (entry: EarningsGuidance): string => entry.raw;

/** The change line of a metric: `+11% YoY`, `+0,3 pt YoY` or nothing. */
export function changeParts(metric: EarningsMetric): { text: string; period: 'yoy' | 'qoq'; negative: boolean }[] {
  const parts: { text: string; period: 'yoy' | 'qoq'; negative: boolean }[] = [];
  if (metric.yoyPct !== undefined) parts.push({ text: formatGrowth(metric.yoyPct), period: 'yoy', negative: metric.yoyPct < 0 });
  if (metric.yoyPoints !== undefined) parts.push({ text: formatPoints(metric.yoyPoints), period: 'yoy', negative: metric.yoyPoints < 0 });
  if (metric.qoqPct !== undefined) parts.push({ text: formatGrowth(metric.qoqPct), period: 'qoq', negative: metric.qoqPct < 0 });
  if (metric.qoqPoints !== undefined) parts.push({ text: formatPoints(metric.qoqPoints), period: 'qoq', negative: metric.qoqPoints < 0 });
  return parts;
}
