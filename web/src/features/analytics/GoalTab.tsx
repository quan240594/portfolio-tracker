import { useCallback, useMemo, useState, type FormEvent } from 'react';
import type { AnalyticsGoalParams, AnalyticsGoalResponse, GoalScenario } from '@portfolio/shared';
import { useAnalyticsGoal } from '../../api/analyticsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { GoalChart, scenarioColours, scenarioName } from '../../components/charts/GoalChart';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { LegendSwatch, NothingSelected, SelectableLegend, SelectableTable, useSliceSelection } from '../../components/charts/selection';
import { useTheme } from '../../theme/ThemeProvider';
import { LOCALE, formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { CardGrid } from '../layout/CardGrid';
import { GrowthChoices, YieldChoices } from '../assumptions/AssumptionChoices';
import { useGoalAssumptions, type AssumptionField, type AssumptionsController } from '../assumptions/useGoalAssumptions';
import { DEFAULT_GOAL_FORM, GOAL_FIELD_RULES, parseGoalForm, type GoalField, type GoalFormValues } from './goalForm';
import { PanelHeader } from './TableShell';

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

const ASSUMPTION_RANGES = {
  growth: GOAL_FIELD_RULES.dividendGrowthPct,
  yield: GOAL_FIELD_RULES.yieldOnNewMoneyPct,
  inflation: { min: 0, max: 0 },
};

interface FormProps {
  values: GoalFormValues;
  errors: Partial<Record<GoalField, string>>;
  assumptions: AssumptionsController;
  onFieldChange: (name: GoalField, value: string) => void;
  onValuesChange: (values: GoalFormValues) => void;
  onSubmit: (e: FormEvent) => void;
}

function GoalForm({ values, errors, assumptions, onFieldChange, onValuesChange, onSubmit }: Readonly<FormProps>) {
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3" aria-label="Income goal assumptions">
      {FIELDS.map((f) => (
        <div key={f.name} className="space-y-2">
          <GoalFieldInput {...f} value={values[f.name]} error={errors[f.name]} onChange={(v) => onFieldChange(f.name, v)} />
          {f.name === 'dividendGrowthPct' && <GrowthChoices helper={assumptions.growth} />}
          {f.name === 'yieldOnNewMoneyPct' && <YieldChoices helper={assumptions.yield} />}
        </div>
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={values.reinvestDividends} onChange={(e) => onValuesChange({ ...values, reinvestDividends: e.target.checked })} />
        <span>Reinvest dividends</span>
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

/** The table's scenario columns only describe a scenario, so a scenario is a row: legend and row headers toggle the same state. */
const scenarioColumns = (years: number) => [
  { key: 'dividendGrowth', label: 'Dividend growth', selectable: false },
  { key: 'yieldNew', label: 'Yield new money', selectable: false },
  { key: 'timeToGoal', label: 'Time to goal', selectable: false },
  { key: 'income', label: `Income after ${years} y`, selectable: false },
];

function GoalResults({ data }: Readonly<{ data: AnalyticsGoalResponse }>) {
  const { inputs } = data;
  const { theme } = useTheme();
  const colours = scenarioColours(analyticsTheme(theme));
  const selection = useSliceSelection(data.scenarios.map((s) => s.id));
  const { isSeriesVisible } = selection;
  // only the include/exclude state changes the scenarios drawn: a hover preview keeps this array (and the chart's rows) as they are
  const shown = useMemo(() => data.scenarios.filter((s) => isSeriesVisible(s.id)), [data.scenarios, isSeriesVisible]);
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Starting from <strong>{formatMoney(inputs.currentIncome, data.baseCurrency)}</strong> a year ({formatPercent(inputs.currentYieldPct)} yield on{' '}
        {formatMoney(inputs.currentValue, data.baseCurrency)}), aiming for <strong>{formatMoney(inputs.targetIncome, data.baseCurrency)}</strong> a year.
      </p>
      <div>
        <SelectableLegend
          label="Scenarios"
          testId="goal-legend"
          selection={selection}
          entries={data.scenarios.map((s) => ({ key: s.id, label: scenarioName(s.id), swatch: <LegendSwatch shape="line" color={colours[s.id]!} /> }))}
        />
        {selection.nothingSelected ? (
          <NothingSelected onShowAll={selection.reset} />
        ) : (
          <GoalChart scenarios={shown} targetIncome={inputs.targetIncome} currency={data.baseCurrency} filtered={selection.hasHidden} focusKey={selection.focusKey} />
        )}
      </div>
      <SelectableTable
        caption="Projection per scenario"
        rowHeader="Scenario"
        columns={scenarioColumns(inputs.years)}
        selection={selection}
        tableClassName="w-full text-sm"
        scrollClassName="overflow-x-auto"
        rows={data.scenarios.map((s) => ({
          id: s.id,
          header: s.label,
          cells: [
            formatPercent(s.dividendGrowthPct, { digits: 1 }),
            formatPercent(s.yieldOnNewMoneyPct, { digits: 1 }),
            <span key="goal" className="font-medium">
              {yearsToGoalText(s, inputs.years)}
            </span>,
            formatMoney(s.points.at(-1)?.income ?? 0, data.baseCurrency),
          ],
        }))}
      />
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
  const [values, setValues] = useState<GoalFormValues>(DEFAULT_GOAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<GoalField, string>>>({});
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsGoal(scope, params, { enabled: ready });
  const fill = useCallback((patch: Partial<Record<AssumptionField, string>>) => setValues((v) => ({ ...v, ...patch })), []);
  const assumptions = useGoalAssumptions({ scope, enabled: ready, values: { ...values, inflationPct: '' }, fill, ranges: ASSUMPTION_RANGES, autoStart: false, withInflation: false });
  const changeField = (name: GoalField, value: string) => {
    assumptions.noteEdit(name);
    setValues({ ...values, [name]: value });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = parseGoalForm(values);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setParams(result.params);
  };

  return (
    <section aria-labelledby="goal-title">
      <PanelHeader id="goal-title" title="Passive income goal" description="How long until your dividends reach the income you are aiming for?" />
      <CardGrid
        pageId="analytics-goal"
        cards={[
          { id: 'goal-form', title: 'Assumptions', defaultWidth: 'third', render: () => <GoalForm values={values} errors={errors} assumptions={assumptions} onFieldChange={changeField} onValuesChange={setValues} onSubmit={submit} /> },
          {
            id: 'goal-results',
            title: 'Projection',
            defaultWidth: 'twothirds',
            render: () => (
              <QueryBoundary query={query} loadingLabel="Loading projection" errorTitle="Could not load the projection">
                {(data) => <GoalResults data={data} />}
              </QueryBoundary>
            ),
          },
        ]}
      />
    </section>
  );
}
