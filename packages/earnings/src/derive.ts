/**
 * Everything computed from the verified figures, by code: year-over-year and quarter-over-quarter growth, beat or miss against the
 * estimate, free cash flow (reported, else operating cash flow minus capex), free cash flow per share, operating margin, guidance
 * direction. The model never computes: it only copied values that were found in the release.
 */
import {
  EARNINGS_SCHEMA_VERSION,
  KPI_TEMPLATES,
  classifyBeat,
  roundTo,
  type CoreMetricKey,
  type EarningsBasis,
  type EarningsGuidance,
  type EarningsKpi,
  type EarningsMetric,
  type EarningsOrigin,
  type EarningsSegment,
  type EarningsSummary,
  type GuidanceDirection,
  type KpiTemplateId,
  type MetricUnit,
} from '@portfolio/shared';
import { buybackOf, dividendOf, dividendWithPrevious } from './capital-derive.js';
import type { Verified, VerifiedGuidance, VerifiedPair, VerifiedValue } from './verify.js';

/** The consensus EPS estimate of a release and, when the source has it, the EPS it recorded as reported (to confirm the basis). */
export interface EpsEstimate {
  estimate: number;
  reportedEps?: number;
}

export interface DeriveInput {
  verified: Verified;
  dropped: readonly string[];
  symbol: string;
  name: string;
  template: KpiTemplateId;
  filing: { url: string; accession: string; form: '8-K' | '6-K'; reportDate: string };
  origin: EarningsOrigin;
  /** The currency of the stored profile, used only when the release does not name one. */
  fallbackCurrency?: string;
  model: string;
  neurons: number;
  calls: number;
  now: Date;
  estimate?: EpsEstimate;
  /** The newest stored summary of the symbol (an earlier release), for the quarter-over-quarter figures. */
  previous?: EarningsSummary;
}

/** An actual within 0.5 % of the estimate is "in line" (the rule lives in `@portfolio/shared`, where the API's join uses it too). */
export { IN_LINE_TOLERANCE } from '@portfolio/shared';
export { classifyBeat };

/** Percent change from `from` to `to`; absent when `from` is not positive (a growth rate against a loss or zero says nothing). */
export function changePct(to: number, from: number | undefined): number | undefined {
  if (from === undefined || Number.isNaN(from) || from <= 0) return undefined;
  return roundTo(((to - from) / from) * 100, 1);
}

const points = (to: number, from: number | undefined): number | undefined => (from === undefined ? undefined : roundTo(to - from, 1));

function metricOf(value: number, unit: MetricUnit, extra: { raw?: string; yearAgo?: number; basis?: EarningsBasis }): EarningsMetric {
  const metric: EarningsMetric = { value, unit };
  if (extra.raw !== undefined) metric.raw = extra.raw;
  if (extra.basis !== undefined) metric.basis = extra.basis;
  if (extra.yearAgo !== undefined) {
    metric.yearAgo = extra.yearAgo;
    if (unit === 'percent') metric.yoyPoints = points(value, extra.yearAgo);
    else {
      const pct = changePct(value, extra.yearAgo);
      if (pct !== undefined) metric.yoyPct = pct;
    }
  }
  return metric;
}

function fromPair(pair: VerifiedPair | undefined, unit: MetricUnit, basis?: EarningsBasis): EarningsMetric | undefined {
  return pair === undefined ? undefined : metricOf(pair.value.value, unit, { raw: pair.value.raw, yearAgo: pair.yearAgo?.value, basis });
}

/** Quarter over quarter against the previous summary's figure of the same key, only when it is comparable (same unit and, for EPS, basis). */
function withQuarter(metric: EarningsMetric, before: EarningsMetric | undefined): EarningsMetric {
  if (before === undefined || before.unit !== metric.unit || before.basis !== metric.basis) return metric;
  if (metric.unit === 'percent') return { ...metric, qoqPoints: points(metric.value, before.value) };
  const pct = changePct(metric.value, before.value);
  return pct === undefined ? metric : { ...metric, qoqPct: pct };
}

