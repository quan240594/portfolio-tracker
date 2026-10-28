import type { AlarmArmReport, AlarmDiagnosticsReport, AlarmRunReport } from '@portfolio/shared';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { PageHeader } from '../../components/Layout';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { CardGrid } from '../layout/CardGrid';
import { EarningsDatesCard } from './EarningsDatesCard';
import { PriceCoverageCard } from './PriceCoverageCard';
import { ValuationReportCard } from './ValuationReportCard';
import { useEarningsDates, type EarningsDatesResult } from './useEarningsDates';
import { usePriceCoverage, type PriceCoverageResult } from './usePriceCoverage';
import { jobLine, formatDuration, formatInstant, retryLabel, RUN_STATUS_LABELS, statusOf, type RunStatus } from './runFormat';
import { useAlarmDiagnostics } from './useAlarmDiagnostics';

const STATUS_TONE: Readonly<Record<RunStatus, string>> = {
  completed: 'text-emerald-700 dark:text-emerald-300',
  deferred: 'text-sky-700 dark:text-sky-300',
  failed: 'text-red-700 dark:text-red-300',
  'no-finish': 'font-semibold text-amber-800 dark:text-amber-300',
  running: 'text-slate-600 dark:text-slate-300',
};

function Instant({ ms }: Readonly<{ ms: number }>) {
  const iso = new Date(ms).toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {formatInstant(ms)}
    </time>
  );
}

