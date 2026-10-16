import { memo } from 'react';
import { GOAL_SCENARIO_ADJUSTMENTS, MAX_GOAL_CONTRIBUTION, type GoalProjection } from '@portfolio/shared';
import { formatMoney, formatPercent } from '../../lib/format';
import { useSeriesSelection } from '../../components/charts/selection';
import { GOAL_SERIES, GoalChart, goalRowIds } from './GoalChart';
import { GoalTable } from './GoalTable';
import { GOAL_MEASURE, adjustmentText, goalInsights, plural, verdictText, type GoalInsight } from './goalText';

const TONE: Record<GoalInsight['tone'], string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/50 dark:text-emerald-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-100',
  info: 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100',
};

const money = (value: number, currency: string) => formatMoney(value, currency, { maxDigits: 0 });

function Summary({ projection: p }: Readonly<{ projection: GoalProjection }>) {
  const measure = GOAL_MEASURE[p.goalType];
  const { baseCurrency: currency } = p;
  return (
    <section aria-label="Goal summary" className="card p-4">
      <output className="block text-xl font-semibold tracking-tight">{verdictText(p)}</output>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="muted text-xs">{measure.today}</dt>
          <dd className="text-lg font-semibold tabular-nums">{money(p.currentAmount, currency)}</dd>
        </div>
        <div>
          <dt className="muted text-xs">Goal (today’s money)</dt>
          <dd className="text-lg font-semibold tabular-nums">{money(p.targetAmount, currency)}</dd>
        </div>
        <div>
          <dt className="muted text-xs">Goal in {p.targetYear}</dt>
          <dd className="text-lg font-semibold tabular-nums">{money(p.targetAmountAtTargetYear, currency)}</dd>
        </div>
      </dl>
      <progress className="mt-3 h-2 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-brand-600 [&::-webkit-progress-bar]:bg-slate-200 [&::-webkit-progress-value]:bg-brand-600 dark:[&::-webkit-progress-bar]:bg-slate-700" aria-label="Progress towards the goal today" value={Math.min(p.currentAmount, p.targetAmount)} max={p.targetAmount} />
    </section>
  );
}

function Insights({ projection }: Readonly<{ projection: GoalProjection }>) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Insights">
      {goalInsights(projection).map((insight) => (
        <li key={insight.id} className={`rounded-xl border px-3 py-1 text-sm ${TONE[insight.tone]}`}>
          {insight.text}
        </li>
      ))}
    </ul>
  );
}

function Parameters({ projection: p }: Readonly<{ projection: GoalProjection }>) {
  const currency = p.baseCurrency;
  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-sm font-medium">All parameters and scenarios</summary>
      <div className="mt-3 space-y-4 text-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="sr-only">Parameters used per scenario</caption>
            <thead>
              <tr className="muted border-b border-slate-200 text-xs dark:border-slate-800">
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  Scenario
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Price return
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Dividend growth
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Yield on new money
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Goal reached
                </th>
              </tr>
            </thead>
            <tbody>
              {p.scenarios.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                    {s.label}
                  </th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatPercent(s.priceReturnPct, { digits: 1 })}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatPercent(s.dividendGrowthPct, { digits: 1 })}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatPercent(s.yieldOnNewMoneyPct, { digits: 1 })}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.reachedYear === null ? 'Not within horizon' : `${s.reachedYear} (${plural(s.yearsToGoal!, 'year')})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div>
            <dt className="muted text-xs">Starting portfolio value</dt>
            <dd className="tabular-nums">{money(p.start.value, currency)}</dd>
          </div>
          <div>
            <dt className="muted text-xs">Starting annual income ({formatPercent(p.start.yieldPct)} yield)</dt>
            <dd className="tabular-nums">{money(p.start.income, currency)}</dd>
          </div>
          <div>
            <dt className="muted text-xs">Monthly contribution</dt>
            <dd className="tabular-nums">{money(p.monthlyContribution, currency)}</dd>
          </div>
          <div>
            <dt className="muted text-xs">Projected until</dt>
            <dd className="tabular-nums">{p.startYear + p.horizonYears}</dd>
          </div>
        </dl>
        <ul className="muted list-disc space-y-1 pl-5 text-xs">
          <li>
            Safe: {adjustmentText(GOAL_SCENARIO_ADJUSTMENTS.safe)}. Alternative: {adjustmentText(GOAL_SCENARIO_ADJUSTMENTS.alternative)}. Rates never go below zero.
          </li>
          <li>Dividend cuts and market crashes are not modelled: the safe scenario only assumes slower growth.</li>
          <li>
            {p.goalType === 'income'
              ? 'For passive-income goals the price return plays no role; income grows with dividend growth and with what contributions and reinvested dividends buy.'
              : 'Price return only applies to portfolio-value goals. Reinvested dividends are added to the value every month.'}
          </li>
          <li>Contributions stay the same every month; only the goal grows with inflation (when enabled).</li>
          <li>
            The required monthly contribution is the smallest whole-euro amount, found by bisection and capped at {money(MAX_GOAL_CONTRIBUTION, currency)}, for which your plan reaches the goal in{' '}
            {p.targetYear}.
          </li>
        </ul>
      </div>
    </details>
  );
}

// the cards that only describe the calculation do not repaint while a legend entry is previewed
const SummaryCard = memo(Summary);
const InsightsList = memo(Insights);
const ParametersCard = memo(Parameters);

export function GoalResults({ projection }: Readonly<{ projection: GoalProjection }>) {
  const empty = projection.start.value === 0;
  // the chart and the year-by-year table share one selection; the verdict, the summary and the insights always describe the whole calculation
  const selection = useSeriesSelection(GOAL_SERIES, goalRowIds(projection));
  return (
    <div className="space-y-4">
      <SummaryCard projection={projection} />
      {empty && <p className="muted text-sm">There are no holdings in this scope yet, so the projection starts from zero.</p>}
      <InsightsList projection={projection} />
      <div className="card p-4">
        <GoalChart projection={projection} selection={selection} />
      </div>
      <div className="card p-4">
        <GoalTable projection={projection} selection={selection} />
      </div>
      <ParametersCard projection={projection} />
    </div>
  );
}
