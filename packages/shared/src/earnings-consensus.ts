/**
 * Analyst consensus ("Expected") of the earnings summaries: what is stored, and how it is joined to a summary.
 *
 * The consensus comes from Alpha Vantage `EARNINGS_ESTIMATES` (EPS and revenue per fiscal quarter, with the high, the low and the number of
 * analysts), fetched for the held companies by the `earningsEstimates` job. A release's own press release carries no estimates, so the join is
 * the only place where an estimate meets an actual: beat or miss is computed here, by code, from the actual the summary already has.
 *
 * | Entity                     | PK               | SK                      | entityType                 |
 * |----------------------------|------------------|-------------------------|----------------------------|
 * | Consensus of one quarter   | TICKER#{symbol}  | EARNEST#{quarterEnd}    | EARNINGS_CONSENSUS         |
 * | Last fetch of a symbol     | TICKER#{symbol}  | EARNEST#STATE           | EARNINGS_CONSENSUS_STATE   |
 * | Provider block (global)    | EARNINGS         | ESTIMATES               | EARNINGS_CONSENSUS_BLOCK   |
 * | Endpoint state (global)    | EARNINGS         | ESTIMATES#ENDPOINT      | EARNINGS_CONSENSUS_ENDPOINT |
 *
 * The free Alpha Vantage key may not read `EARNINGS_ESTIMATES` (it answers with generic limit text); the job then notes the endpoint as
 * `unavailable-on-key` and fetches the free `EARNINGS` function instead, which has the EPS estimate of each past quarter and nothing else. Those
 * rows have the same keys and shape, with `source: 'eps-only'`: EPS average only (no range, no analyst count), never revenue.
 *
 * `EARNEST#` shares no prefix with the calendar's `EARN#` or the summaries' `EARNSUM#`. Newest quarter sorts last (`reverse` gives the state
 * item first, then the newest quarters). Everything is additive: a deployment that never runs the job has none of these rows.
 */
import { daysBetween, roundTo } from './analytics.js';
import { fromItem } from './dynamo.js';
import type { EarningsSummary, EarningsVerdict } from './earnings.js';

export const CONSENSUS_ENTITY = { quarter: 'EARNINGS_CONSENSUS', state: 'EARNINGS_CONSENSUS_STATE', block: 'EARNINGS_CONSENSUS_BLOCK', endpoint: 'EARNINGS_CONSENSUS_ENDPOINT' } as const;

export const consensusKeys = {
  quarter: (symbol: string, quarterEnd: string) => ({ PK: `TICKER#${symbol}`, SK: `EARNEST#${quarterEnd}` }),
  state: (symbol: string) => ({ PK: `TICKER#${symbol}`, SK: 'EARNEST#STATE' }),
  tickerPk: (symbol: string) => `TICKER#${symbol}`,
  prefix: 'EARNEST#',
  block: { PK: 'EARNINGS', SK: 'ESTIMATES' },
  endpoint: { PK: 'EARNINGS', SK: 'ESTIMATES#ENDPOINT' },
} as const;

/** The newest fiscal quarters kept from one fetch (the unreported ones and the last reported ones). */
export const CONSENSUS_KEEP_QUARTERS = 12;
/** Rows read for one symbol: the state item and the newest quarters. */
export const CONSENSUS_READ_LIMIT = CONSENSUS_KEEP_QUARTERS + 4;

export const CONSENSUS_SOURCE_LABEL = 'Alpha Vantage';
/** The provenance of EPS-only rows (stored as `ConsensusQuarter.source` / `ConsensusState.source`). */
export const EPS_ONLY_SOURCE = 'eps-only';
export type ConsensusRowSource = typeof EPS_ONLY_SOURCE;
/** What the free `EARNINGS` function gives, in words (the label of the source of an EPS-only estimate). */
export const EPS_ONLY_SOURCE_LABEL = 'Alpha Vantage EARNINGS (EPS only)';
/** After this many days an endpoint noted as unavailable on the key is asked once again. */
export const ENDPOINT_RETRY_DAYS = 7;
/** A provider EPS that differs from the summary's actual by more than this share is on another basis (GAAP against adjusted). */
export const EPS_BASIS_TOLERANCE = 0.05;

/** One estimate: the mean of the analysts, the range and how many analysts there are. Money in whole currency units, EPS per share. */
export interface ConsensusFigure {
  average: number;
  high?: number;
  low?: number;
  analysts?: number;
}

