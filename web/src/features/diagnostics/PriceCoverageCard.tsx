import type { HeldSymbolCoverage, HistoryState, PriceHistoryCoverage } from '@portfolio/shared';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { CompanyLogo } from '../../components/CompanyLogo';
import { formatDate, formatDateTime } from '../../lib/format';

/** The id the chart note links to (`/settings/diagnostics#price-coverage`). */
export const PRICE_COVERAGE_ANCHOR = 'price-coverage';

const STATE_LABELS: Readonly<Record<HistoryState, string>> = { complete: 'Complete', partial: 'Partial', missing: 'Missing' };

// A chip carries its state as text; the colour only adds to it.
const STATE_TONES: Readonly<Record<HistoryState, string>> = {
  complete: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  partial: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  missing: 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
};

function StateChip({ state }: Readonly<{ state: HistoryState }>) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATE_TONES[state]}`}>{STATE_LABELS[state]}</span>;
}

const dateOrDash = (day: string | null): string => (day === null ? '–' : formatDate(day));
const rowsLabel = (row: HeldSymbolCoverage): string => (row.eodRowsCapped ? `${row.eodRows}+` : String(row.eodRows));

function attemptText(row: HeldSymbolCoverage): string | null {
  const { lastAttempt } = row;
  if (lastAttempt === null) return null;
  const tries = lastAttempt.attempts === 1 ? '1 try' : `${lastAttempt.attempts} tries`;
  const text = `Last attempt ${formatDate(lastAttempt.day)}: ${tries}, ${lastAttempt.outcome === 'skipped' ? 'skipped' : 'will retry'}`;
  return lastAttempt.error === '' ? text : `${text} (${lastAttempt.error})`;
}

function quoteText(row: HeldSymbolCoverage): string {
  if (row.lastQuoteAt === null) return 'No quote stored';
  return row.lastQuoteSource ? `Last quote ${formatDateTime(row.lastQuoteAt)} (${row.lastQuoteSource})` : `Last quote ${formatDateTime(row.lastQuoteAt)}`;
}

/** Why the history is what it is: the reason, the last attempt of the history job and the last quote. */
function Why({ row }: Readonly<{ row: HeldSymbolCoverage }>) {
  const attempt = attemptText(row);
  return (
    <>
      <span className="block">{row.reason}</span>
      {attempt !== null && <span className="muted block text-xs break-words">{attempt}</span>}
      <span className="muted block text-xs break-words">{quoteText(row)}</span>
    </>
  );
}

function SymbolRow({ row }: Readonly<{ row: HeldSymbolCoverage }>) {
  return (
    <tbody className="border-t border-slate-200 first:border-t-0 dark:border-slate-800">
      <tr className="align-top">
        <th scope="row" className="min-w-0 px-2 pt-2 text-left font-normal md:px-3 md:py-2">
          <span className="flex min-w-0 items-start gap-2">
            <CompanyLogo symbol={row.symbol} name={row.name} size={28} decorative />
            <span className="min-w-0">
              <span className="block font-semibold break-words">{row.symbol}</span>
              <span className="muted block text-xs break-words">{row.name}</span>
            </span>
          </span>
        </th>
        <td className="px-2 pt-2 whitespace-nowrap md:px-3 md:py-2">
          <StateChip state={row.historyState} />
        </td>
        <td className="px-2 pt-2 text-right tabular-nums md:px-3 md:py-2">{rowsLabel(row)}</td>
        <td className="hidden px-3 py-2 whitespace-nowrap tabular-nums md:table-cell">{dateOrDash(row.firstEod)}</td>
        <td className="hidden px-3 py-2 whitespace-nowrap tabular-nums md:table-cell">{dateOrDash(row.lastEod)}</td>
        <td className="hidden px-3 py-2 break-words md:table-cell">
          <Why row={row} />
        </td>
      </tr>
      <tr className="md:hidden">
        <td colSpan={3} className="px-2 pt-1 pb-2 text-xs">
          <span className="muted block">{row.firstEod === null ? 'No prices stored' : `${dateOrDash(row.firstEod)} to ${dateOrDash(row.lastEod)}`}</span>
          <Why row={row} />
        </td>
      </tr>
    </tbody>
  );
}

function Counts({ coverage }: Readonly<{ coverage: PriceHistoryCoverage }>) {
  const { totals } = coverage;
  const shown = coverage.symbols.length;
  return (
    <>
      <p className="text-sm">
        {totals.held} held {totals.held === 1 ? 'symbol' : 'symbols'}: {totals.complete} complete, {totals.partial} partial, {totals.missing} missing.
        {totals.truncated && ` The first ${shown} are listed.`}
      </p>
      {totals.valuedAtCostSince !== null && totals.valuedAtCostUntil !== null ? (
        <p className="text-sm">
          The value chart values the symbols without prices at their cost from {formatDate(totals.valuedAtCostSince)} until {formatDate(totals.valuedAtCostUntil)}; today&apos;s total always uses the latest quote.
        </p>
      ) : (
        <p className="text-sm">Every held symbol has prices for the whole chart.</p>
      )}
    </>
  );
}

/** Scrolls to the card (once it is shown) when the page was opened with `#price-coverage`: the router does not scroll to a hash by itself. */
function useScrollToCard(): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === `#${PRICE_COVERAGE_ANCHOR}`) document.getElementById(PRICE_COVERAGE_ANCHOR)?.scrollIntoView?.();
  }, [hash]);
}

/**
 * "Price data coverage": for each held symbol how much end-of-day history is stored, what the history job did last and why a gap is
 * there. Shown on the Diagnostics page; the note under the dashboard chart links here.
 */
export function PriceCoverageCard({ coverage }: Readonly<{ coverage: PriceHistoryCoverage }>) {
  useScrollToCard();
  return (
    <section id={PRICE_COVERAGE_ANCHOR} aria-labelledby="price-coverage-title" className="card space-y-3 p-4">
      <h2 id="price-coverage-title" className="text-base font-semibold">
        Price data coverage
      </h2>
      <Counts coverage={coverage} />
      {coverage.symbols.length === 0 ? (
        <p className="muted text-sm">No open positions to check.</p>
      ) : (
        <table className="w-full table-fixed text-left text-sm md:table-auto">
          <caption className="sr-only">Stored price history per held symbol, worst first</caption>
          <thead className="muted text-xs uppercase">
            <tr>
              <th scope="col" className="px-2 py-2 font-medium md:px-3">
                Symbol
              </th>
              <th scope="col" className="w-[5.5rem] px-2 py-2 font-medium md:w-auto md:px-3">
                State
              </th>
              <th scope="col" className="w-12 px-2 py-2 text-right font-medium md:w-auto md:px-3">
                Rows
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                First
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                Last
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                Reason
              </th>
            </tr>
          </thead>
          {coverage.symbols.map((row) => (
            <SymbolRow key={row.symbol} row={row} />
          ))}
        </table>
      )}
      <p className="muted text-xs">
        Complete = prices from the first purchase (at most a year back) up to within 4 days of today. A symbol with no price on a day is valued at its cost that day. Read for this
        report: {coverage.rowsRead} stored rows, at {formatDateTime(coverage.asOf)}.
      </p>
    </section>
  );
}