const sameCurrency = (previous: EarningsSummary | undefined, currency: string): EarningsSummary | undefined => (previous?.reportingCurrency === currency ? previous : undefined);

/** EPS: the basis that the consensus source reports for the quarter (when known), else the adjusted figure, else GAAP. */
function pickEps(verified: Verified, estimate: EpsEstimate | undefined): { metric: EarningsMetric; estimateUsable: boolean } | undefined {
  const adjusted = fromPair(verified.epsAdjusted, 'perShare', 'adjusted');
  const gaap = fromPair(verified.epsGaap, 'perShare', 'GAAP');
  const candidates = [adjusted, gaap].filter((metric): metric is EarningsMetric => metric !== undefined);
  if (candidates.length === 0) return undefined;
  const reported = estimate?.reportedEps;
  const matching = reported === undefined ? undefined : candidates.find((metric) => Math.abs(metric.value - reported) <= Math.max(0.011, Math.abs(reported) * 0.01));
  const chosen = matching ?? candidates[0]!;
  // An estimate whose "reported" EPS matches neither basis belongs to another quarter or another definition: it is not shown.
  return { metric: chosen, estimateUsable: reported === undefined || matching !== undefined };
}

function withEstimate(metric: EarningsMetric, estimate: EpsEstimate | undefined, usable: boolean): EarningsMetric {
  if (estimate === undefined || !usable) return metric;
  return { ...metric, estimate: estimate.estimate, ...classifyBeat(metric.value, estimate.estimate) };
}

const amountOf = (value: VerifiedValue | undefined): number | undefined => value?.value;

/** Free cash flow: the figure the release states, else operating cash flow minus capital expenditure (both printed). */
function freeCashFlow(verified: Verified): EarningsMetric | undefined {
  const reported = verified.freeCashFlow;
  if (reported !== undefined) return fromPair(reported, 'money', 'reported');
  const { operatingCashFlow: ocf, capex } = verified;
  if (ocf === undefined || capex === undefined) return undefined;
  const value = ocf.value.value - Math.abs(capex.value.value);
  const before = ocf.yearAgo !== undefined && capex.yearAgo !== undefined ? ocf.yearAgo.value - Math.abs(capex.yearAgo.value) : undefined;
  return metricOf(value, 'money', { yearAgo: before, basis: 'calculated' });
}

function freeCashFlowPerShare(fcf: EarningsMetric | undefined, shares: VerifiedPair | undefined): EarningsMetric | undefined {
  const count = amountOf(shares?.value);
  if (fcf === undefined || count === undefined || count <= 0) return undefined;
  const yearAgoShares = amountOf(shares?.yearAgo);
  const before = fcf.yearAgo !== undefined && yearAgoShares !== undefined && yearAgoShares > 0 ? fcf.yearAgo / yearAgoShares : undefined;
  return metricOf(roundTo(fcf.value / count, 4), 'perShare', { yearAgo: before === undefined ? undefined : roundTo(before, 4), basis: 'calculated' });
}

function operatingMargin(verified: Verified): EarningsMetric | undefined {
  const printed = fromPair(verified.operatingMargin, 'percent');
  if (printed !== undefined) return printed;
  const income = verified.operatingIncome;
  const revenue = verified.revenue;
  if (income === undefined || revenue === undefined || revenue.value.value <= 0) return undefined;
  const ratio = (a: number, b: number): number => roundTo((a / b) * 100, 2);
  const before = income.yearAgo !== undefined && revenue.yearAgo !== undefined && revenue.yearAgo.value > 0 ? ratio(income.yearAgo.value, revenue.yearAgo.value) : undefined;
  return metricOf(ratio(income.value.value, revenue.value.value), 'percent', { yearAgo: before, basis: 'calculated' });
}

