import { useId, type ChangeEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { countReport, ImportReport } from './ImportReport';
import { useClassificationImport, type LoadedImport } from './useClassificationImport';

const ALERT_CLASS = 'rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200';

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function Preview({ loaded, error }: Readonly<{ loaded: LoadedImport; error?: string }>) {
  const counts = countReport(loaded.response);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">Preview of {loaded.fileName}.</span> Nothing is saved until you confirm.{' '}
        {counts.withChanges === 0 ? 'No matched row changes anything.' : `${counts.withChanges} ${plural(counts.withChanges, 'holding changes', 'holdings change')}.`}
      </p>
      <ImportReport response={loaded.response} issues={loaded.issues} caption="Import preview" />
      {error !== undefined && (
        <p role="alert" className={ALERT_CLASS}>
          {error}
        </p>
      )}
    </div>
  );
}

function Done({ loaded }: Readonly<{ loaded: LoadedImport }>) {
  const { applied, unmatched } = loaded.response;
  return (
    <div className="space-y-3">
      <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100">
        <span className="font-semibold">✓ Saved {applied} {plural(applied, 'classification', 'classifications')}.</span> Your allocation views use them now.
        {unmatched.length > 0 && ` ${unmatched.length} ${plural(unmatched.length, 'row was', 'rows were')} not matched and left out, see below.`}
      </p>
      <ImportReport response={loaded.response} issues={loaded.issues} caption="Import result" />
    </div>
  );
}

/** Import of a Snowball "Holdings" export: choose a file, review what would change, confirm. */
export function ClassificationImportDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { stage, pick, confirm } = useClassificationImport();
  const inputId = useId();
  const busy = stage.kind === 'saving';

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void pick(file);
  };

  const preview = stage.kind === 'preview' ? stage.loaded : null;
  const canConfirm = preview !== null && countReport(preview.response).withChanges > 0;
  const footer = (
    <>
      <button type="button" className="btn-secondary" onClick={onClose}>
        {stage.kind === 'done' ? 'Close' : 'Cancel'}
      </button>
      {stage.kind !== 'done' && (
        <button type="button" className="btn-primary" disabled={!canConfirm} onClick={() => void confirm(preview!)}>
          {stage.kind === 'saving' ? 'Saving…' : 'Confirm import'}
        </button>
      )}
    </>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Import asset classification"
      description="Choose the Holdings export of Snowball (CSV). The file is read in your browser; only name, asset class, sector and country of the holdings you own are sent, and they replace what the market-data providers say."
      footer={footer}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor={inputId} className="label">
            Snowball Holdings CSV
          </label>
          <input
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            data-autofocus
            onChange={onChange}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-brand-600/20 dark:file:text-brand-100"
          />
        </div>
        {stage.kind === 'reading' && <p role="status" className="muted text-sm">Reading {stage.fileName}…</p>}
        {stage.kind === 'error' && (
          <p role="alert" className={ALERT_CLASS}>
            {stage.message}
          </p>
        )}
        {(stage.kind === 'preview' || stage.kind === 'saving') && <Preview loaded={stage.loaded} error={stage.kind === 'preview' ? stage.error : undefined} />}
        {stage.kind === 'done' && <Done loaded={stage.loaded} />}
      </div>
    </Dialog>
  );
}
