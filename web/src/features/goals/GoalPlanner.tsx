import { useCallback, useMemo, useState } from 'react';
import { MAX_GOAL_RATE_PCT, type GoalResponse, type GoalSettings } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useGoalPreview, useSaveGoal } from '../../api/goalsHooks';
import { useGoalAssumptions, type AssumptionField } from '../assumptions/useGoalAssumptions';
import { GoalForm } from './GoalForm';
import { GoalResults } from './GoalResults';
import { apiFieldErrors, parseGoalForm, sameSettings, settingsToForm, type GoalField, type GoalFieldErrors, type GoalFormValues } from './goalFormModel';
import { useDebouncedValue } from './useDebouncedValue';

export const PREVIEW_DELAY_MS = 400;

const RATE_RANGE = { min: 0, max: MAX_GOAL_RATE_PCT };
const ASSUMPTION_RANGES = { growth: RATE_RANGE, yield: RATE_RANGE, inflation: RATE_RANGE };

function statusOf(saved: boolean, dirty: boolean): string {
  if (dirty) return saved ? 'Unsaved changes' : 'Not saved yet';
  return saved ? 'Saved' : '';
}

interface Props {
  saved: GoalResponse;
  scope: string;
  resetting: boolean;
  resetError?: string;
  onReset: () => void;
}

/** Goal form plus results: shows the saved projection, or a stateless preview while the form has valid unsaved changes. */
export function GoalPlanner({ saved, scope, resetting, resetError, onReset }: Readonly<Props>) {
  const today = saved.projection.asOf;
  const [values, setValues] = useState<GoalFormValues>(() => settingsToForm(saved.settings));
  const [touched, setTouched] = useState<readonly GoalField[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<GoalFieldErrors>({});
  const save = useSaveGoal(scope);
  const fill = useCallback((patch: Partial<Record<AssumptionField, string>>) => setValues((v) => ({ ...v, ...patch })), []);
  // A goal that was never saved starts from the portfolio's own figures; a saved goal keeps what the owner entered.
  const assumptions = useGoalAssumptions({ scope, values, fill, ranges: ASSUMPTION_RANGES, autoStart: !saved.saved, withInflation: true });

  const parsed = useMemo(() => parseGoalForm(values, today), [values, today]);
  const settings = 'settings' in parsed ? parsed.settings : null;
  const liveErrors = 'errors' in parsed ? parsed.errors : {};
  const shownErrors: GoalFieldErrors = { ...(Object.fromEntries(Object.entries(liveErrors).filter(([field]) => submitted || touched.includes(field as GoalField))) as GoalFieldErrors), ...serverErrors };

  const dirty = settings !== null && !sameSettings(settings, saved.settings);
  const dirtyKey = dirty ? JSON.stringify(settings) : null;
  const settledKey = useDebouncedValue(dirtyKey, PREVIEW_DELAY_MS);
  const previewSettings = useMemo(() => (settledKey === null ? null : (JSON.parse(settledKey) as GoalSettings)), [settledKey]);
  const preview = useGoalPreview(scope, previewSettings);
  const showPreview = dirtyKey !== null && previewSettings !== null && preview.data !== undefined;
  const projection = showPreview ? preview.data.projection : saved.projection;
  const recalculating = dirtyKey !== null && (settledKey !== dirtyKey || preview.isFetching);

  const change = (next: GoalFormValues) => {
    setValues(next);
    setServerErrors({});
    if (save.isError) save.reset();
  };
  const blur = (field: GoalField) => setTouched((t) => (t.includes(field) ? t : [...t, field]));
  const submit = () => {
    setSubmitted(true);
    if (settings) save.mutate(settings, { onError: (err) => setServerErrors(apiFieldErrors(err)) });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start">
      <GoalForm
        values={values}
        errors={shownErrors}
        settings={settings}
        today={today}
        currency={projection.baseCurrency}
        portfolioYieldPct={saved.projection.start.yieldPct}
        assumptions={assumptions}
        saved={saved.saved}
        status={statusOf(saved.saved, dirty)}
        saving={save.isPending}
        resetting={resetting}
        submitError={save.isError ? errorMessage(save.error) : resetError}
        onChange={change}
        onBlurField={blur}
        onSubmit={submit}
        onReset={onReset}
      />
      <div className={`space-y-4 transition-opacity ${recalculating ? 'opacity-60' : ''}`}>
        {showPreview && <output className="block text-sm text-amber-800 dark:text-amber-200">Preview of unsaved changes. Choose “Save and calculate” to keep them.</output>}
        {preview.isError && dirtyKey !== null && <p role="alert" className="text-sm text-red-600 dark:text-red-400">Could not calculate the preview: {errorMessage(preview.error)}</p>}
        <GoalResults projection={projection} />
      </div>
    </div>
  );
}