/** The consensus of one fiscal quarter of a symbol (`TICKER#{symbol}` / `EARNEST#{quarterEnd}`). */
export interface ConsensusQuarter {
  symbol: string;
  /** End of the fiscal quarter (YYYY-MM-DD) as the provider dates it. */
  quarterEnd: string;
  eps?: ConsensusFigure;
  revenue?: ConsensusFigure;
  /** The provider ticker the figures were fetched under (a US ticker, through the alias table for another listing). */
  ticker: string;
  fetchedAt: string;
  /** `eps-only`: from the free `EARNINGS` function (EPS average only); absent: from `EARNINGS_ESTIMATES`. */
  source?: ConsensusRowSource;
  /** `eps-only` rows: the EPS the provider recorded as reported, to tell the basis of the figure (GAAP or adjusted) apart. */
  reportedEps?: number;
  /** `eps-only` rows: the provider's own surprise (reported minus estimated): a cross-check only, beat or miss is computed from the summary. */
  providerSurprise?: number;
}

export const CONSENSUS_OUTCOMES = ['ok', 'no-coverage', 'premium', 'rate-limited', 'error'] as const;
export type ConsensusOutcome = (typeof CONSENSUS_OUTCOMES)[number];

/** What the job knows about a symbol (`TICKER#{symbol}` / `EARNEST#STATE`): the last outcome, never a figure. */
export interface ConsensusState {
  symbol: string;
  outcome: ConsensusOutcome;
  /** When the last attempt was made. */
  at: string;
  /** When figures were last stored. */
  fetchedAt?: string;
  /** Sanitised reason: the provider's own words for a refusal (at most 300 characters). */
  detail?: string;
  /** For `rate-limited`: when the job asks again for this symbol. */
  retryAt?: string;
  ticker?: string;
  /** Quarters stored by the last successful fetch. */
  quarters?: number;
  /** `eps-only` when the last figures came from the free `EARNINGS` function. */
  source?: ConsensusRowSource;
  updatedAt: string;
}

/**
 * What the job knows about the `EARNINGS_ESTIMATES` endpoint for this key (`EARNINGS` / `ESTIMATES#ENDPOINT`): the key cannot read it (the provider answers
 * with limit text although `EARNINGS` works). While `retryAt` is in the future the job uses `EARNINGS`; after it, it asks `EARNINGS_ESTIMATES` once more.
 */
export interface ConsensusEndpoint {
  state: 'unavailable-on-key';
  /** When it was noted. */
  at: string;
  retryAt: string;
  /** The provider's sanitised words. */
  detail?: string;
}

/** Why the job does not ask the provider (`EARNINGS` / `ESTIMATES`): the plan has no estimates, or the day's allowance is used. */
export interface ConsensusBlock {
  until: string;
  reason: 'premium' | 'rate-limited';
  at: string;
  /** For `rate-limited`: the kind of limit (`daily`, `burst` or `other`), and how many refusals came before it the same UTC day (the back-off doubles with them). */
  scope?: 'daily' | 'burst' | 'other';
  strikes?: number;
  /** The provider's sanitised words. */
  detail?: string;
}

// --- Reading the rows ----------------------------------------------------------------------------------------------------

/** The rows of `TICKER#{symbol}` / `EARNEST#...` (a query of `consensusKeys.prefix`) as the quarters and the state of the symbol. */
export function readConsensusItems(items: readonly Record<string, unknown>[]): { quarters: ConsensusQuarter[]; state: ConsensusState | null } {
  const stateItem = items.find((item) => item.entityType === CONSENSUS_ENTITY.state);
  return {
    state: stateItem === undefined ? null : fromItem<ConsensusState>(stateItem),
    quarters: items.filter((item) => item.entityType === CONSENSUS_ENTITY.quarter).map((item) => fromItem<ConsensusQuarter>(item)),
  };
}

// --- Beat or miss --------------------------------------------------------------------------------------------------------

/** An actual within 0.5 % of the estimate is "in line". */
export const IN_LINE_TOLERANCE = 0.005;

/**
 * Beat, miss or in line, with the surprise in percent of the estimate (one decimal). The percentage is relative to the size of the estimate, so
 * a loss that is smaller than expected is a beat (estimate -0.50, actual -0.30: +40 %). A zero estimate has no percentage: any difference is
 * then a beat or a miss by sign.
 */
