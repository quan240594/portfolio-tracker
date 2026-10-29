/**
 * What the earnings cards say, as plain data: the formats, the scorecard rows and the growth lines are decided here, the components only draw them.
 * Numbers follow the app (nl-NL: `US$ 6,92`, `17,2%`), the compact sums are English like the press ("$20.71B"); a figure that was not disclosed is said so,
 * never filled in.
 */
import {
  CONSENSUS_SOURCE_LABEL,
  CORE_METRIC_META,
  KPI_TEMPLATES,
  formatCompactMoney,
  type ConsensusMetric,
  type ConsensusReason,
  type EstimateSurprise,
  type CoreMetricKey,
  type EarningsBasis,
  type EarningsGuidance,
  type EarningsMetric,
  type EarningsSummary,
  type EarningsVerdict,
  type GuidanceDirection,
  type MetricUnit,
} from '@portfolio/shared';
import { formatCount, formatDateTime, formatMoney, formatPercent, formatTime } from '../../lib/format';

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

/** Why a figure has no estimate, in the words the card shows once instead of a bare "no estimate available". */
export const REASON_TEXT: Readonly<Record<ConsensusReason, string>> = {
  'no-key': 'Needs an Alpha Vantage key, which is not set on this deployment',
  pending: 'Fetched on the next free run',
  'no-coverage': 'Not covered by the data provider',
  premium: 'The free Alpha Vantage plan does not include estimates',
  'rate-limited': 'Alpha Vantage is limiting requests right now; the app retries automatically',
  error: 'The last attempt to fetch it failed',
  'no-quarter': 'The data provider has no estimate for this quarter',
  'no-figure': 'The data provider has no estimate for this figure',
  mismatch: 'The estimates did not match the size of the reported figures, so they are not shown',
};

const SOURCE_TEXT: Readonly<Record<ConsensusMetric['source'], string>> = {
  consensus: `Consensus: ${CONSENSUS_SOURCE_LABEL}`,
  release: `Estimate: ${CONSENSUS_SOURCE_LABEL}`,
  calendar: `Calendar estimate: ${CONSENSUS_SOURCE_LABEL}`,
};

/** What the cells of a figure without an estimate say; the reason is said once under the table (`scorecardNote`). */
export const NOT_AVAILABLE = 'n/a';

/** `14:20` today, `30-10-2026, 00:05` another day: when the job asks again (the time of the viewer). */
function retryClock(retryAt: string, now: Date): string {
  const at = new Date(retryAt);
  return at.toDateString() === now.toDateString() ? formatTime(retryAt) : formatDateTime(retryAt);
}

const DETAIL_SHOWN = 120;
const shortDetail = (detail: string): string => (detail.length > DETAIL_SHOWN ? `${detail.slice(0, DETAIL_SHOWN)}…` : detail);

/**
 * The reason line of a figure without an estimate. The detail of a failed attempt is added in brackets; a rate limit says when the job asks again
 * (`retryAt`) when it is known. The provider's own words stay in the Diagnostics, not here.
 */
export function reasonText(reason: ConsensusReason, detail?: string, retryAt?: string, now: Date = new Date()): string {
  if (reason === 'error' && detail !== undefined && detail !== '') return `${REASON_TEXT.error} (${shortDetail(detail)})`;
  if (reason === 'rate-limited' && retryAt !== undefined && !Number.isNaN(Date.parse(retryAt))) return `${REASON_TEXT[reason]} (next try after ${retryClock(retryAt, now)})`;
  return REASON_TEXT[reason];
}

export interface ScorecardRow {
  key: string;
  label: string;
  basis?: EarningsBasis;
  /** Text of the expected cell: the estimate, or why there is none (`no estimate available` for a summary without the consensus fields). */
  expected: string;
  hasEstimate: boolean;
  /** `Range US$ 6,30 to US$ 6,60`, with the estimates of the highest and the lowest analyst. */
  range?: string;
  /** `12 analysts`. */
  analysts?: string;
  /** `Consensus: Alpha Vantage`. */
  source?: string;
  /** Text of the actual cell, or "not disclosed". */
  actual: string;
  disclosed: boolean;
  verdict?: EarningsVerdict;
  /** `+7,3%`: the surprise next to the verdict. */
  surprise?: string;
  /** `Beat by US$ 0,47 (7,3%)`, `Missed by $0.06B (1,9%)` or `In line`: the verdict in words, with the amount. */
  beat?: string;
}

/** `Beat by US$ 0,47 (7,3%)`: the size of the surprise in the unit of the figure and in percent of the estimate. */
export function beatText(verdict: EarningsVerdict, amount: number, pct: number | undefined, show: (value: number) => string): string {
  if (verdict === 'inline') return VERDICT_LABELS.inline;
  const verb = verdict === 'beat' ? 'Beat by' : 'Missed by';
  const percent = pct === undefined ? '' : ` (${formatPercent(Math.abs(pct), { digits: 1 })})`;
  return `${verb} ${show(Math.abs(amount))}${percent}`;
}

