import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ASSET_CLASSES, type AssetClass, type ClassificationField, type ClassificationInstrument } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useResetClassification, useSaveClassification } from '../../api/classificationHooks';
import { Dialog } from '../../components/Dialog';
import { ASSET_CLASS_LABELS } from '../assets/AssetDialog';
import { DOMAIN_LABEL, fieldsToSend, initialForm, validateFields, type ClassificationForm } from './classificationForm';
import { BASE_LABELS, FIELD_LABELS, SOURCE_LABELS, valueLabel } from './labels';

const ALERT_CLASS = 'rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200';
const TEXT_LIMITS = { name: 120, sector: 60, country: 60, domain: 300 } as const;

interface FieldProps {
  field: ClassificationField;
  instrument: ClassificationInstrument;
  children: (ids: { id: string; hintId: string }) => ReactNode;
}

/** A labelled control with the automatic value of the field below it. */
function Field({ field, instrument, children }: Readonly<FieldProps>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label className="label" htmlFor={id}>
        {FIELD_LABELS[field]}
      </label>
      {children({ id, hintId })}
      <p id={hintId} className="muted mt-1 text-xs break-words">
        {BASE_LABELS[instrument.source]}: {valueLabel(field, instrument.base[field])}
      </p>
    </div>
  );
}

/** Edit the owner's classification of one symbol: name, asset class, sector and country, with the automatic values shown beside them. */
export function EditClassificationDialog({ instrument, onClose }: Readonly<{ instrument: ClassificationInstrument; onClose: () => void }>) {
  const domainId = useId();
  const save = useSaveClassification();
  const reset = useResetClassification();
  const [form, setForm] = useState<ClassificationForm>(() => initialForm(instrument));
  const [error, setError] = useState<string | null>(null);
  const pending = save.isPending || reset.isPending;
  const set = <K extends keyof ClassificationForm>(key: K, value: ClassificationForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const fields = fieldsToSend(form, instrument.base);
    const problem = validateFields(fields);
    if (problem !== null) {
      setError(problem);
      return;
    }
    try {
      await save.mutateAsync({ symbol: instrument.symbol, fields });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const onReset = async () => {
    try {
      await reset.mutateAsync(instrument.symbol);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit classification of ${instrument.symbol}`}
      description={`The automatic values come from ${SOURCE_LABELS[instrument.source]}. What you set here wins over them in every allocation view; a field you leave as it is (or empty) keeps following the automatic value.`}
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate aria-label="Classification" className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field field="name" instrument={instrument}>
            {({ id, hintId }) => (
              <input id={id} className="input" value={form.name} maxLength={TEXT_LIMITS.name} aria-describedby={hintId} data-autofocus onChange={(e) => set('name', e.target.value)} />
            )}
          </Field>
          <Field field="assetClass" instrument={instrument}>
            {({ id, hintId }) => (
              <select id={id} className="input" value={form.assetClass} aria-describedby={hintId} onChange={(e) => set('assetClass', e.target.value as AssetClass)}>
                {ASSET_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {ASSET_CLASS_LABELS[c]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field field="sector" instrument={instrument}>
            {({ id, hintId }) => <input id={id} className="input" value={form.sector} maxLength={TEXT_LIMITS.sector} aria-describedby={hintId} onChange={(e) => set('sector', e.target.value)} />}
          </Field>
          <Field field="country" instrument={instrument}>
            {({ id, hintId }) => <input id={id} className="input" value={form.country} maxLength={TEXT_LIMITS.country} aria-describedby={hintId} onChange={(e) => set('country', e.target.value)} />}
          </Field>
        </div>
        <div>
          <label className="label" htmlFor={domainId}>
            {DOMAIN_LABEL}
          </label>
          <input
            id={domainId}
            className="input"
            value={form.domain}
            maxLength={TEXT_LIMITS.domain}
            placeholder="apple.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={`${domainId}-hint`}
            onChange={(e) => set('domain', e.target.value)}
          />
          <p id={`${domainId}-hint`} className="muted mt-1 text-xs break-words">
            Optional. The company website the logo is looked up by, for when the logo is missing or wrong. Leave it empty to detect it automatically.
          </p>
        </div>
        {error !== null && (
          <p role="alert" className={ALERT_CLASS}>
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            {instrument.override !== null && (
              <button type="button" className="btn-secondary" disabled={pending} onClick={() => void onReset()}>
                {reset.isPending ? 'Resetting…' : 'Reset to automatic'}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={pending}>
              {save.isPending ? 'Saving…' : 'Save classification'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