export function classifyBeat(actual: number, estimate: number): { verdict: EarningsVerdict; surprisePct?: number } {
  const diff = actual - estimate;
  // The epsilon keeps 1.005 against 1 a beat: 1.005 - 1 is 0.004999... in floating point.
  const tolerance = Math.abs(estimate) * IN_LINE_TOLERANCE - 1e-9;
  let verdict: EarningsVerdict = 'inline';
  if (diff > 0 && diff >= tolerance) verdict = 'beat';
  else if (diff < 0 && -diff >= tolerance) verdict = 'miss';
  return estimate === 0 ? { verdict } : { verdict, surprisePct: roundTo((diff / Math.abs(estimate)) * 100, 1) };
}

// --- The joined view -----------------------------------------------------------------------------------------------------

/** Where an estimate on a summary comes from: the stored consensus, the release-time EPS estimate, or the calendar's EPS estimate. */
export type EstimateSource = 'consensus' | 'release' | 'calendar';

export interface EstimateSurprise {
  /** Actual minus estimate, in the unit of the figure (the currency of the summary for revenue). */
  amount: number;
  /** Percent of the estimate; absent for a zero estimate. */
  pct?: number;
  verdict: EarningsVerdict;
}

export interface ConsensusMetric extends ConsensusFigure {
  source: EstimateSource;
  /** True for a consensus from the free `EARNINGS` function: EPS only, no range and no analyst count. */
  epsOnly?: true;
  /** Set when the provider's reported EPS differs from the summary's actual by more than 5 %: the two are probably on another basis (GAAP or adjusted). */
  basisMismatch?: true;
  /** Absent when the summary has no actual for the figure. */
  surprise?: EstimateSurprise;
}

/** Why a figure has no estimate: shown instead of a bare "no estimate available". */
export const CONSENSUS_REASONS = ['no-key', 'pending', 'no-coverage', 'premium', 'rate-limited', 'error', 'no-quarter', 'no-figure', 'mismatch', 'free-plan'] as const;
export type ConsensusReason = (typeof CONSENSUS_REASONS)[number];

/** Additive view attached to a summary by the API (never stored). */
export interface SummaryConsensus {
  /** Label of the provider of `source: 'consensus'` figures. */
  provider: typeof CONSENSUS_SOURCE_LABEL;
  /** The fiscal quarter end the consensus was matched to. */
  quarterEnd?: string;
  /** When the matched consensus was fetched. */
  asOf?: string;
  eps?: ConsensusMetric;
  revenue?: ConsensusMetric;
  /** Set when at least one of the two has no estimate and the job record knows why. */
  reason?: ConsensusReason;
  /** `free-plan` when there is no revenue estimate because the key only reads the free `EARNINGS` function: the reason of the revenue alone (`reason` is then about EPS, if at all). */
  revenueReason?: 'free-plan';
  /** The sanitised detail of the last failed attempt (the provider's own words for a refusal). */
  detail?: string;
  /** For `rate-limited`: when the job tries again. */
  retryAt?: string;
}

/** An earnings date of the calendar, as far as the join needs it (a stored `StoredEarningsEvent`). */
export interface CalendarEstimate {
  date: string;
  fiscalPeriodEnd?: string;
  epsEstimate?: number;
  currency?: string;
}

export interface ConsensusInput {
  /** The stored quarters of the symbol (any order). */
  quarters: readonly ConsensusQuarter[];
  state?: ConsensusState | null;
  /** The calendar's earnings events of the symbol: their EPS estimate is used when no consensus is stored. */
  calendar?: readonly CalendarEstimate[];
  /** False when the deployment has no Alpha Vantage key: nothing will ever be fetched, which is not "pending". */
  keyed?: boolean;
  /** The noted state of the estimates endpoint: `unavailable-on-key` means no revenue consensus will ever come. */
  endpoint?: ConsensusEndpoint | null;
}

/** The nearest quarter within this many days is the fiscal quarter of a release whose period end is known. */
export const QUARTER_MATCH_DAYS = 20;
/** A quarter that ended 1 to this many days before the release is the quarter it reports on. */
const MAX_REPORT_LAG_DAYS = 120;
/** The report date and the calendar's date of the same release may differ by a few days. */
const CALENDAR_MATCH_DAYS = 4;
/** An actual revenue outside this multiple of the estimate is another company, another currency or another quarter. */
const PLAUSIBLE_REVENUE_RATIO = 5;

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const LONG_DATE = /\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/;

