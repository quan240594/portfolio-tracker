import type { EarningsRunReport, EarningsRunStatus, GetEarningsDatesResponse, HeldEarningsDate } from '@portfolio/shared';
import { CompanyLogo } from '../../components/CompanyLogo';
import { formatDate, formatDateTime } from '../../lib/format';
import type { EarningsDatesResult } from './useEarningsDates';

const STATUS_LABELS: Readonly<Record<EarningsRunStatus, string>> = {
  ok: 'Read the provider’s calendar',
  skipped: 'Skipped by the budget guard',
  'budget-exhausted': 'Skipped: the calendar’s daily call was already used',
  'rate-limited': 'Rate-limited by the provider',
  failed: 'Provider call failed',
  'no-provider': 'No Alpha Vantage key set',
  'no-symbols': 'Nothing to look up',
};

const SOURCE_LABELS: Readonly<Record<NonNullable<HeldEarningsDate['next']>['source'], string>> = { scheduled: 'Scheduled', projected: 'Projected', reported: 'Reported' };
const TIME_LABELS: Readonly<Record<NonNullable<HeldEarningsDate['next']>['timeOfDay'], string>> = { BMO: 'before the open', AMC: 'after the close', unknown: '' };

const TRIGGER_LABELS = { scheduled: 'daily run', manual: 'refreshed on request' } as const;

function RunSummary({ run, held, label }: Readonly<{ run: EarningsRunReport; held: number; label: string }>) {
  const counted = run.status === 'ok';
  return (
    <div className="space-y-0.5 text-sm">
      <p>
        <span className="font-medium">{label}:</span> {formatDateTime(run.at)} ({TRIGGER_LABELS[run.trigger]}) · {STATUS_LABELS[run.status]}
      </p>
      {run.reason !== '' && <p className="break-words">Reason: {run.reason}</p>}
      {counted && (
        <p className="muted">
          {run.rows === null ? 'Rows returned: not recorded' : `The provider returned ${run.rows} rows`}
          {run.matchedHeld === null ? '' : `, ${run.matchedHeld} of your ${held} held ${held === 1 ? 'symbol' : 'symbols'} matched`}
          {run.events === null ? '' : `; ${run.events} ${run.events === 1 ? 'date' : 'dates'} stored`}.
        </p>
      )}
    </div>
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
      {outcome?.accepted === true && <output className="block text-sm">Queued. The job runs within a minute; press Refresh above to see the result.</output>}
      {outcome?.accepted === false && <output className="block text-sm break-words">{outcome.message}</output>}
      {earnings.refreshError !== undefined && <p role="alert" className="text-sm">The refresh could not be queued. Try again later.</p>}
    </div>
  );
}

function NextDate({ row }: Readonly<{ row: HeldEarningsDate }>) {
  if (row.next === null) return <span className="muted">No date</span>;
  const time = TIME_LABELS[row.next.timeOfDay];
  return (
    <>
      <span className="block font-medium tabular-nums">{formatDate(row.next.date)}</span>
      <span className="muted block text-xs">{time === '' ? SOURCE_LABELS[row.next.source] : `${SOURCE_LABELS[row.next.source]}, ${time}`}</span>
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
 * held symbol the next date or why there is none. The button queues the job once (once an hour, not while the provider allowance is nearly used).
 */
export function EarningsDatesCard({ report, earnings }: Readonly<{ report: GetEarningsDatesResponse; earnings: EarningsDatesResult }>) {
  return (
    <section id="earnings-dates" aria-labelledby="earnings-dates-title" className="card space-y-3 p-4">
      <h2 id="earnings-dates-title" className="text-base font-semibold">
        Earnings dates
      </h2>
      <Runs report={report} />
      <BudgetLine report={report} />
      <RefreshControl report={report} earnings={earnings} />
      <p className="text-sm">
        {report.held === 0 ? 'No open positions to check.' : `${report.withDate} of ${report.held} held ${report.held === 1 ? 'symbol has' : 'symbols have'} an upcoming date.`}
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
