import { useState, type FormEvent } from 'react';
import { errorMessage } from '../../api/client';
import { managementApi } from '../../api/management-client';
import { usePortfolioSettings, useUpdateSettings } from '../../api/management-hooks';
import { Dialog } from '../../components/Dialog';
import { downloadFile, numberToInput, parseNumber } from './form';

interface Props {
  portfolioId: string;
  portfolioName: string;
  onClose: () => void;
}

function SettingsForm({ portfolioId, initial, onClose }: Readonly<{ portfolioId: string; initial: { trackCash: boolean; withholdingTaxRate?: number }; onClose: () => void }>) {
  const save = useUpdateSettings(portfolioId);
  const [trackCash, setTrackCash] = useState(initial.trackCash);
  const [rate, setRate] = useState(numberToInput(initial.withholdingTaxRate));
  const [error, setError] = useState<string | null>(null);

  const message = error ?? (save.isError ? errorMessage(save.error) : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const withholdingTaxRate = rate.trim() === '' ? null : parseNumber(rate);
    if (withholdingTaxRate === undefined || (withholdingTaxRate !== null && (withholdingTaxRate < 0 || withholdingTaxRate > 100))) {
      return setError('Withholding tax must be a percentage between 0 and 100');
    }
    setError(null);
    save.mutate({ trackCash, withholdingTaxRate }, { onSuccess: onClose });
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Portfolio settings" className="space-y-4">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={trackCash} onChange={(e) => setTrackCash(e.target.checked)} />
        <span>
          <span className="font-medium">Track cash</span>
          <span className="muted block text-xs">
            Deposits, withdrawals, fees and interest build a cash balance; buys, sells and dividends move it. Cash counts in the totals. Off = cash entries are ignored.
          </span>
        </span>
      </label>
      <div>
        <label className="label" htmlFor="ps-rate">Default dividend withholding tax (%)</label>
        <input id="ps-rate" className="input" inputMode="decimal" placeholder="e.g. 15" value={rate} onChange={(e) => setRate(e.target.value)} />
        <p className="muted mt-1 text-xs">Prefills the withholding tax when you add a dividend. Leave empty to enter it by hand.</p>
      </div>
      {message && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>
  );
}

/** Per-portfolio settings (cash tracking, default withholding tax) and the full JSON backup download. */
export function PortfolioSettingsDialog({ portfolioId, portfolioName, onClose }: Readonly<Props>) {
  const { data, isPending, isError, error } = usePortfolioSettings(portfolioId);
  const [backupError, setBackupError] = useState<string | null>(null);

  const backup = async () => {
    try {
      downloadFile('portfolio-backup.json', JSON.stringify(await managementApi.exportBackup(), null, 2), 'application/json');
      setBackupError(null);
    } catch (err) {
      setBackupError(errorMessage(err));
    }
  };

  let body;
  if (isError) body = <p role="alert" className="text-sm text-red-700 dark:text-red-300">{errorMessage(error)}</p>;
  else if (isPending) body = <p role="status" className="muted text-sm">Loading settings…</p>;
  else body = <SettingsForm portfolioId={portfolioId} initial={data} onClose={onClose} />;

  return (
    <Dialog open onClose={onClose} title={`Settings · ${portfolioName}`} size="md">
      {body}
      <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-semibold">Backup</h3>
        <p className="muted mb-2 text-xs">All your portfolios, transactions, categories, custom assets and watchlist as one JSON file.</p>
        <button type="button" className="btn-secondary" onClick={() => void backup()}>Download backup (JSON)</button>
        {backupError && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{backupError}</p>}
      </div>
    </Dialog>
  );
}