/** The date a release names its period with ("quarter ended June 30, 2026", "2026-06-30"), if it names one. */
export function periodEndOf(period: string): string | undefined {
  const iso = ISO_DATE.exec(period)?.[1];
  if (iso !== undefined) return iso;
  const long = LONG_DATE.exec(period);
  if (long === null) return undefined;
  const month = MONTHS.findIndex((name) => name.startsWith(long[1]!.toLowerCase()));
  if (month < 0) return undefined;
  return `${long[3]}-${String(month + 1).padStart(2, '0')}-${long[2]!.padStart(2, '0')}`;
}

/** The item with the smallest `gap` (the earlier one on a tie, by `tie`); `undefined` for an empty list. */
function closest<T>(items: readonly T[], gap: (item: T) => number, tie: (item: T) => string): T | undefined {
  return items.reduce<T | undefined>((best, item) => (best === undefined || gap(item) < gap(best) || (gap(item) === gap(best) && tie(item).localeCompare(tie(best)) < 0) ? item : best), undefined);
}

/** The calendar event of the release: the one dated within a few days of the report date, the nearest first. */
function calendarEventOf(summary: EarningsSummary, calendar: readonly CalendarEstimate[]): CalendarEstimate | undefined {
  const near = calendar.filter((event) => Math.abs(daysBetween(event.date, summary.reportDate)) <= CALENDAR_MATCH_DAYS);
  return closest(near, (event) => Math.abs(daysBetween(event.date, summary.reportDate)), (event) => event.date);
}

/**
 * The quarter a summary reports on. A known fiscal period end (the calendar's, else the one the release names) picks the quarter that ends
 * on it, or the nearest within 20 days; otherwise the latest quarter that ended 1 to 120 days before the release.
 */
export function matchQuarter(summary: EarningsSummary, quarters: readonly ConsensusQuarter[], hint?: string): ConsensusQuarter | undefined {
  const known = hint ?? periodEndOf(summary.period);
  if (known !== undefined) {
    const gap = (quarter: ConsensusQuarter): number => Math.abs(daysBetween(quarter.quarterEnd, known));
    const nearest = closest(quarters.filter((quarter) => gap(quarter) <= QUARTER_MATCH_DAYS), gap, (quarter) => quarter.quarterEnd);
    if (nearest !== undefined) return nearest;
  }
  const lag = (quarter: ConsensusQuarter): number => daysBetween(quarter.quarterEnd, summary.reportDate);
  return closest(quarters.filter((quarter) => lag(quarter) >= 1 && lag(quarter) <= MAX_REPORT_LAG_DAYS), lag, (quarter) => quarter.quarterEnd);
}

/** The surprise of an actual against an estimate; `undefined` without an actual. */
export function surpriseOf(actual: number | undefined, estimate: number): EstimateSurprise | undefined {
  if (actual === undefined) return undefined;
  const { verdict, surprisePct } = classifyBeat(actual, estimate);
  return { amount: roundTo(actual - estimate, 4), ...(surprisePct === undefined ? {} : { pct: surprisePct }), verdict };
}

function metricOf(figure: ConsensusFigure, source: EstimateSource, actual: number | undefined): ConsensusMetric {
  const surprise = surpriseOf(actual, figure.average);
  return { ...figure, source, ...(surprise === undefined ? {} : { surprise }) };
}

/** Whether the provider's reported EPS is so far from the summary's actual that they are on another basis (GAAP against adjusted). */
export function basisDiffers(providerEps: number | undefined, actual: number | undefined): boolean {
  if (providerEps === undefined || actual === undefined) return false;
  return Math.abs(providerEps - actual) > Math.max(Math.abs(actual), 0.01) * EPS_BASIS_TOLERANCE;
}

/** The EPS figure of a stored quarter, with the provenance of an EPS-only row and the check of its basis; beat or miss always uses the summary's actual. */
function epsMetricOf(quarter: ConsensusQuarter, figure: ConsensusFigure, actual: number | undefined): ConsensusMetric {
  const metric = metricOf(figure, 'consensus', actual);
  if (quarter.source !== EPS_ONLY_SOURCE) return metric;
  return { ...metric, epsOnly: true, ...(basisDiffers(quarter.reportedEps, actual) ? { basisMismatch: true as const } : {}) };
}

