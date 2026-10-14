import { useId, useRef, useState, type FormEvent } from 'react';
import { CSV_HEADER, downloadSampleCsv } from './sampleCsv';
import { useCsvImport, type Conversion, type CsvImportOptions } from './useCsvImport';
import { defaultTargetPortfolio, portfolioName, usePortfolioScope } from '../portfolios/usePortfolioScope';

interface Props extends CsvImportOptions {
  onDone?: () => void;
}

export function CsvImport({ onDone, ...options }: Readonly<Props>) {
  const { state, start, reset } = useCsvImport(options);
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const portfolioSelectId = useId();
  const { scope, portfolios } = usePortfolioScope();
  const [chosen, setChosen] = useState(() => defaultTargetPortfolio(scope, portfolios));
  const portfolioId = portfolios && !portfolios.some((p) => p.portfolioId === chosen) ? defaultTargetPortfolio(scope, portfolios) : chosen;
  const busy = state.phase === 'uploading' || state.phase === 'processing';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (file) void start(file, portfolioId);
  };

  const startOver = () => {
    reset();
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950/60">
        <p className="font-medium">Expected header</p>
        <code className="mt-1 block overflow-x-auto font-mono text-xs whitespace-nowrap" data-testid="csv-header">
          {CSV_HEADER}
        </code>
        <p className="muted mt-2 text-xs">
          Columns are case-insensitive and may be in any order; <code>note</code> and <code>fxRate</code> are optional. Dates use
          YYYY-MM-DD, numbers use a dot as decimal separator (e.g. 186.86), types are BUY, SELL or DIVIDEND (for dividends, price is the
          gross amount per share and fee the withholding tax). Amounts are in the trade&apos;s currency. Max 1 MB / 5,000 rows. Imports are
          all-or-nothing.
        </p>
        <p className="muted mt-2 text-xs" data-testid="csv-fxrate-help">
          <code>fxRate</code>: units of the trade currency per 1 EUR, as on your broker statement (e.g. 1.0842 for USD). Leave it empty
          for EUR trades, or to use the ECB rate of the trade date.
        </p>
        <p className="muted mt-2 text-xs" data-testid="csv-trading212-help">
          Trading 212 &quot;History&quot; exports (Activity → History → Export) are recognised by their header and converted in your browser.
          Trades and dividends are imported; deposits, withdrawals and interest are skipped.
        </p>
        <button type="button" className="mt-2 text-xs font-medium text-brand-600 underline hover:text-brand-700 dark:text-brand-400" onClick={downloadSampleCsv}>
          Download sample CSV
        </button>
      </div>

      {(state.phase === 'idle' || state.phase === 'uploading' || state.phase === 'processing') && (
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label htmlFor={portfolioSelectId} className="label">
              Import into portfolio
            </label>
            <select
              id={portfolioSelectId}
              className="input"
              required
              disabled={busy}
              value={portfolioId}
              onChange={(e) => setChosen(e.target.value)}
            >
              {portfolios ? (
                portfolios.map((p) => (
                  <option key={p.portfolioId} value={p.portfolioId}>
                    {p.name}
                  </option>
                ))
              ) : (
                <option value={portfolioId}>Loading portfolios…</option>
              )}
            </select>
          </div>
          <div>
            <label htmlFor={inputId} className="label">
              CSV file
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              data-autofocus
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-brand-600/20 dark:file:text-brand-100"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={!file || busy}>
            {busy ? 'Importing…' : 'Upload & import'}
          </button>
        </form>
      )}

      <div aria-live="polite" role="status" className="empty:hidden">
        {state.phase === 'uploading' && <p className="flex items-center gap-2"><Spinner /> Uploading {state.fileName}…</p>}
        {state.phase === 'processing' && <p className="flex items-center gap-2"><Spinner /> Processing {state.fileName}… this usually takes a few seconds.</p>}
        {state.phase === 'completed' && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100">
            <p className="font-semibold">✓ Import completed</p>
            <p>
              Imported {state.result.importedCount ?? 0} of {state.result.rowCount ?? 0} rows from {state.result.fileName} into{' '}
              {portfolioName(portfolios, state.result.portfolioId ?? portfolioId)}.
            </p>
            <ConversionNotes conversion={state.conversion} />
          </div>
        )}
      </div>

      {state.phase === 'failed' && (
        <div role="alert" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
          <p className="font-semibold">✕ Import failed — nothing was imported</p>
          <p>Fix the rows below and upload the file again.</p>
          {state.conversion && <p className="text-xs">Row numbers refer to the converted Trading 212 rows (trades and dividends only, oldest first).</p>}
          {!!state.result.errors?.length && (
            <div className="max-h-56 overflow-auto rounded-md bg-white/70 dark:bg-slate-950/50">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Row errors</caption>
                <thead>
                  <tr>
                    <th scope="col" className="px-2 py-1.5">Row</th>
                    <th scope="col" className="px-2 py-1.5">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {state.result.errors.map((e, i) => (
                    <tr key={`${e.row}-${i}`} className="border-t border-red-100 dark:border-red-900/40">
                      <td className="px-2 py-1.5 align-top tabular-nums">{e.row}</td>
                      <td className="px-2 py-1.5">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {state.phase === 'error' && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
          {state.message}
        </div>
      )}

      {(state.phase === 'completed' || state.phase === 'failed' || state.phase === 'error') && (
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={startOver}>
            Import another file
          </button>
          {state.phase === 'completed' && onDone && (
            <button type="button" className="btn-primary" onClick={onDone}>
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** What the Trading 212 converter left out, so a short import is never a surprise. */
function ConversionNotes({ conversion }: Readonly<{ conversion: Conversion }>) {
  if (!conversion) return null;
  const ignored = conversion.ignored.reduce((sum, i) => sum + i.count, 0);
  return (
    <div className="mt-2 space-y-1 text-xs" data-testid="trading212-conversion">
      <p>Trading 212 export recognised: {conversion.imported} trade/dividend rows converted.</p>
      {ignored > 0 && <p>Skipped {ignored} other rows ({conversion.ignored.map((i) => `${i.action} ×${i.count}`).join(', ')}).</p>}
      {conversion.unmapped.length > 0 && (
        <p>
          Not imported, market could not be determined: {conversion.unmapped.map((u) => `${u.ticker} ×${u.count}`).join(', ')}. Use the Trading 212 sync to import
          these.
        </p>
      )}
      {conversion.invalid.length > 0 && <p>{conversion.invalid.length} rows were invalid and skipped.</p>}
      {conversion.warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
    </div>
  );
}

function Spinner() {
  return <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />;
}