function Stat({ label, value, attention = false }: Readonly<{ label: string; value: number; attention?: boolean }>) {
  const tone = attention && value > 0 ? 'text-amber-800 dark:text-amber-300' : '';
  return (
    <div>
      <dt className="muted text-xs">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

function Summary({ report }: Readonly<{ report: AlarmDiagnosticsReport }>) {
  const { summary, armed } = report;
  return (
    <section aria-labelledby="diag-summary" className="card space-y-3 p-4">
      <h2 id="diag-summary" className="text-base font-semibold">
        Last 24 hours
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Runs" value={summary.runs} />
        <Stat label="Completed" value={summary.completed} />
        <Stat label="Deferred" value={summary.deferred} />
        <Stat label="Failed" value={summary.failed} attention />
        <Stat label="No finish" value={summary.unfinished} attention />
        <Stat label="Retries" value={summary.retries} attention />
      </dl>
      {summary.unfinished > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          A run that started and never finished was cut short by the platform (cancelled or disconnected before it could record its end).
        </p>
      )}
      <p className="text-sm">
        <span className="muted">Alarm armed for: </span>
        {armed.alarmAt === null ? 'nothing (or an alarm is running right now)' : <Instant ms={armed.alarmAt} />}
        <span className="muted">. Jobs due or waiting: </span>
        {armed.dueJobs.length}
      </p>
    </section>
  );
}

function RunRow({ run }: Readonly<{ run: AlarmRunReport }>) {
  const status = statusOf(run);
  return (
    <tr className="align-top">
      <td className="px-3 py-2 whitespace-nowrap">
        <Instant ms={run.startedAt} />
        <span className="muted block text-xs">{run.trigger}</span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{run.durationMs === null ? '–' : formatDuration(run.durationMs)}</td>
      <td className={`px-3 py-2 whitespace-nowrap ${STATUS_TONE[status]}`}>{RUN_STATUS_LABELS[status]}</td>
      <td className="px-3 py-2 whitespace-nowrap">{retryLabel(run)}</td>
      <td className="px-3 py-2">
        {run.jobs.length === 0 ? (
          '–'
        ) : (
          <ul className="space-y-0.5">
            {run.jobs.map((job) => (
              <li key={job.job}>{jobLine(job)}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2 break-words">{run.error ? `${run.error.name}: ${run.error.message}` : '–'}</td>
    </tr>
  );
}

function Runs({ runs }: Readonly<{ runs: readonly AlarmRunReport[] }>) {
  if (runs.length === 0) return <EmptyState title="No alarm run recorded yet" description="The first one appears when the next scheduled job or queued job runs." />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="px-3 py-2 text-left text-base font-semibold">Last {runs.length} alarm runs, newest first</caption>
        <thead className="muted text-xs uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Started
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Duration
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Retry
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Jobs
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Error
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MAX_ARMS_SHOWN = 10;

function Arms({ arms }: Readonly<{ arms: readonly AlarmArmReport[] }>) {
  if (arms.length === 0) return null;
  return (
    <section aria-labelledby="diag-arms" className="card space-y-2 p-4">
      <h2 id="diag-arms" className="text-base font-semibold">
        Alarm changes outside a normal run
      </h2>
      <ul className="space-y-1 text-sm">
        {arms.slice(0, MAX_ARMS_SHOWN).map((arm) => (
          <li key={arm.id}>
            <Instant ms={arm.at} /> <span className="muted">{arm.reason}</span> → <Instant ms={arm.alarmAt} />
            {arm.runId !== null && <span className="muted"> (during run {arm.runId})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The coverage card; nothing where the backend has no such report, a short message when it could not be read. */
function CoverageSlot({ prices }: Readonly<{ prices: PriceCoverageResult }>) {
  if (prices.coverage) return <PriceCoverageCard coverage={prices.coverage} />;
  if (prices.availability !== 'error') return null;
  return (
    <section id="price-coverage" aria-labelledby="price-coverage-error" className="card space-y-2 p-4">
      <h2 id="price-coverage-error" className="text-base font-semibold">
        Price data coverage
      </h2>
      <p className="text-sm">The coverage of the stored prices could not be read.</p>
      <button type="button" className="btn-secondary" onClick={prices.refetch}>
        Try again
      </button>
    </section>
  );
}

/** The earnings dates card; nothing where the backend has no such report, a short message when it could not be read. */
function EarningsDatesSlot({ earnings }: Readonly<{ earnings: EarningsDatesResult }>) {
  if (earnings.report) return <EarningsDatesCard report={earnings.report} earnings={earnings} />;
  if (earnings.availability !== 'error') return null;
  return (
    <section id="earnings-dates" aria-labelledby="earnings-dates-error" className="card space-y-2 p-4">
      <h2 id="earnings-dates-error" className="text-base font-semibold">
        Earnings dates
      </h2>
      <p className="text-sm">The earnings dates could not be read.</p>
      <button type="button" className="btn-secondary" onClick={earnings.refetch}>
        Try again
      </button>
    </section>
  );
}

function Loaded({ report, prices, earnings }: Readonly<{ report: AlarmDiagnosticsReport; prices: PriceCoverageResult; earnings: EarningsDatesResult }>) {
  return (
    <div className="space-y-6">
      <CardGrid
        pageId="diagnostics"
        cards={[
          { id: 'price-coverage', title: 'Price data coverage', defaultWidth: 'full', render: () => <CoverageSlot prices={prices} /> },
          { id: 'earnings-dates', title: 'Earnings dates', defaultWidth: 'full', render: () => <EarningsDatesSlot earnings={earnings} /> },
          { id: 'valuation-report', title: 'Valuation report', defaultWidth: 'full', render: () => <ValuationReportCard /> },
          { id: 'alarm-summary', title: 'Last 24 hours', defaultWidth: 'full', render: () => <Summary report={report} /> },
          { id: 'alarm-runs', title: 'Alarm runs', defaultWidth: 'full', render: () => <Runs runs={report.runs} /> },
          { id: 'alarm-arms', title: 'Alarm changes', defaultWidth: 'full', render: () => <Arms arms={report.arms} /> },
        ]}
      />
      <section aria-label="About these diagnostics" className="muted space-y-1 text-xs">
        <p>The Hub records every alarm run (start and end) in a small log of its own, the last 300 runs. Nothing here is sent anywhere.</p>
        <p>Times are in your time zone. Hover a time to see it in UTC.</p>
      </section>
    </div>
  );
}

/**
 * The Diagnostics page: what the Hub's alarm did lately, read-only. Only the personal Cloudflare deployment has the endpoint; the
 * demo and the AWS deployment show that it is not available (and the account menu does not link here).
 */
export function DiagnosticsView() {
  const diagnostics = useAlarmDiagnostics();
  const prices = usePriceCoverage();
  const earnings = useEarningsDates();
  let body: React.ReactNode;
  if (diagnostics.availability === 'not-exposed') body = <EmptyState title="Diagnostics are not available" description="This deployment does not keep an alarm log or price coverage details." />;
  else if (diagnostics.availability === 'error') body = <ErrorState error={diagnostics.error} onRetry={diagnostics.refetch} />;
  else if (diagnostics.report) body = <Loaded report={diagnostics.report} prices={prices} earnings={earnings} />;
  else {
    body = (
      <LoadingRegion label="Loading diagnostics">
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  }
  const refresh = (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => {
        diagnostics.refetch();
        prices.refetch();
        earnings.refetch();
      }}
      disabled={diagnostics.isFetching || prices.isFetching || earnings.isFetching}
    >
      {diagnostics.isFetching || prices.isFetching || earnings.isFetching ? 'Refreshing…' : 'Refresh'}
    </button>
  );
  return (
    <>
      <PageHeader title="Diagnostics" description="What the background alarm of this deployment did lately, how much price history is stored, and where the earnings dates come from." actions={diagnostics.availability === 'ready' ? refresh : undefined} />
      {body}
    </>
  );
}