/** Whether the actual revenue is of the size the estimate expects (a different currency or company is off by a large factor). */
function plausible(revenue: number | undefined, estimate: ConsensusFigure | undefined): boolean {
  if (revenue === undefined || estimate === undefined || estimate.average <= 0 || revenue <= 0) return true;
  const ratio = revenue / estimate.average;
  return ratio <= PLAUSIBLE_REVENUE_RATIO && ratio >= 1 / PLAUSIBLE_REVENUE_RATIO;
}

/** The EPS estimate the release itself was stored with (Alpha Vantage `EARNINGS` at the time of the release), as a figure. */
function releaseEps(summary: EarningsSummary): ConsensusMetric | undefined {
  const eps = summary.headline.eps;
  if (eps?.estimate === undefined) return undefined;
  return metricOf({ average: eps.estimate }, 'release', eps.value);
}

function calendarEps(summary: EarningsSummary, event: CalendarEstimate | undefined): ConsensusMetric | undefined {
  if (event?.epsEstimate === undefined) return undefined;
  if (event.currency !== undefined && event.currency !== '' && event.currency !== summary.reportingCurrency) return undefined;
  return metricOf({ average: event.epsEstimate }, 'calendar', summary.headline.eps?.value);
}

/** Why there is no (or no usable) consensus, from the job record of the symbol. */
function reasonOf(state: ConsensusState | null | undefined, matched: boolean, mismatch: boolean, keyed: boolean): { reason: ConsensusReason; detail?: string; retryAt?: string } {
  if (mismatch) return { reason: 'mismatch' };
  if (matched) return { reason: 'no-figure' };
  if (state === null || state === undefined) return { reason: keyed ? 'pending' : 'no-key' };
  if (state.outcome === 'ok') return { reason: 'no-quarter' };
  return { reason: state.outcome, ...(state.detail === undefined ? {} : { detail: state.detail }), ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }) };
}

/** The EPS estimate: the matched quarter's, else the one the release was stored with, then the calendar's. */
function epsOf(summary: EarningsSummary, usable: ConsensusQuarter | undefined, event: CalendarEstimate | undefined): ConsensusMetric | undefined {
  if (usable?.eps === undefined) return releaseEps(summary) ?? calendarEps(summary, event);
  return epsMetricOf(usable, usable.eps, summary.headline.eps?.value);
}

/** Whether the key only reads the free `EARNINGS` function (the matched quarter is EPS-only, or the endpoint is noted unavailable): there is no revenue consensus at all, said once as such. */
const readsEpsOnly = (usable: ConsensusQuarter | undefined, endpoint: ConsensusEndpoint | null | undefined): boolean => usable?.source === EPS_ONLY_SOURCE || endpoint?.state === 'unavailable-on-key';

/**
 * The summary with its estimates attached (`consensus`). The EPS estimate is the stored consensus of the matching fiscal quarter; without one,
 * the estimate the release was stored with, then the calendar's. Revenue only has the consensus. Beat or miss is computed against the actual of
 * the summary (`headline.eps` and `headline.revenue`): `actual - estimate`, percent of the size of the estimate. A consensus whose revenue is
 * far from the actual revenue (another currency or company) is dropped as a mismatch.
 */
export function attachConsensus(summary: EarningsSummary, input: ConsensusInput): EarningsSummary {
  const event = calendarEventOf(summary, input.calendar ?? []);
  const quarter = matchQuarter(summary, input.quarters, event?.fiscalPeriodEnd);
  const mismatch = quarter !== undefined && !plausible(summary.headline.revenue?.value, quarter.revenue);
  const usable = mismatch ? undefined : quarter;
  const eps = epsOf(summary, usable, event);
  const revenue = usable?.revenue === undefined ? undefined : metricOf(usable.revenue, 'consensus', summary.headline.revenue?.value);
  const freePlan = readsEpsOnly(usable, input.endpoint);
  const missing = eps === undefined || (revenue === undefined && !freePlan);
  const why = missing ? reasonOf(input.state, usable !== undefined, mismatch, input.keyed ?? true) : undefined;
  const consensus: SummaryConsensus = {
    provider: CONSENSUS_SOURCE_LABEL,
    ...(usable === undefined ? {} : { quarterEnd: usable.quarterEnd, asOf: usable.fetchedAt }),
    ...(eps === undefined ? {} : { eps }),
    ...(revenue === undefined ? {} : { revenue }),
    ...why,
    ...(revenue === undefined && freePlan ? { revenueReason: 'free-plan' as const } : {}),
  };
  return { ...summary, consensus };
}