const guidanceUnit = (value: VerifiedValue): MetricUnit => {
  if (value.kind === 'percent') return 'percent';
  if (value.kind === 'plain') return 'count';
  return value.scale !== undefined || Math.abs(value.value) >= 1000 ? 'money' : 'perShare';
};

const normalizeLabel = (label: string): string => label.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim();
const midpoint = (entry: Pick<EarningsGuidance, 'low' | 'high' | 'point'>): number | undefined => {
  if (entry.point !== undefined) return entry.point;
  if (entry.low !== undefined && entry.high !== undefined) return (entry.low + entry.high) / 2;
  return entry.low ?? entry.high;
};

/** Raised, lowered or maintained against the previous summary's guidance of the same label and period; `new` when it had none. */
function guidanceDirection(entry: EarningsGuidance, previous: EarningsSummary | undefined): GuidanceDirection | undefined {
  if (previous === undefined) return undefined;
  const key = normalizeLabel(`${entry.label} ${entry.period ?? ''}`);
  const before = previous.guidance.find((candidate) => normalizeLabel(`${candidate.label} ${candidate.period ?? ''}`) === key);
  const now = midpoint(entry);
  const was = before === undefined ? undefined : midpoint(before);
  if (before === undefined || now === undefined || was === undefined) return 'new';
  const tolerance = Math.abs(was) * 0.0005;
  if (now > was + tolerance) return 'raised';
  if (now < was - tolerance) return 'lowered';
  return 'maintained';
}

function guidanceOf(entries: readonly VerifiedGuidance[], previous: EarningsSummary | undefined): EarningsGuidance[] {
  return entries.map((entry) => {
    const sample = entry.low ?? entry.high ?? entry.point!;
    const raw = entry.point === undefined && entry.low !== undefined && entry.high !== undefined ? `${entry.low.raw} to ${entry.high.raw}` : sample.raw;
    const base: EarningsGuidance = {
      label: entry.label,
      unit: guidanceUnit(sample),
      raw: entry.point?.raw ?? raw,
      ...(entry.period === undefined ? {} : { period: entry.period }),
      ...(entry.low === undefined ? {} : { low: entry.low.value }),
      ...(entry.high === undefined ? {} : { high: entry.high.value }),
      ...(entry.point === undefined ? {} : { point: entry.point.value }),
    };
    const direction = guidanceDirection(base, previous);
    return direction === undefined ? base : { ...base, direction };
  });
}

function segmentsOf(verified: Verified): EarningsSegment[] {
  return verified.segments.map((segment) => {
    const pct = changePct(segment.value.value, segment.yearAgo?.value);
    return {
      name: segment.name,
      value: segment.value.value,
      raw: segment.value.raw,
      ...(segment.yearAgo === undefined ? {} : { yearAgo: segment.yearAgo.value }),
      ...(pct === undefined ? {} : { yoyPct: pct }),
    };
  });
}

function kpisOf(verified: Verified, template: KpiTemplateId, previous: EarningsSummary | undefined): EarningsKpi[] {
  return KPI_TEMPLATES[template].slots.map((slot) => {
    const metric = fromPair(verified.kpis[slot.key], slot.unit);
    const before = previous?.kpis.find((kpi) => kpi.key === slot.key)?.metric;
    return { key: slot.key, label: slot.label, unit: slot.unit, ...(metric === undefined ? {} : { metric: withQuarter(metric, before) }) };
  });
}

/**
 * The summary with its quarter-over-quarter figures and guidance directions recomputed against `previous` (an earlier stored summary). Used when
 * the backfill stores the older quarter after the newer one. Idempotent: it starts by removing what an earlier call (or none) put there.
 */
