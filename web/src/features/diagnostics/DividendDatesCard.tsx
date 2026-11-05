import { DIVIDEND_SOURCE_LABELS, type DividendCheckOutcome, type DividendDateInfo, type DividendFeedReport, type GetDividendDatesResponse, type HeldDividendDate } from '@portfolio/shared';
import { CompanyLogo } from '../../components/CompanyLogo';
import { formatDate, formatDateTime } from '../../lib/format';
import type { DividendDatesResult } from './useDividendDates';

const OUTCOME_LABELS: Readonly<Record<DividendCheckOutcome, string>> = {
  ok: 'read',
  none: 'read, nothing listed',
  failed: 'failed',
  'rate-limited': 'provider limit reached',
  budget: 'skipped: the day’s allowance was spent first',
};

const FEED_LABELS: Readonly<Record<DividendFeedReport['status'], string>> = {
  'no-key': 'off (no Alpha Vantage key)',
  untested: 'not tried yet',
  available: 'works on your key',
  unavailable: 'not available on your key',
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

const sourceName = (source: string): string => {
  if (source === 'history') return 'projected from your payments';
  if (source === 'provider') return 'data provider';
  return source in DIVIDEND_SOURCE_LABELS ? DIVIDEND_SOURCE_LABELS[source as keyof typeof DIVIDEND_SOURCE_LABELS] : source;
};

const amountText = (info: DividendDateInfo): string => (info.amount === null ? 'amount not known' : `${info.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${info.currency ?? ''} per share`.trim());

/** One dividend: its dates, amount and where it comes from (a note says when you entered it yourself). */
function DividendLine({ info, label }: Readonly<{ info: DividendDateInfo | null; label: string }>) {
  if (info === null) return <span className="muted">{label}: none stored</span>;
  return (
    <>
      <span className="block font-medium tabular-nums">
        {info.exDate === null ? 'Ex-date unknown' : `Ex ${formatDate(info.exDate)}`}
        {info.payDate !== null && ` · pays ${formatDate(info.payDate)}`}
      </span>
      <span className="muted block text-xs break-words">
        {info.kind === 'declared' ? 'Declared' : 'Projected'} · {amountText(info)} · {sourceName(info.source)}
        {info.enteredByYou && ' (entered by you)'}
      </span>
    </>
  );
}

/** The latest attempt of a check, whatever its outcome: when, how it ended and who answered. */
function attemptText(check: HeldDividendDate['check']): string {
  if (check.attemptAt === null || check.outcome === null) return '';
  const who = check.source === null ? '' : ` (${DIVIDEND_SOURCE_LABELS[check.source]})`;
  return `; latest attempt ${formatDateTime(check.attemptAt)}: ${OUTCOME_LABELS[check.outcome]}${who}`;
}

function CheckLine({ row }: Readonly<{ row: HeldDividendDate }>) {
  const { check } = row;
  if (check.attemptAt === null && check.checkedAt === null) return <span className="muted block text-xs">Not checked yet</span>;
  const last = check.checkedAt === null ? 'never read successfully' : `last read ${formatDateTime(check.checkedAt)}`;
  return (
    <span className="muted block text-xs break-words">
      {last}
      {attemptText(check)}
      {check.reason !== '' && ` – ${check.reason}`}
    </span>
  );
}

function SymbolRow({ row }: Readonly<{ row: HeldDividendDate }>) {
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
          <DividendLine info={row.next} label="Next" />
          {row.last !== null && row.next?.exDate !== row.last.exDate && <span className="muted mt-1 block text-xs">Latest stored: ex {row.last.exDate === null ? '–' : formatDate(row.last.exDate)}</span>}
        </td>
        <td className="hidden px-3 py-2 md:table-cell">
          <CheckLine row={row} />
        </td>
      </tr>
      <tr>
        <td colSpan={3} className="px-2 pb-2 text-xs break-words md:px-3">
          <span className="md:hidden">
            <CheckLine row={row} />
          </span>
          {row.reason !== null && <span className="block">{row.reason}</span>}
        </td>
      </tr>
    </tbody>
  );
}

