import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EARNINGS_DISCLAIMER, KPI_TEMPLATES, type EarningsMetric, type EarningsSummary } from '@portfolio/shared';
import { CompanyLogo } from '../../components/CompanyLogo';
import { formatDate } from '../../lib/format';
import {
  BASIS_LABELS,
  DIRECTION_LABELS,
  FIRST_QUARTER_NOTE,
  NOT_DISCLOSED,
  NO_ESTIMATE,
  changeParts,
  estimateOf,
  formatMetric,
  growthLines,
  guidanceText,
  hasQuarterComparison,
  labelOf,
  metricOf,
  scorecardNote,
  scorecardRows,
} from './earningsModel';
import { BasisBadge, VerdictChip } from './VerdictChip';

const Period = ({ period }: Readonly<{ period: 'yoy' | 'qoq' }>) =>
  period === 'yoy' ? <abbr title="year over year">YoY</abbr> : <abbr title="quarter over quarter">QoQ</abbr>;

function Changes({ metric }: Readonly<{ metric: EarningsMetric }>) {
  return (
    <>
      {changeParts(metric).map((part) => (
        <span key={`${part.period}-${part.text}`} className={`tabular-nums ${part.negative ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
          {part.text} <Period period={part.period} />
        </span>
      ))}
    </>
  );
}

/** The scorecard: expected, actual and beat or miss, as a real table that stacks its cells below 640 px. */
function Scorecard({ summary, labelledBy }: Readonly<{ summary: EarningsSummary; labelledBy: string }>) {
  const rows = scorecardRows(summary);
  const note = scorecardNote(summary);
  return (
    <>
      <table aria-labelledby={labelledBy} className="w-full text-sm max-sm:block">
        <caption className="sr-only">Expected and actual figures with beat or miss</caption>
        <thead className="max-sm:sr-only">
          <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <th scope="col" className="py-1 pr-3 font-medium">
              <span className="sr-only">Figure</span>
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              Expected
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              Actual
            </th>
            <th scope="col" className="py-1 pl-3 font-medium">
              Beat/Miss
            </th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-200 align-top dark:border-slate-700 max-sm:block max-sm:py-2">
              <th scope="row" className="py-2 pr-3 text-left font-semibold max-sm:block max-sm:py-0">
                {row.label}
                {row.basis && (
                  <span className="ml-2 align-middle">
                    <BasisBadge title={`${BASIS_LABELS[row.basis]} figure`}>{BASIS_LABELS[row.basis]}</BasisBadge>
                  </span>
                )}
              </th>
              <td className="px-3 py-2 max-sm:block max-sm:px-0 max-sm:py-0.5" data-label="Expected">
                <span className="muted mr-2 sm:hidden">Expected</span>
                <span className={row.hasEstimate ? 'tabular-nums' : 'muted text-xs'}>{row.expected}</span>
                {row.analysts && <span className="muted ml-1 text-xs">({row.analysts})</span>}
                {row.range && <span className="muted block text-xs tabular-nums">{row.range}</span>}
                {row.source && <span className="muted block text-[11px]">{row.source}</span>}
              </td>
              <td className="px-3 py-2 font-semibold tabular-nums max-sm:block max-sm:px-0 max-sm:py-0.5" data-label="Actual">
                <span className="muted mr-2 font-normal sm:hidden">Actual</span>
                <span className={row.disclosed ? '' : 'muted text-xs font-normal'}>{row.actual}</span>
              </td>
              <td className="py-2 pl-3 max-sm:block max-sm:px-0 max-sm:py-0.5" data-label="Beat/Miss">
                <span className="muted mr-2 sm:hidden">Beat/Miss</span>
                {row.verdict ? <VerdictChip verdict={row.verdict} surprise={row.surprise} text={row.beat} /> : <span className="muted text-xs">{row.hasEstimate ? NOT_DISCLOSED : row.expected}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="muted mt-2 text-xs break-words">{note}</p>}
    </>
  );
}

function GrowthList({ summary }: Readonly<{ summary: EarningsSummary }>) {
  const lines = growthLines(summary);
  const first = !hasQuarterComparison(summary);
  if (lines.length === 0 && !first) return null;
  return (
    <ul className="mt-3 space-y-1 text-sm" aria-label="Growth">
      {lines.map((line) => (
        <li key={line.key}>{line.text.replace(/ (YoY|QoQ)$/, '')} <Period period={line.period} /></li>
      ))}
      {first && (
        <li className="muted">
          <abbr title="quarter over quarter">QoQ</abbr>: {FIRST_QUARTER_NOTE}
        </li>
      )}
    </ul>
  );
}

function MetricLine({ summary, metricKey, hideChange = false }: Readonly<{ summary: EarningsSummary; metricKey: string; hideChange?: boolean }>) {
  const metric = metricOf(summary, metricKey);
  const label = labelOf(summary, metricKey);
  const estimate = metric === undefined ? undefined : estimateOf(summary, metricKey, metric);
  if (metric === undefined) {
    return (
      <li className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span>{label}</span>
        <span className="muted text-xs">{NOT_DISCLOSED}</span>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="flex flex-wrap items-center gap-2">
        {label}
        {metric.basis && <BasisBadge title={`${BASIS_LABELS[metric.basis]} figure`}>{BASIS_LABELS[metric.basis]}</BasisBadge>}
      </span>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-right">
        <strong className="tabular-nums">{formatMetric(metric.value, metric.unit, summary.reportingCurrency)}</strong>
        {estimate !== undefined && <span className="muted text-xs tabular-nums">Est. {formatMetric(estimate.average, metric.unit, summary.reportingCurrency)}</span>}
        {estimate?.surprise && <VerdictChip verdict={estimate.surprise.verdict} surprise={surpriseText(estimate.surprise.pct)} />}
        {!hideChange && <Changes metric={metric} />}
      </span>
    </li>
  );
}

function surpriseText(pct: number | undefined): string | undefined {
  if (pct === undefined) return undefined;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Math.round(pct * 10) / 10}%`;
}

function Section({ title, defaultOpen = true, children }: Readonly<{ title: string; defaultOpen?: boolean; children: ReactNode }>) {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-slate-200 dark:border-slate-700">
      <summary className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <span>{title}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 8l5 5 5-5" />
        </svg>
      </summary>
      <div className="border-t border-slate-200 px-3 py-3 text-sm dark:border-slate-700">{children}</div>
    </details>
  );
}

const RESULT_KEYS = ['revenue', 'eps', 'operatingIncome', 'operatingMargin', 'netIncome'] as const;
const CASH_KEYS = ['fcf', 'fcfPerShare', 'operatingCashFlow', 'capex'] as const;

function Details({ summary }: Readonly<{ summary: EarningsSummary }>) {
  const template = KPI_TEMPLATES[summary.template];
  const results = RESULT_KEYS.filter((key) => summary.headline[key] !== undefined);
  const cash = template.showFcf ? CASH_KEYS.filter((key) => summary.headline[key] !== undefined) : [];
  return (
    <div className="mt-4 space-y-2">
      {results.length > 0 && (
        <Section title="Results">
          <ul className="space-y-2">
            {results.map((key) => (
              <MetricLine key={key} summary={summary} metricKey={key} />
            ))}
          </ul>
        </Section>
      )}
      {summary.guidance.length > 0 && (
        <Section title="Guidance">
          <ul className="space-y-2">
            {summary.guidance.map((entry) => (
              <li key={`${entry.label}-${entry.period ?? ''}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span>
                  {entry.label}
                  {entry.period && <span className="muted"> · {entry.period}</span>}
                </span>
                <span className="flex flex-wrap items-baseline gap-x-3 text-right">
                  <strong className="tabular-nums">{guidanceText(entry)}</strong>
                  {entry.direction && <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium dark:border-slate-600">{DIRECTION_LABELS[entry.direction]}</span>}
                  <span className="muted text-xs">{NO_ESTIMATE}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {template.showFcf && (
        <Section title="Cash flow">
          {cash.length === 0 ? (
            <p className="muted">{NOT_DISCLOSED}</p>
          ) : (
            <ul className="space-y-2">
              {cash.map((key) => (
                <MetricLine key={key} summary={summary} metricKey={key} />
              ))}
            </ul>
          )}
        </Section>
      )}
      {template.slots.length > 0 && (
        <Section title={`${template.label} figures`}>
          <ul className="space-y-2">
            {template.slots.map((slot) => (
              <MetricLine key={slot.key} summary={summary} metricKey={slot.key} />
            ))}
          </ul>
        </Section>
      )}
      {summary.segments.length > 0 && (
        <Section title="Segment sales" defaultOpen={false}>
          <ul className="space-y-2">
            {summary.segments.map((segment) => (
              <li key={segment.name} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span>{segment.name}</span>
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <strong className="tabular-nums">{formatMetric(segment.value, 'money', summary.reportingCurrency)}</strong>
                  {segment.yoyPct !== undefined && <Changes metric={{ value: segment.value, unit: 'money', yoyPct: segment.yoyPct }} />}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.keyUpdates.length > 0 && (
        <Section title="Key updates" defaultOpen={false}>
          <ul className="list-disc space-y-1 pl-5">
            {summary.keyUpdates.map((update) => (
              <li key={update}>{update}</li>
            ))}
          </ul>
        </Section>
      )}
      {summary.quote && (
        <Section title="Management" defaultOpen={false}>
          <blockquote className="border-l-4 border-slate-300 pl-3 italic dark:border-slate-600">
            “{summary.quote.text}”
            {summary.quote.speaker && <footer className="muted mt-1 text-xs not-italic">{summary.quote.speaker}</footer>}
          </blockquote>
        </Section>
      )}
    </div>
  );
}

interface Props {
  summary: EarningsSummary;
  /** `compact` shows the scorecard and growth only (the asset detail section). */
  variant?: 'full' | 'compact';
  /** Adds the active portfolio scope to in-app links. */
  withScope?: (to: string) => string;
}

/** One earnings summary: header, the scorecard, the growth lines and the details. Everything shown was found in the release. */
export function EarningsCard({ summary, variant = 'full', withScope = (to) => to }: Readonly<Props>) {
  const headingId = `earnings-${summary.symbol}-${summary.reportDate}`;
  const dropped = summary.verification.dropped;
  return (
    <article className="card p-4 sm:p-5" aria-labelledby={headingId} data-template={summary.template}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <CompanyLogo symbol={summary.symbol} name={summary.name} size={40} decorative />
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold break-words">
              {variant === 'compact' ? (
                `${summary.name} · ${summary.period}`
              ) : (
                <Link to={withScope(`/earnings/${encodeURIComponent(summary.symbol)}`)} className="hover:underline">
                  {summary.name} · {summary.period}
                </Link>
              )}
            </h2>
            <p className="muted text-xs">
              {summary.symbol} · Released <time dateTime={summary.reportDate}>{formatDate(summary.reportDate)}</time> · {summary.reportingCurrency}
            </p>
          </div>
        </div>
        <a href={summary.filingUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs">
          Source: SEC filing<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </header>
      <div className="mt-4">
        <Scorecard summary={summary} labelledBy={headingId} />
        <GrowthList summary={summary} />
      </div>
      {variant === 'full' && <Details summary={summary} />}
      <p className="muted mt-4 text-xs">
        {EARNINGS_DISCLAIMER}
        {dropped > 0 && ` ${dropped} ${dropped === 1 ? 'value' : 'values'} the model returned could not be found in the text and ${dropped === 1 ? 'was' : 'were'} left out.`}
      </p>
    </article>
  );
}
