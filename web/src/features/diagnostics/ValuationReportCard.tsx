import type { FxCoverageRow, GetValuationReportResponse, ValuationDay, ValuationFlag, ValuationLine } from '@portfolio/shared';
import { useState } from 'react';
import { formatCount, formatDate, formatFxRate, formatMoney } from '../../lib/format';
import { useValuationReport } from './useValuationReport';

/** Lines shown before "Show all": the biggest gaps are first. */
const FIRST_LINES = 12;

const SOURCE_LABELS: Readonly<Record<ValuationLine['source'], string>> = { close: 'close', carried: 'carried close', quote: 'live quote', cost: 'cost fallback' };

function flagLabel(flag: ValuationFlag, line: ValuationLine): string {
  switch (flag) {
    case 'carried':
      return `carried ${line.ageDays ?? 0} d`;
    case 'stale':
      return 'old close';
    case 'cost':
      return 'at cost';
    case 'currency':
      return `close in ${line.priceCurrency}`;
    case 'scale':
      return 'rescaled';
    case 'fx':
      return line.fxFallback === 'latest' ? 'latest FX' : 'other-day FX';
  }
}

const signed = (value: number, currency: string): string => formatMoney(value, currency, { signed: true });

function fxText(line: ValuationLine): string {
  const when = line.fxDate === null ? 'latest' : formatDate(line.fxDate);
  return line.priceCurrency === 'EUR' ? '' : ` · FX ${formatFxRate(line.fxRate)} (${when})`;
}

/** The facts behind one value, as plain text: units x price, where the price is from, the FX rate and the live value. */
function detailOf(line: ValuationLine, currency: string): string {
  const price = line.price === 0 ? '0' : formatCount(line.price, 4);
  const day = line.priceDate === null ? '' : ` of ${formatDate(line.priceDate)}`;
  const today = line.today === null ? ' · not held today' : ` · today ${formatMoney(line.today, currency)}`;
  return `${formatCount(line.units, 6)} × ${price} ${line.priceCurrency} (${SOURCE_LABELS[line.source]}${day})${fxText(line)}${today}`;
}

function LineRow({ line, currency }: Readonly<{ line: ValuationLine; currency: string }>) {
  return (
    <tbody className="border-t border-slate-200 first:border-t-0 dark:border-slate-800">
      <tr className="align-top">
        <th scope="row" className="min-w-0 px-2 pt-2 text-left font-semibold break-words">
          {line.symbol}
        </th>
        <td className="px-2 pt-2 text-right whitespace-nowrap tabular-nums">{formatMoney(line.value, currency)}</td>
        <td className="px-2 pt-2 text-right whitespace-nowrap tabular-nums">{signed(line.gap, currency)}</td>
      </tr>
      <tr>
        <td colSpan={3} className="px-2 pb-2 text-xs">
          <span className="muted block break-words">{detailOf(line, currency)}</span>
          {line.flags.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {line.flags.map((flag) => (
                <span key={flag} className="inline-block rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  {flagLabel(flag, line)}
                </span>
              ))}
            </span>
          )}
        </td>
      </tr>
    </tbody>
  );
}

function Totals({ day, report }: Readonly<{ day: ValuationDay; report: GetValuationReportResponse }>) {
  const { baseCurrency: currency } = report;
  const isLast = day === report.days.at(-1);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="muted">Chart value</dt>
      <dd className="text-right font-semibold tabular-nums">{formatMoney(day.chartValue, currency)}</dd>
      <dt className="muted">Sum of the lines</dt>
      <dd className="text-right tabular-nums">{formatMoney(day.positionsValue, currency)}</dd>
      {day.extraValue !== 0 && (
        <>
          <dt className="muted">Cash and custom assets</dt>
          <dd className="text-right tabular-nums">{formatMoney(day.extraValue, currency)}</dd>
        </>
      )}
      <dt className="muted">Fair value of the lines</dt>
      <dd className="text-right tabular-nums">{formatMoney(day.fairValue, currency)}</dd>
      <dt className="muted">Chart minus fair</dt>
      <dd className="text-right tabular-nums">{signed(day.gap, currency)}</dd>
      <dt className="muted">Invested</dt>
      <dd className="text-right tabular-nums">{formatMoney(day.invested, currency)}</dd>
      {isLast && report.headline !== null && (
        <>
          <dt className="muted">Headline total today</dt>
          <dd className="text-right tabular-nums">{formatMoney(report.headline, currency)}</dd>
        </>
      )}
    </dl>
  );
}

