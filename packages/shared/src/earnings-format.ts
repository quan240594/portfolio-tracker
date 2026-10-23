/**
 * Number and message formats of the earnings summaries. Pure and English, shared by the push notification and the web cards, so a figure
 * reads the same everywhere: compact `B`/`M` abbreviations (`$20.71B`), explicit signs (`+11 %`), parts that were not disclosed left out.
 */
import { roundTo } from './analytics.js';
import type { EarningsMetric, EarningsSummary } from './earnings.js';
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH, formatPerShare, shortName, truncate, type NotificationMessage } from './notification-messages.js';

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF ', CAD: 'C$', AUD: 'A$' };

/** `20.71` -> `20.71`, `5.2` -> `5.2`, `850` -> `850`: at most `decimals` decimals, no trailing zeros. */
function trimmed(value: number, decimals: number): string {
  return String(roundTo(value, decimals));
}

/** `$20.71B`, `€850M`, `$1.2K`, `-$300M`: the whole amount in a compact English form. */
export function formatCompactMoney(value: number, currency: string): string {
  const abs = Math.abs(value);
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${symbol}${trimmed(abs / 1e12, 2)}T`;
  if (abs >= 1e9) return `${sign}${symbol}${trimmed(abs / 1e9, 2)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${trimmed(abs / 1e6, 1)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${trimmed(abs / 1e3, 1)}K`;
  return `${sign}${symbol}${trimmed(abs, 2)}`;
}

/** `+11 %`, `-3.4 %`, `0 %`: whole percentages from 10 up, one decimal below. */
export function formatEarningsPct(pct: number): string {
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : roundTo(pct, 1);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${String(rounded)} %`;
}

const pctValue = (pct: number): string => formatEarningsPct(Math.abs(pct)).replace('+', '');

/** `Revenue $20.71B`, `ROTCE 17.2 %`: a metric as a short phrase; undefined for a unit without a sensible compact form. */
export function formatMetricValue(metric: EarningsMetric, currency: string): string {
  switch (metric.unit) {
    case 'money':
      return formatCompactMoney(metric.value, currency);
    case 'perShare':
      return formatPerShare(metric.value, currency);
    case 'percent':
      return `${trimmed(metric.value, 2)} %`;
    case 'ratio':
      return `${trimmed(metric.value, 2)}x`;
    default:
      return trimmed(metric.value, 0);
  }
}

function epsPart(summary: EarningsSummary): string | undefined {
  const eps = summary.headline.eps;
  if (eps?.verdict === undefined) return undefined;
  if (eps.verdict === 'inline') return 'EPS in line';
  const by = eps.surprisePct === undefined ? '' : ` by ${pctValue(eps.surprisePct)}`;
  return `EPS ${eps.verdict === 'beat' ? 'beat' : 'missed'}${by}`;
}

function revenuePart(summary: EarningsSummary): string | undefined {
  const revenue = summary.headline.revenue;
  if (revenue === undefined) return undefined;
  const yoy = revenue.yoyPct === undefined ? '' : ` ${formatEarningsPct(revenue.yoyPct)} YoY`;
  return `Revenue ${formatCompactMoney(revenue.value, summary.reportingCurrency)}${yoy}`;
}

/** The template's key per-share or ratio figure: FCF per share where the template shows free cash flow, else its first reported slot. */
function keyKpiPart(summary: EarningsSummary): string | undefined {
  const fcfPerShare = summary.headline.fcfPerShare;
  if (fcfPerShare !== undefined) return `FCF/share ${formatPerShare(fcfPerShare.value, summary.reportingCurrency)}`;
  const kpi = summary.kpis.find((entry) => entry.metric !== undefined);
  return kpi?.metric === undefined ? undefined : `${kpi.label} ${formatMetricValue(kpi.metric, summary.reportingCurrency)}`;
}

function guidancePart(summary: EarningsSummary): string | undefined {
  const directions = new Set(summary.guidance.map((entry) => entry.direction));
  if (directions.has('raised')) return 'guidance raised';
  if (directions.has('lowered')) return 'guidance lowered';
  return undefined;
}

/**
 * The push message of a stored summary: `Lockheed Martin reported Q3 2026: EPS beat by 7 %` with
 * `Revenue $20.71B +11 % YoY · FCF/share $12.9 · guidance raised`; a tap opens `/earnings/<symbol>`.
 */
export function buildEarningsNotification(summary: EarningsSummary): NotificationMessage {
  const label = shortName(summary.symbol, summary.name);
  const eps = epsPart(summary);
  const titleSuffix = eps === undefined ? '' : `: ${eps}`;
  const lineSuffix = eps === undefined ? '' : ` (${eps})`;
  const title = `${label} reported ${summary.period}${titleSuffix}`;
  const parts = [revenuePart(summary), keyKpiPart(summary), guidancePart(summary)].filter((part): part is string => part !== undefined);
  const body = parts.length > 0 ? parts.join(' · ') : 'The earnings summary is ready.';
  return {
    payload: {
      type: 'earnings',
      symbol: summary.symbol,
      title: truncate(title, MAX_TITLE_LENGTH),
      body: truncate(body, MAX_BODY_LENGTH),
      url: `/earnings/${encodeURIComponent(summary.symbol)}`,
      tag: `earnings:${summary.symbol}:${summary.reportDate}`,
    },
    line: `${label} reported ${summary.period}${lineSuffix}`,
  };
}
