import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_GOAL_TARGETS, GOAL_TYPES, GOAL_TYPE_LABELS, type GoalSettings, type GoalType } from '@portfolio/shared';
import { ADVANCED_FIELDS, targetHint, yearOptions, type GoalField, type GoalFieldErrors, type GoalFormValues } from './goalFormModel';
import { formatPercent } from '../../lib/format';

interface FieldProps {
  field: GoalField;
  label: string;
  value: string;
  error?: string;
  hint?: string;
  placeholder?: string;
  onChange: (field: GoalField, value: string) => void;
  onBlur: (field: GoalField) => void;
}

const describedBy = (field: GoalField, error?: string, hint?: string): string | undefined => {
  if (error) return `goal-${field}-error`;
  return hint ? `goal-${field}-hint` : undefined;
};

function FieldMessage({ field, error, hint }: Readonly<{ field: GoalField; error?: string; hint?: string }>) {
  if (error) {
    return (
      <p id={`goal-${field}-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }
  return hint ? (
    <p id={`goal-${field}-hint`} className="muted mt-1 text-xs">
      {hint}
    </p>
  ) : null;
}

function NumberField({ field, label, value, error, hint, placeholder, onChange, onBlur }: Readonly<FieldProps>) {
  return (
    <div>
      <label className="label" htmlFor={`goal-${field}`}>
        {label}
      </label>
      <input
        id={`goal-${field}`}
        className="input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(field, error, hint)}
        onChange={(e) => onChange(field, e.target.value)}
        onBlur={() => onBlur(field)}
      />
      <FieldMessage field={field} error={error} hint={hint} />
    </div>
  );
}

function Toggle({ id, label, checked, onChange }: Readonly<{ id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }>) {
  return (
    <label className="flex items-center gap-2 text-sm" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function GoalTypeControl({ value, onChange }: Readonly<{ value: GoalType; onChange: (type: GoalType) => void }>) {
  return (
    <fieldset>
      <legend className="label">Goal type</legend>
      <div className="flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
        {GOAL_TYPES.map((type) => (
          <label key={type} className="flex-1">
            <input type="radio" name="goal-type" value={type} checked={value === type} onChange={() => onChange(type)} className="peer sr-only" />
            <span className="block cursor-pointer rounded-md px-3 py-1.5 text-center text-sm font-medium text-slate-600 transition-colors peer-checked:bg-white peer-checked:text-slate-900 peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-brand-500 dark:text-slate-400 dark:peer-checked:bg-slate-950 dark:peer-checked:text-white">
              {GOAL_TYPE_LABELS[type]}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function YearSelect({ value, today, error, onChange }: Readonly<{ value: string; today: string; error?: string; onChange: (value: string) => void }>) {
  return (
    <div>
      <label className="label" htmlFor="goal-targetYear">
        Achieve by
      </label>
      <select
        id="goal-targetYear"
        className="input"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'goal-targetYear-error' : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {yearOptions(today).map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
      <FieldMessage field="targetYear" error={error} />
    </div>
  );
}

export interface GoalFormProps {
  values: GoalFormValues;
  errors: GoalFieldErrors;
  /** Validated settings (null while the form has errors); drives the derived target hint. */
  settings: GoalSettings | null;
  today: string;
  currency: string;
  /** The portfolio's current forward yield, shown as the placeholder of the starting yield. */
  portfolioYieldPct: number;
  saved: boolean;
  /** Text next to the buttons: what happens to the entered values (can be empty). */
  status: string;
  saving: boolean;
  resetting: boolean;
  submitError?: string;
  onChange: (values: GoalFormValues) => void;
  onBlurField: (field: GoalField) => void;
  onSubmit: () => void;
  onReset: () => void;
}

const defaultTargetText = (type: GoalType): string => String(DEFAULT_GOAL_TARGETS[type]);

/** Expandable section that stays open while one of its fields has an error. */
function AdvancedSection({ hasError, children }: Readonly<{ hasError: boolean; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);
  const toggle = () => {
    if (!hasError) setOpen((o) => !o);
  };
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <button type="button" aria-expanded={open} aria-controls="goal-advanced" onClick={toggle} className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium">
        <span>Returns and inflation</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id="goal-advanced" hidden={!open} className="mt-3 space-y-3">
        {children}
      </div>
    </div>
  );
}

export function GoalForm(props: Readonly<GoalFormProps>) {
  const { values, errors, settings, today, currency, portfolioYieldPct, saved, status, saving, resetting, submitError, onChange, onBlurField, onSubmit, onReset } = props;
  const isValue = values.goalType === 'value';

  const setField = (field: GoalField, value: string) => onChange({ ...values, [field]: value });
  const changeType = (goalType: GoalType) => {
    const other: GoalType = goalType === 'value' ? 'income' : 'value';
    // An untouched default target follows the goal type; anything the user typed is kept.
    const targetAmount = values.targetAmount === defaultTargetText(other) ? defaultTargetText(goalType) : values.targetAmount;
    onChange({ ...values, goalType, targetAmount });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const field = (name: GoalField, label: string, extra: Partial<FieldProps> = {}) => (
    <NumberField field={name} label={label} value={values[name]} error={errors[name]} onChange={setField} onBlur={onBlurField} {...extra} />
  );

  return (
    <form onSubmit={submit} noValidate className="card space-y-4 p-4" aria-label="Goal settings">
      <GoalTypeControl value={values.goalType} onChange={changeType} />
      {field('targetAmount', isValue ? 'Target portfolio value (€)' : 'Target annual passive income (€)', { hint: settings ? targetHint(settings, today, currency) : undefined })}
      <YearSelect value={values.targetYear} today={today} error={errors.targetYear} onChange={(v) => setField('targetYear', v)} />
      {field('monthlyContribution', 'Monthly contribution (€)')}
      <AdvancedSection hasError={ADVANCED_FIELDS.some((f) => errors[f])}>
        {isValue && field('priceReturnPct', 'Expected price return per year (%)')}
        {field('startYieldPct', 'Dividend yield today (%)', {
          placeholder: formatPercent(portfolioYieldPct, { digits: 2 }).replace('%', ''),
          hint: `Leave empty to use your portfolio’s current yield (${formatPercent(portfolioYieldPct)}).`,
        })}
        {field('dividendGrowthPct', 'Dividend growth per year (%)')}
        {field('yieldOnNewMoneyPct', 'Yield on new money (%)')}
        {field('inflationPct', 'Inflation per year (%)')}
        <Toggle id="goal-adjustForInflation" label="Adjust goal for inflation" checked={values.adjustForInflation} onChange={(adjustForInflation) => onChange({ ...values, adjustForInflation })} />
        <Toggle id="goal-reinvestDividends" label="Reinvest dividends" checked={values.reinvestDividends} onChange={(reinvestDividends) => onChange({ ...values, reinvestDividends })} />
      </AdvancedSection>
      {submitError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {submitError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save and calculate'}
        </button>
        <button type="button" className="btn-secondary" disabled={!saved || resetting} onClick={onReset}>
          {resetting ? 'Resetting…' : 'Reset'}
        </button>
        <output className="muted text-xs">{status}</output>
      </div>
    </form>
  );
}
