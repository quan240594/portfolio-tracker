import { SOURCE_LABELS as DATE_SOURCE_NAMES, companiesSummary, type EarningsCompanyCheck, type EarningsConflict, type EarningsDatesConclusion, type EarningsRunReport, type EarningsRunStatus, type EarningsSourceRun, type EarningsSourceStatus, type GetEarningsDatesResponse, type HeldEarningsDate } from '@portfolio/shared';
import { CompanyLogo } from '../../components/CompanyLogo';
import { formatDate, formatDateTime } from '../../lib/format';
import type { EarningsDatesResult } from './useEarningsDates';

const STATUS_LABELS: Readonly<Record<EarningsRunStatus, string>> = {
  ok: 'Read the provider’s calendar',
  'provider-limited': 'The provider answered with almost nothing (its free plan has no calendar for this key)',
  skipped: 'Skipped by the budget guard',
  'budget-exhausted': 'Skipped: the calendar’s daily call was already used',
  'rate-limited': 'Rate-limited by the provider',
  failed: 'Provider call failed',
  'no-provider': 'No Alpha Vantage key set',
  'no-symbols': 'Nothing to look up',
};

const SOURCE_STATUS_LABELS: Readonly<Record<EarningsSourceStatus, string>> = {
  ok: 'read',
  'provider-limited': 'answered with almost nothing',
  'no-key': 'not configured',
  'budget-exhausted': 'daily call already used',
  'rate-limited': 'rate-limited',
  refused: 'refused the key',
  failed: 'failed',
};
const TIME_LABELS: Readonly<Record<NonNullable<HeldEarningsDate['next']>['timeOfDay'], string>> = { BMO: 'before the open', AMC: 'after the close', DMH: 'during market hours', unknown: '' };

/** What the date is: a released report, a projection, or a provider date that is confirmed or only scheduled. */
function dateKind(next: NonNullable<HeldEarningsDate['next']>): string {
  if (next.source === 'reported') return 'Reported';
  if (next.source === 'projected') return 'Projected';
  return next.status === 'CONFIRMED' ? 'Confirmed' : 'Scheduled (provider date)';
}

const TRIGGER_LABELS = { scheduled: 'daily run', manual: 'refreshed on request' } as const;

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

function rowsText(rows: number | null): string {
  return rows === null ? 'Rows returned: not recorded' : `The provider returned ${rows} rows`;
}

function matchedText(matched: number | null, held: number): string {
  if (matched === null) return '';
  return `, ${matched} of your ${held} held ${plural(held, 'company', 'companies')} matched`;
}

function storedText(events: number | null): string {
  if (events === null) return '';
  return `; ${events} ${plural(events, 'date', 'dates')} stored`;
}

function upcomingText(withDate: number, held: number, funds: number): string {
  if (held === 0 && funds === 0) return 'No open positions to check.';
  if (held === 0) return 'No held company to check.';
  return `${withDate} of ${held} held ${plural(held, 'company has', 'companies have')} an upcoming date.`;
}

function fundsText(funds: number): string {
  if (funds === 0) return '';
  return `${funds} ${plural(funds, 'fund or crypto position has', 'fund or crypto positions have')} no earnings and ${plural(funds, 'is', 'are')} not counted.`;
}

const rowsOf = (entry: EarningsSourceRun): string => (entry.companies !== undefined || entry.rows === undefined ? '' : `, ${entry.rows} ${plural(entry.rows, 'row', 'rows')}`);

const CHECK_LABELS: Readonly<Record<Exclude<EarningsCompanyCheck['result'], 'date'>, string>> = {
  none: 'no date yet',
  pending: 'not asked in this run',
  failed: 'failed',
  'rate-limited': 'rate-limited',
  refused: 'refused the key',
};

/** What a lookup of one company came to, in a few words. */
function checkText(check: EarningsCompanyCheck): string {
  if (check.result === 'date') return `date ${formatDate(check.date ?? '')}`;
  const reason = check.reason === undefined ? '' : ` (${check.reason})`;
  return CHECK_LABELS[check.result] + reason;
}