export function withPrevious(summary: EarningsSummary, rawPrevious: EarningsSummary): EarningsSummary {
  const previous = sameCurrency(rawPrevious, summary.reportingCurrency);
  const bare = (metric: EarningsMetric): EarningsMetric => {
    const { qoqPct: _pct, qoqPoints: _points, ...rest } = metric;
    return rest;
  };
  const headline: Partial<Record<CoreMetricKey, EarningsMetric>> = {};
  for (const [key, metric] of Object.entries(summary.headline) as [CoreMetricKey, EarningsMetric][]) headline[key] = withQuarter(bare(metric), previous?.headline[key]);
  const kpis = summary.kpis.map((kpi) => (kpi.metric === undefined ? kpi : { ...kpi, metric: withQuarter(bare(kpi.metric), previous?.kpis.find((entry) => entry.key === kpi.key)?.metric) }));
  const guidance = summary.guidance.map((entry) => {
    const { direction: _direction, ...rest } = entry;
    const direction = guidanceDirection(rest, previous);
    return direction === undefined ? rest : { ...rest, direction };
  });
  const { previousReportDate: _previousReportDate, ...rest } = summary;
  const dividend = summary.dividend === undefined ? undefined : dividendWithPrevious(summary.dividend, previous);
  return { ...rest, headline, kpis, guidance, ...(dividend === undefined ? {} : { dividend }), ...(previous === undefined ? {} : { previousReportDate: previous.reportDate }) };
}

/** Builds the stored summary of a release from its verified figures. Pure. */
export function deriveSummary(input: DeriveInput): EarningsSummary {
  const { verified, template, previous: rawPrevious } = input;
  const currency = verified.currency ?? input.fallbackCurrency ?? 'USD';
  const previous = sameCurrency(rawPrevious, currency);
  const before = (key: CoreMetricKey): EarningsMetric | undefined => previous?.headline[key];
  const headline: Partial<Record<CoreMetricKey, EarningsMetric>> = {};
  const put = (key: CoreMetricKey, metric: EarningsMetric | undefined): void => {
    if (metric !== undefined) headline[key] = withQuarter(metric, before(key));
  };

  const eps = pickEps(verified, input.estimate);
  if (eps !== undefined) put('eps', withEstimate(eps.metric, input.estimate, eps.estimateUsable));
  put('revenue', fromPair(verified.revenue, 'money'));
  put('operatingIncome', fromPair(verified.operatingIncome, 'money'));
  put('operatingMargin', operatingMargin(verified));
  put('netIncome', fromPair(verified.netIncome, 'money'));
  if (KPI_TEMPLATES[template].showFcf) {
    put('operatingCashFlow', fromPair(verified.operatingCashFlow, 'money'));
    put('capex', fromPair(verified.capex, 'money'));
    const fcf = freeCashFlow(verified);
    put('fcf', fcf);
    put('fcfPerShare', freeCashFlowPerShare(fcf, verified.dilutedShares));
  }
  put('dilutedShares', fromPair(verified.dilutedShares, 'count'));

  return {
    schemaVersion: EARNINGS_SCHEMA_VERSION,
    symbol: input.symbol,
    name: input.name,
    period: verified.period ?? 'Latest quarter',
    reportDate: input.filing.reportDate,
    filingUrl: input.filing.url,
    accession: input.filing.accession,
    form: input.filing.form,
    reportingCurrency: currency,
    template,
    origin: input.origin,
    headline,
    kpis: kpisOf(verified, template, previous),
    guidance: guidanceOf(verified.guidance, previous),
    segments: segmentsOf(verified),
    keyUpdates: verified.keyUpdates,
    ...(verified.quote === undefined ? {} : { quote: verified.quote }),
    ...(verified.dividend === undefined ? {} : { dividend: dividendOf(verified.dividend, currency, previous) }),
    ...(verified.buyback === undefined ? {} : { buyback: buybackOf(verified.buyback, currency) }),
    ...(previous === undefined ? {} : { previousReportDate: previous.reportDate }),
    verification: { dropped: input.dropped.length, droppedFields: [...input.dropped].slice(0, 20), model: input.model, neuronsEstimate: input.neurons, calls: input.calls },
    generatedAt: input.now.toISOString(),
    status: 'ok',
  };
}