/** The estimate of a figure: the joined consensus for EPS and revenue, else what the release was stored with. */
export function estimateOf(summary: EarningsSummary, key: string, metric: EarningsMetric | undefined): ConsensusMetric | undefined {
  if (key === 'eps' && summary.consensus?.eps !== undefined) return summary.consensus.eps;
  if (key === 'revenue' && summary.consensus?.revenue !== undefined) return summary.consensus.revenue;
  if (metric?.estimate === undefined) return undefined;
  const surprise = metric.verdict === undefined ? undefined : { amount: metric.value - metric.estimate, verdict: metric.verdict, ...(metric.surprisePct === undefined ? {} : { pct: metric.surprisePct }) };
  return { average: metric.estimate, source: 'release', ...(surprise === undefined ? {} : { surprise }) };
}

/** What the expected cell says when there is no estimate: `n/a` when the card gives the reason once (`scorecardNote`), else the bare phrase. */
function missingText(summary: EarningsSummary, key: string): string {
  const { consensus } = summary;
  if (consensus === undefined) return NO_ESTIMATE;
  if (key !== 'eps' && key !== 'revenue') return 'Consensus covers EPS and revenue only';
  return consensus.reason === undefined ? NO_ESTIMATE : NOT_AVAILABLE;
}

function rangeText(estimate: ConsensusMetric, unit: MetricUnit, currency: string): string | undefined {
  if (estimate.low === undefined || estimate.high === undefined) return undefined;
  return `Range ${formatMetric(estimate.low, unit, currency)} to ${formatMetric(estimate.high, unit, currency)}`;
}

function surpriseParts(surprise: EstimateSurprise | undefined, unit: MetricUnit, currency: string): Pick<ScorecardRow, 'beat' | 'surprise' | 'verdict'> {
  if (surprise === undefined) return {};
  const text = beatText(surprise.verdict, surprise.amount, surprise.pct, (value) => formatMetric(value, unit, currency));
  const pct = surprise.pct === undefined ? {} : { surprise: formatGrowth(surprise.pct) };
  return { verdict: surprise.verdict, beat: text, ...pct };
}

function estimateParts(estimate: ConsensusMetric, unit: MetricUnit, currency: string): Pick<ScorecardRow, 'range' | 'analysts' | 'source' | 'beat' | 'surprise' | 'verdict'> {
  const range = rangeText(estimate, unit, currency);
  const noun = estimate.analysts === 1 ? 'analyst' : 'analysts';
  const analysts = estimate.analysts === undefined ? undefined : `${estimate.analysts} ${noun}`;
  return {
    ...(range === undefined ? {} : { range }),
    ...(analysts === undefined ? {} : { analysts }),
    source: SOURCE_TEXT[estimate.source],
    ...surpriseParts(estimate.surprise, unit, currency),
  };
}

/** The two rows of the card (per-share result and revenue; AFFO for a REIT) with expected, actual and the verdict. */
export function scorecardRows(summary: EarningsSummary): ScorecardRow[] {
  return KPI_TEMPLATES[summary.template].scorecard.map((key) => {
    const metric = metricOf(summary, key);
    const unit = metric?.unit ?? 'money';
    const estimate = estimateOf(summary, key, metric);
    return {
      key,
      label: labelOf(summary, key),
      ...(metric?.basis === undefined ? {} : { basis: metric.basis }),
      expected: estimate === undefined ? missingText(summary, key) : formatMetric(estimate.average, unit, summary.reportingCurrency),
      hasEstimate: estimate !== undefined,
      actual: metric === undefined ? NOT_DISCLOSED : formatMetric(metric.value, unit, summary.reportingCurrency),
      disclosed: metric !== undefined,
      ...(estimate === undefined ? {} : estimateParts(estimate, unit, summary.reportingCurrency)),
    };
  });
}

/**
 * The reason, said once for the whole scorecard, why its `n/a` cells have no estimate (`Alpha Vantage is limiting requests right now; ...`); `undefined`
 * when every figure has one or the summary has no reason. When only some figures lack an estimate they are named first (`Revenue: ...`).
 */
export function scorecardNote(summary: EarningsSummary, now: Date = new Date()): string | undefined {
  const { consensus } = summary;
  if (consensus?.reason === undefined) return undefined;
  const rows = scorecardRows(summary);
  const lacking = rows.filter((row) => row.expected === NOT_AVAILABLE);
  if (lacking.length === 0) return undefined;
  const text = reasonText(consensus.reason, consensus.detail, consensus.retryAt, now);
  return lacking.length === rows.length ? text : `${lacking.map((row) => row.label).join(' and ')}: ${text}`;
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
  const against = period === 'yoy' ? 'YoY' : 'QoQ';
  if (word === 'flat') return `${label} flat ${against}`;
  return `${label} ${word} ${formatCount(size, 1)}% ${against}`;
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
