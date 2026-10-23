import { useParams, Link } from 'react-router-dom';
import type { EarningsStatusResponse } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useEarnings, useEarningsStatus, useRefreshEarnings } from '../../api/earningsHooks';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { PageHeader } from '../../components/Layout';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatDateTime } from '../../lib/format';
import { EarningsCard } from './EarningsCard';

const NOTICE = 'block rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100';

/** True when today's Workers AI allowance of the feature is used up (new summaries wait for 00:00 UTC). */
export const allowanceUsedUp = (status: EarningsStatusResponse): boolean =>
  status.neurons !== undefined && (status.neurons.state === 'blocked' || status.neurons.used >= status.neurons.dailyCap);

const MISSING_TEXT = {
  'sec-contact': 'SEC_CONTACT: the contact line every request to the SEC must declare, for example "PortfolioTracker/1.0 (personal use; you@example.com)". Pass it when you deploy.',
  'ai-binding': 'The Workers AI binding ("ai": { "binding": "AI" } in wrangler.jsonc), which reads the press release.',
} as const;

function NotConfigured({ status }: Readonly<{ status: EarningsStatusResponse }>) {
  return (
    <EmptyState
      title="Earnings summaries are not switched on yet"
      description="Two things are missing on the server. Nothing is sent to the SEC or to Workers AI until both exist."
      actions={
        <ul className="muted max-w-xl list-disc space-y-1 pl-5 text-left text-sm">
          {status.missing.map((item) => (
            <li key={item}>{MISSING_TEXT[item]}</li>
          ))}
        </ul>
      }
    />
  );
}

function Notices({ status }: Readonly<{ status: EarningsStatusResponse }>) {
  return (
    <>
      {status.secBlockedUntil && (
        <output className={NOTICE}>
          The SEC asked us to slow down, so lookups are paused until {formatDateTime(status.secBlockedUntil)}. Nothing is lost: the check resumes by itself.
        </output>
      )}
      {allowanceUsedUp(status) && status.neurons && (
        <output className={NOTICE}>
          Today&apos;s free Workers AI allowance for earnings is used up ({status.neurons.used} of {status.neurons.dailyCap} neurons). New summaries resume after 00:00 UTC ({formatDateTime(status.neurons.resetsAt)} your time).
        </output>
      )}
    </>
  );
}

function Chips({ symbols, selected }: Readonly<{ symbols: readonly string[]; selected: string | undefined }>) {
  if (symbols.length < 2 && selected === undefined) return null;
  const chip = (active: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-sm font-medium ${active ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800'}`;
  return (
    <nav aria-label="Filter by company" className="mb-4 flex flex-wrap gap-2">
      <Link to="/earnings" className={chip(selected === undefined)} aria-current={selected === undefined ? 'page' : undefined}>
        All
      </Link>
      {symbols.map((symbol) => (
        <Link key={symbol} to={`/earnings/${encodeURIComponent(symbol)}`} className={chip(selected === symbol)} aria-current={selected === symbol ? 'page' : undefined}>
          {symbol}
        </Link>
      ))}
    </nav>
  );
}

function RefreshButton({ symbol }: Readonly<{ symbol: string }>) {
  const refresh = useRefreshEarnings();
  const result = refresh.data;
  let message: string | null = null;
  if (refresh.isError) message = errorMessage(refresh.error);
  else if (result?.accepted) message = 'Checking the SEC now. A new summary appears here when the release is out.';
  else if (result?.reason === 'rate-limited') message = 'Checked less than an hour ago. Try again later.';
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn-secondary" disabled={refresh.isPending} onClick={() => refresh.mutate(symbol)}>
        {refresh.isPending ? 'Asking…' : `Check ${symbol} now`}
      </button>
      {message && (
        <output className="muted block max-w-xs text-right text-xs">
          {message}
        </output>
      )}
    </div>
  );
}

function checkedLine(entry: EarningsStatusResponse['symbols'][number]): string {
  if (!entry.lastCheckedAt) return `${entry.symbol}: not checked yet`;
  const reason = entry.lastReason ? `, ${entry.lastReason}` : '';
  return `${entry.symbol}: checked ${formatDateTime(entry.lastCheckedAt)}${reason}`;
}

function checkedText(status: EarningsStatusResponse): string[] {
  return status.symbols.filter((entry) => entry.eligible).map(checkedLine);
}

function Empty({ status, selected }: Readonly<{ status: EarningsStatusResponse; selected: string | undefined }>) {
  const lines = checkedText(status).filter((line) => selected === undefined || line.startsWith(`${selected}:`));
  return (
    <div className="space-y-3">
      <EmptyState
        title="No earnings summaries yet"
        description="When a company you hold publishes quarterly results, its summary appears here by itself. The most recent quarter of each holding is read once after the feature is switched on, a few companies at a time."
      />
      {lines.length > 0 && (
        <details className="card p-3 text-sm">
          <summary className="cursor-pointer font-medium">What was checked</summary>
          <ul className="muted mt-2 space-y-1">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A retry handler for an error state; a failed refetch shows up in the query's own error state, so nothing is left to handle here. */
const retryOf = (query: { refetch: () => Promise<unknown> }) => () => {
  query.refetch().catch(() => undefined);
};

export function EarningsView() {
  const { symbol: raw } = useParams();
  const symbol = raw === undefined ? undefined : decodeURIComponent(raw).toUpperCase();
  const statusQuery = useEarningsStatus();
  const listQuery = useEarnings({ symbol }, { enabled: statusQuery.data?.available === true && statusQuery.data.configured });
  const status = statusQuery.data;

  let body;
  if (statusQuery.isError) body = <ErrorState error={statusQuery.error} onRetry={retryOf(statusQuery)} title="Could not load earnings" />;
  else if (status === undefined) {
    body = (
      <LoadingRegion label="Loading earnings">
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  } else if (!status.available) {
    body = <EmptyState title="Earnings summaries are not available here" description="This deployment does not read quarterly results. They are part of the personal Cloudflare deployment." />;
  } else if (!status.configured) body = <NotConfigured status={status} />;
  else if (listQuery.isError) body = <ErrorState error={listQuery.error} onRetry={retryOf(listQuery)} title="Could not load earnings summaries" />;
  else if (listQuery.data === undefined) {
    body = (
      <LoadingRegion label="Loading earnings summaries">
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  } else {
    const list = listQuery.data;
    body = (
      <div className="space-y-4">
        <Notices status={status} />
        <Chips symbols={list.symbols} selected={symbol} />
        {list.summaries.length === 0 ? (
          <Empty status={status} selected={symbol} />
        ) : (
          <div className="grid gap-4">
            {list.summaries.map((summary) => (
              <EarningsCard key={`${summary.symbol}-${summary.reportDate}`} summary={summary} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title="Earnings"
        description="Quarterly results of the companies you hold, read from their own press releases. Every number was found in the release; growth and beat or miss are calculated."
        actions={symbol !== undefined && status?.available && status.configured ? <RefreshButton symbol={symbol} /> : undefined}
      />
      {body}
    </>
  );
}
