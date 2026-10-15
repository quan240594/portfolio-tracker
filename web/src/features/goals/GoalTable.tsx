import { GOAL_PLAN_IDS, GOAL_PLAN_LABELS, goalRowsToCsv, type GoalPlanId, type GoalProjection, type GoalRow } from '@portfolio/shared';
import { downloadFile } from '../management/form';
import { formatMoney } from '../../lib/format';
import { GOAL_MEASURE } from './goalText';

const cell = 'px-3 py-1.5 text-right tabular-nums';

function ReachedBadge() {
  return (
    <span className="ml-1.5 inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
      Goal reached
    </span>
  );
}

function PlanCell({ id, row, reachedYear, currency }: Readonly<{ id: GoalPlanId; row: GoalRow; reachedYear: number | null; currency: string }>) {
  return (
    <td className={cell}>
      {formatMoney(row[id], currency, { maxDigits: 0 })}
      {reachedYear === row.year && <ReachedBadge />}
    </td>
  );
}

export function GoalTable({ projection }: Readonly<{ projection: GoalProjection }>) {
  const { rows, scenarios, baseCurrency: currency, targetYear, monthlyContribution } = projection;
  const reached = Object.fromEntries(scenarios.map((s) => [s.id, s.reachedYear])) as Record<GoalPlanId, number | null>;
  const column = GOAL_MEASURE[projection.goalType].column;
  const perMonth = formatMoney(monthlyContribution, currency, { maxDigits: 0 });

  return (
    <section aria-labelledby="goal-table-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="goal-table-title" className="font-semibold">
          Year by year
        </h3>
        <button type="button" className="btn-secondary" onClick={() => downloadFile('goal-projection.csv', goalRowsToCsv(rows), 'text/csv')}>
          Download CSV
        </button>
      </div>
      <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">
            {column} per year for each scenario, against the inflation-adjusted goal. Contributions are {perMonth} per month.
          </caption>
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
            <tr className="muted border-b border-slate-200 text-xs dark:border-slate-800">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Year
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Goal
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Contributions <span className="font-normal">({perMonth}/month)</span>
              </th>
              {GOAL_PLAN_IDS.map((id) => (
                <th key={id} scope="col" className="px-3 py-2 text-right font-medium">
                  {GOAL_PLAN_LABELS[id]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isTarget = row.year === targetYear;
              return (
                <tr
                  key={row.year}
                  aria-current={isTarget ? 'true' : undefined}
                  className={`border-b border-slate-100 last:border-0 dark:border-slate-800/60 ${isTarget ? 'bg-brand-50 font-medium dark:bg-brand-600/20' : ''}`}
                >
                  <th scope="row" className="px-3 py-1.5 text-left font-normal tabular-nums">
                    {row.yearOffset === 0 ? 'Today' : row.year}
                    {isTarget && <span className="ml-1.5 text-xs font-semibold text-brand-700 dark:text-brand-100">Target year</span>}
                  </th>
                  <td className={cell}>{formatMoney(row.goal, currency, { maxDigits: 0 })}</td>
                  <td className={cell}>{formatMoney(row.contributed, currency, { maxDigits: 0 })}</td>
                  {GOAL_PLAN_IDS.map((id) => (
                    <PlanCell key={id} id={id} row={row} reachedYear={reached[id]} currency={currency} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted mt-2 text-xs">Forecasts are approximate. Future values are calculated from today’s date and today’s portfolio.</p>
    </section>
  );
}