function FxSummary({ rows }: Readonly<{ rows: readonly FxCoverageRow[] }>) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1 text-sm">
      <h4 className="font-medium">FX history</h4>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.currency} className="break-words">
            {row.currency}:{' '}
            {row.first === null || row.last === null ? 'no stored fixings, the latest rate is used for every day' : `${row.fixings} fixings, ${formatDate(row.first)} to ${formatDate(row.last)}`}
            {`; ${row.fallbackDays} ${row.fallbackDays === 1 ? 'day uses' : 'days use'} another day's rate`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Lines({ day, currency }: Readonly<{ day: ValuationDay; currency: string }>) {
  const [all, setAll] = useState(false);
  const shown = all ? day.lines : day.lines.slice(0, FIRST_LINES);
  return (
    <>
      <table className="w-full table-fixed text-left text-sm">
        <caption className="sr-only">Value per held symbol on {formatDate(day.date)}, the largest gap first</caption>
        <thead className="muted text-xs uppercase">
          <tr>
            <th scope="col" className="px-2 py-2 font-medium">
              Symbol
            </th>
            <th scope="col" className="w-28 px-2 py-2 text-right font-medium">
              Value
            </th>
            <th scope="col" className="w-28 px-2 py-2 text-right font-medium">
              Gap
            </th>
          </tr>
        </thead>
        {shown.map((line) => (
          <LineRow key={line.symbol} line={line} currency={currency} />
        ))}
      </table>
      {day.lines.length > FIRST_LINES && (
        <button type="button" className="btn-secondary" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${day.lines.length}`}
        </button>
      )}
    </>
  );
}

interface PickerProps {
  days: readonly string[];
  selected: string;
  custom: boolean;
  onSelect: (date: string) => void;
  onOther: (date: string) => void;
  onReset: () => void;
}

function DayPicker({ days, selected, custom, onSelect, onOther, onReset }: Readonly<PickerProps>) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">Day</legend>
        {days.map((date) => (
          <button key={date} type="button" className={date === selected ? 'btn-primary' : 'btn-secondary'} aria-pressed={date === selected} onClick={() => onSelect(date)}>
            {formatDate(date)}
          </button>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <span>Other day</span>
        <input
          type="date"
          className="input"
          onChange={(event) => {
            if (event.target.value !== '') onOther(event.target.value);
          }}
        />
      </label>
      {custom && (
        <button type="button" className="btn-secondary" onClick={onReset}>
          Last days
        </button>
      )}
    </div>
  );
}

function Report({ report, custom, onOther, onReset }: Readonly<{ report: GetValuationReportResponse; custom: boolean; onOther: (date: string) => void; onReset: () => void }>) {
  const [selected, setSelected] = useState<string | null>(null);
  const day = report.days.find((candidate) => candidate.date === selected) ?? report.days.at(-1);
  if (day === undefined) return <p className="text-sm">There is nothing to reconcile: no holdings on those days.</p>;
  return (
    <div className="space-y-3">
      <DayPicker days={report.days.map((d) => d.date)} selected={day.date} custom={custom} onSelect={setSelected} onOther={onOther} onReset={onReset} />
      <Totals day={day} report={report} />
      <Lines key={day.date} day={day} currency={report.baseCurrency} />
      <FxSummary rows={report.fx} />
      {report.truncated && <p className="text-sm">{`${report.symbolsTotal} symbols are held: only the first 60 are listed, the totals leave the others out.`}</p>}
      <p className="muted text-xs">
        Gap = what the chart counts for a symbol minus its fair value (the close as stored × units × that day&apos;s FX; the live quote or the cost when there is no close). Read for this
        report: {report.rowsRead} stored rows.
      </p>
    </div>
  );
}

/**
 * "Chart reconciliation": how the value line of the dashboard chart is made up on a day, symbol by symbol, with the biggest
 * distortions first. Loaded on request (it reads a year of closes); small enough to screenshot on a phone.
 */
export function ValuationReportCard() {
  const [open, setOpen] = useState(false);
  const [dates, setDates] = useState<readonly string[] | undefined>(undefined);
  const { report, notExposed, isLoading, error } = useValuationReport(dates, open);
  let body: React.ReactNode = null;
  if (open && report) body = <Report report={report} custom={dates !== undefined} onOther={(date) => setDates([date])} onReset={() => setDates(undefined)} />;
  else if (open && isLoading) body = <p className="muted text-sm">Reading the stored prices…</p>;
  else if (open && notExposed) body = <p className="text-sm">This deployment has no chart reconciliation.</p>;
  else if (open && error !== undefined) body = <p className="text-sm">The reconciliation could not be read. Try again later.</p>;
  return (
    <section aria-labelledby="valuation-title" className="card space-y-3 p-4">
      <h2 id="valuation-title" className="text-base font-semibold">
        Chart reconciliation
      </h2>
      <p className="muted text-sm">Shows, for a day of the value chart, what each held symbol is counted at and where that differs from its fair value.</p>
      {!open && (
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
          Show reconciliation
        </button>
      )}
      {body}
    </section>
  );
}