function BudgetLine({ report }: Readonly<{ report: GetDividendDatesResponse }>) {
  const { budget } = report;
  if (budget === null) return null;
  return (
    <p className="muted text-sm">
      {budget.provider} today (UTC): {budget.used} of {budget.limit} calls used; the daily rotation may use {budget.calendarLimit} ({budget.calendarUsed} used).
    </p>
  );
}

function FeedLine({ feed }: Readonly<{ feed: DividendFeedReport }>) {
  return (
    <p className="muted text-sm break-words">
      Free fallback (Alpha Vantage dividends): {FEED_LABELS[feed.status]}
      {feed.at !== null && ` (${formatDateTime(feed.at)})`}
      {feed.status === 'unavailable' && feed.reason !== '' && `: ${feed.reason}`}
      {feed.retryAt !== null && `. It is tried again after ${formatDateTime(feed.retryAt)}.`}
    </p>
  );
}

function CheckControl({ report, dividends }: Readonly<{ report: GetDividendDatesResponse; dividends: DividendDatesResult }>) {
  const { refresh } = report;
  const { outcome } = dividends;
  return (
    <div className="space-y-1">
      <button type="button" className="btn-secondary" onClick={dividends.checkNow} disabled={!refresh.available || dividends.isChecking}>
        {dividends.isChecking ? 'Queuing…' : 'Check dividends now'}
      </button>
      {!refresh.available && refresh.reason !== null && <p className="text-sm break-words">{refresh.reason}</p>}
      {outcome?.accepted === true && <output className="block text-sm">Queued. The check starts within a minute and reads up to 8 held symbols, newly bought ones and those without an upcoming dividend first; press Refresh above to see the result.</output>}
      {outcome?.accepted === false && <output className="block text-sm break-words">{outcome.message}</output>}
      {dividends.checkError !== undefined && (
        <p role="alert" className="text-sm">
          The check could not be queued. Try again later.
        </p>
      )}
    </div>
  );
}

/**
 * "Dividend dates": for every held symbol that can pay a dividend (ETFs included, crypto not) the next dividend as the calendar shows it, when its dividends
 * were last checked and how that ended, and why there is no declared upcoming date. The button reads the dividends of the held symbols once (once an
 * hour, not when the EODHD allowance of the day is spent).
 */
export function DividendDatesCard({ report, dividends }: Readonly<{ report: GetDividendDatesResponse; dividends: DividendDatesResult }>) {
  return (
    <section id="dividend-dates" aria-labelledby="dividend-dates-title" className="card space-y-3 p-4">
      <h2 id="dividend-dates-title" className="text-base font-semibold">
        Dividend dates
      </h2>
      <p className="text-sm">
        {report.held === 0 ? 'No held symbol can pay a dividend.' : `${report.withDeclared} of ${report.held} held ${plural(report.held, 'symbol has', 'symbols have')} a declared upcoming dividend.`}
      </p>
      <BudgetLine report={report} />
      <FeedLine feed={report.feed} />
      <CheckControl report={report} dividends={dividends} />
      {report.symbols.length > 0 && (
        <table className="w-full table-fixed text-left text-sm md:table-auto">
          <caption className="sr-only">Next dividend per held symbol, the ones without a declared date first</caption>
          <thead className="muted text-xs uppercase">
            <tr>
              <th scope="col" className="px-2 py-2 font-medium md:px-3">
                Symbol
              </th>
              <th scope="col" className="px-2 py-2 font-medium md:px-3">
                Next dividend
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                Last checked
              </th>
            </tr>
          </thead>
          {report.symbols.map((row) => (
            <SymbolRow key={row.symbol} row={row} />
          ))}
        </table>
      )}
      <p className="muted text-xs">Dividends come from EODHD (a few symbols a day), with the free Alpha Vantage dividends feed as a fallback and the dates you enter on the Calendar page. Read at {formatDateTime(report.asOf)}.</p>
    </section>
  );
}
