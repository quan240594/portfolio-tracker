import { useState, type FormEvent } from 'react';
import type { AnalyticsGoalParams, AnalyticsGoalResponse, GoalScenario } from '@portfolio/shared';
import { useAnalyticsGoal } from '../../api/analyticsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { GoalChart } from '../../components/charts/GoalChart';
import { LOCALE, formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { DEFAULT_GOAL_FORM, parseGoalForm, type GoalField, type GoalFormValues } from './goalForm';
import { PanelHeader, TableShell, numCell, rowClass } from './TableShell';

const FIELDS: { name: GoalField; label: string; hint?: string }[] = [
  { name: 'targetIncome', label: 'Target annual income (€)' },
  { name: 'monthlyContribution', label: 'Monthly contribution (€)' },
  { name: 'dividendGrowthPct', label: 'Dividend growth per year (%)' },
  { name: 'yieldOnNewMoneyPct', label: 'Yield on new money (%)' },
  { name: 'currentYieldPct', label: 'Starting yield (%)', hint: 'Leave empty to use your portfolio’s current yield.' },
  { name: 'years', label: 'Horizon (years)' },
];

interface FieldProps {
  name: GoalField;
  label: string;
  hint?: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

function describedBy(name: GoalField, error?: string, hint?: string): string | undefined {
  if (error) return `goal-${name}-error`;
  return hint ? `goal-${name}-hint` : undefined;
}

function GoalFieldInput({ name, label, hint, value, error, onChange }: Readonly<FieldProps>) {
  return (
    <div>
      <label className="label" htmlFor={`goal-${name}`}>
        {label}
      </label>
      <input
        id={`goal-${name}`}
        className="input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, error, hint)}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p id={`goal-${name}-error`} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {!error && hint && (
        <p id={`goal-${name}-hint`} className="muted mt-1 text-xs">
          {hint}
        </p>
      )}
    </div>
  );
}

function GoalForm({ onSubmit }: Readonly<{ onSubmit: (params: AnalyticsGoalParams) => void }>) {
  const [values, setValues] = useState<GoalFormValues>(DEFAULT_GOAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<GoalField, string>>>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = parseGoalForm(values);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.params);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3" aria-label="Income goal assumptions">
      {FIELDS.map((f) => (
        <GoalFieldInput key={f.name} {...f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues({ ...values, [f.name]: v })} />
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={values.reinvestDividends} onChange={(e) => setValues({ ...values, reinvestDividends: e.target.checked })} />
        Reinvest dividends
      </label>
      <button type="submit" className="btn-primary">
        Update projection
      </button>
    </form>
  );
}

const yearsFormatter = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

function yearsToGoalText(s: GoalScenario, horizon: number): string {
  if (s.yearsToGoal === null) return `Not within ${horizon} years`;
  return s.yearsToGoal === 0 ? 'Already reached' : `${yearsFormatter.format(s.yearsToGoal)} years`;
}

function GoalResults({ data }: Readonly<{ data: AnalyticsGoalResponse }>) {
  const { inputs } = data;
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Starting from <strong>{formatMoney(inputs.currentIncome, data.baseCurrency)}</strong> a year ({formatPercent(inputs.currentYieldPct)} yield on{' '}
        {formatMoney(inputs.currentValue, data.baseCurrency)}), aiming for <strong>{formatMoney(inputs.targetIncome, data.baseCurrency)}</strong> a year.
      </p>
      <GoalChart scenarios={data.scenarios} targetIncome={inputs.targetIncome} currency={data.baseCurrency} />
      <TableShell
        caption="Projection per scenario"
        columns={[{ label: 'Scenario' }, { label: 'Dividend growth', align: 'right' }, { label: 'Yield new money', align: 'right' }, { label: 'Time to goal', align: 'right' }, { label: `Income after ${inputs.years} y`, align: 'right' }]}
      >
        {data.scenarios.map((s) => (
          <tr key={s.id} className={rowClass}>
            <th scope="row" className="py-2 pr-3 text-left font-medium">
              {s.label}
            </th>
            <td className={numCell}>{formatPercent(s.dividendGrowthPct, { digits: 1 })}</td>
            <td className={numCell}>{formatPercent(s.yieldOnNewMoneyPct, { digits: 1 })}</td>
            <td className={`${numCell} font-medium`}>{yearsToGoalText(s, inputs.years)}</td>
            <td className={numCell}>{formatMoney(s.points.at(-1)?.income ?? 0, data.baseCurrency)}</td>
          </tr>
        ))}
      </TableShell>
      <p className="muted text-xs">
        A simple monthly model: existing dividends grow at the chosen rate and every month your contribution
        {inputs.reinvestDividends ? ' and the dividends received' : ''} buys extra income at the yield on new money. The cautious and optimistic
        scenarios use 2 points less/more dividend growth and 0,5 points less/more yield. Not a forecast.
      </p>
    </div>
  );
}

export function GoalTab() {
  const [params, setParams] = useState<AnalyticsGoalParams>({});
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsGoal(scope, params, { enabled: ready });
  return (
    <section aria-labelledby="goal-title">
      <PanelHeader id="goal-title" title="Passive income goal" description="How long until your dividends reach the income you are aiming for?" />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <GoalForm onSubmit={setParams} />
        <QueryBoundary query={query} loadingLabel="Loading projection" errorTitle="Could not load the projection">
          {(data) => <GoalResults data={data} />}
        </QueryBoundary>
      </div>
    </section>
  );
}