/** The companies a source is asked about one by one: how many have a date and the outcome of each. */
function CompanyChecks({ entry }: Readonly<{ entry: EarningsSourceRun }>) {
  const summary = companiesSummary(entry);
  if (summary === null) return null;
  return (
    <details>
      <summary>{summary}</summary>
      <ul className="list-inside list-disc">
        {(entry.checks ?? []).map((check) => (
          <li key={check.symbol} className="break-words">
            {check.symbol}: {checkText(check)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SourceLines({ sources }: Readonly<{ sources: readonly EarningsSourceRun[] }>) {
  return (
    <ul className="muted list-inside list-disc">
      {sources.map((entry) => (
        <li key={entry.source} className="break-words">
          {DATE_SOURCE_NAMES[entry.source]}: {SOURCE_STATUS_LABELS[entry.status]}
          {rowsOf(entry)}
          {entry.reason !== '' && entry.status === 'ok' && `; last error: ${entry.reason}`}
          {entry.reason !== '' && entry.status !== 'ok' && ` (${entry.reason})`}
          <CompanyChecks entry={entry} />
        </li>
      ))}
    </ul>
  );
}

const sideText = (side: EarningsConflict['kept']): string => `${DATE_SOURCE_NAMES[side.source]} ${formatDate(side.date)}`;

function RunSummary({ run, held, label }: Readonly<{ run: EarningsRunReport; held: number; label: string }>) {
  const counted = run.status === 'ok' || run.status === 'provider-limited';
  return (
    <div className="space-y-0.5 text-sm">
      <p>
        <span className="font-medium">{label}:</span> {formatDateTime(run.at)} ({TRIGGER_LABELS[run.trigger]}) · {STATUS_LABELS[run.status]}
      </p>
      {run.reason !== '' && <p className="break-words">Reason: {run.reason}</p>}
      {run.sources !== undefined && <SourceLines sources={run.sources} />}
      {run.conflicts !== undefined && run.conflicts.length > 0 && (
        <p className="muted break-words">
          Sources disagreed: {run.conflicts.map((conflict) => `${conflict.symbol} (kept ${sideText(conflict.kept)}, dropped ${sideText(conflict.dropped)})`).join('; ')}.
        </p>
      )}
      {counted && (
        <p className="muted">
          {rowsText(run.rows)}
          {matchedText(run.matchedHeld, held)}
          {storedText(run.events)}.
        </p>
      )}
    </div>
  );
}

const CONCLUSION_STYLES: Readonly<Record<EarningsDatesConclusion['kind'], { label: string; classes: string }>> = {
  ok: { label: 'Dates are coming in.', classes: 'border-[#2f8f57] bg-[#dcfce7] text-[#14532d] dark:border-[#6ee7a0] dark:bg-[#1b4d33] dark:text-[#dcfce7]' },
  partial: { label: 'Dates are coming in, with a gap.', classes: 'border-[#a16207] bg-[#fef9c3] text-[#422006] dark:border-[#facc15] dark:bg-[#6b5a12] dark:text-[#fffbe0]' },
  broken: { label: 'No date source is working.', classes: 'border-[#b91c1c] bg-[#fee2e2] text-[#7f1d1d] dark:border-[#fca5a5] dark:bg-[#6b1d1d] dark:text-[#fee2e2]' },
};

/** The verdict at the top of the card: whether any source delivers dates and what to add when none does. */
function Conclusion({ conclusion }: Readonly<{ conclusion: EarningsDatesConclusion | null }>) {
  if (conclusion === null) return null;
  const style = CONCLUSION_STYLES[conclusion.kind];
  return (
    <p className={`rounded-lg border px-3 py-2 text-sm break-words ${style.classes}`} data-conclusion={conclusion.kind}>
      <span className="font-semibold">{style.label}</span> {conclusion.text}
    </p>
  );
}

function Runs({ report }: Readonly<{ report: GetEarningsDatesResponse }>) {
  const { lastRun, lastSuccess } = report;
  if (lastRun === null) return <p className="text-sm">The calendar job has not run yet. It runs daily at 05:30 Amsterdam time.</p>;
  return (
    <div className="space-y-2">
      <RunSummary run={lastRun} held={report.held} label="Last run" />
      {lastSuccess !== null && lastSuccess.at !== lastRun.at && <RunSummary run={lastSuccess} held={report.held} label="Last successful run" />}
      {lastSuccess === null && <p className="text-sm">No run has read the provider’s calendar yet.</p>}
    </div>
  );
}

function BudgetLine({ report }: Readonly<{ report: GetEarningsDatesResponse }>) {
  const { budget } = report;
  if (budget === null) return null;
  return (
    <p className="muted text-sm">
      {budget.provider} today (UTC): {budget.used} of {budget.limit} calls used; the daily refresh may use {budget.calendarLimit} ({budget.calendarUsed} used).
    </p>
  );
}

function RefreshControl({ report, earnings }: Readonly<{ report: GetEarningsDatesResponse; earnings: EarningsDatesResult }>) {
  const { refresh } = report;
  const { outcome } = earnings;
  return (
    <div className="space-y-1">
      <button type="button" className="btn-secondary" onClick={earnings.refreshNow} disabled={!refresh.available || earnings.isRefreshing}>
        {earnings.isRefreshing ? 'Queuing…' : 'Refresh earnings dates now'}
      </button>
      {!refresh.available && refresh.reason !== null && <p className="text-sm break-words">{refresh.reason}</p>}
      {outcome?.accepted === true && <output className="block text-sm">Queued. The job starts within a minute and then asks Finnhub about one held company every couple of seconds (about a minute for 20 companies); press Refresh above to see the result.</output>}
      {outcome?.accepted === false && <output className="block text-sm break-words">{outcome.message}</output>}
      {earnings.refreshError !== undefined && <p role="alert" className="text-sm">The refresh could not be queued. Try again later.</p>}
    </div>
  );
}

function NextDate({ row }: Readonly<{ row: HeldEarningsDate }>) {
  if (row.next === null) return <span className="muted">{row.reasonCode === 'not-applicable' ? 'No earnings' : 'No date'}</span>;
  const time = row.next.releaseText ?? TIME_LABELS[row.next.timeOfDay];
  const kind = dateKind(row.next);
  return (
    <>
      <span className="block font-medium tabular-nums">{formatDate(row.next.date)}</span>
      <span className="muted block text-xs break-words">{time === '' ? kind : `${kind} · ${time}`}</span>
    </>
  );
}

function SymbolRow({ row }: Readonly<{ row: HeldEarningsDate }>) {
  return (
    <tbody className="border-t border-slate-200 first:border-t-0 dark:border-slate-800">
      <tr className="align-top">
        <th scope="row" className="min-w-0 px-2 py-2 text-left font-normal md:px-3">
          <span className="flex min-w-0 items-start gap-2">
            <CompanyLogo symbol={row.symbol} name={row.name} size={28} decorative />
            <span className="min-w-0">
              <span className="block font-semibold break-words">{row.symbol}</span>
              <span className="muted block text-xs break-words">{row.name}</span>
            </span>
          </span>
        </th>
        <td className="px-2 py-2 md:px-3">
          <NextDate row={row} />
        </td>
        <td className="hidden px-3 py-2 break-words md:table-cell">{row.reason ?? <span className="muted">–</span>}</td>
      </tr>
      {row.reason !== null && (
        <tr className="md:hidden">
          <td colSpan={2} className="px-2 pb-2 text-xs break-words">
            {row.reason}
          </td>
        </tr>
      )}
    </tbody>
  );
}

/**
 * "Earnings dates": when the calendar job last ran and how it ended, how many rows the provider returned and how many matched, and for each
 * held company the next date or why there is none (funds, ETFs and crypto have no earnings and are not counted). The button queues the job once (once an hour, not while the provider allowance is nearly used).
 */
export function EarningsDatesCard({ report, earnings }: Readonly<{ report: GetEarningsDatesResponse; earnings: EarningsDatesResult }>) {
  return (
    <section id="earnings-dates" aria-labelledby="earnings-dates-title" className="card space-y-3 p-4">
      <h2 id="earnings-dates-title" className="text-base font-semibold">
        Earnings dates
      </h2>
      <Conclusion conclusion={report.conclusion} />
      <Runs report={report} />
      <BudgetLine report={report} />
      <RefreshControl report={report} earnings={earnings} />
      <p className="text-sm">
        {upcomingText(report.withDate, report.held, report.funds)} {fundsText(report.funds)}
      </p>
      {report.symbols.length > 0 && (
        <table className="w-full table-fixed text-left text-sm md:table-auto">
          <caption className="sr-only">Next earnings date per held symbol, the ones without a date first</caption>
          <thead className="muted text-xs uppercase">
            <tr>
              <th scope="col" className="px-2 py-2 font-medium md:px-3">
                Symbol
              </th>
              <th scope="col" className="w-32 px-2 py-2 font-medium md:w-auto md:px-3">
                Next date
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                Why no date
              </th>
            </tr>
          </thead>
          {report.symbols.map((row) => (
            <SymbolRow key={row.symbol} row={row} />
          ))}
        </table>
      )}
      <p className="muted text-xs">Dates come from the Alpha Vantage earnings calendar (one call a day). Read at {formatDateTime(report.asOf)}.</p>
    </section>
  );
}
