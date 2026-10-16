import { GOAL_PLAN_IDS, GOAL_PLAN_LABELS, goalRowsToCsv, type GoalPlanId, type GoalProjection, type GoalRow } from '@portfolio/shared';
import { SelectableTable, type SeriesSelection } from '../../components/charts/selection';
import { downloadFile } from '../management/form';
import { formatMoney } from '../../lib/format';
import { GOAL_MEASURE } from './goalText';

function ReachedBadge() {
  return (
    <span className="ml-1.5 inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
      Goal reached
    </span>
  );
}

function PlanValue({ id, row, reachedYear, currency }: Readonly<{ id: GoalPlanId; row: GoalRow; reachedYear: number | null; currency: string }>) {
  return (
    <>
      {formatMoney(row[id], currency, { maxDigits: 0 })}
      {reachedYear === row.year && <ReachedBadge />}
    </>
  );
}

interface Props {
  projection: GoalProjection;
  /** Shared with the chart: the Goal and scenario columns are its series, the years its rows. */
  selection: SeriesSelection;
}

export function GoalTable({ projection, selection }: Readonly<Props>) {
  const { rows, scenarios, baseCurrency: currency, targetYear, monthlyContribution } = projection;
  const reached = Object.fromEntries(scenarios.map((s) => [s.id, s.reachedYear])) as Record<GoalPlanId, number | null>;
  const column = GOAL_MEASURE[projection.goalType].column;
  const perMonth = formatMoney(monthlyContribution, currency, { maxDigits: 0 });
  const columns = [
    { key: 'goal', label: 'Goal' },
    { key: 'contributed', label: `Contributions (${perMonth}/month)`, selectable: false },
    ...GOAL_PLAN_IDS.map((id) => ({ key: id, label: GOAL_PLAN_LABELS[id] })),
  ];
  const tableRows = rows.map((row) => {
    const isTarget = row.year === targetYear;
    return {
      id: String(row.year),
      header: row.yearOffset === 0 ? 'Today' : String(row.year),
      current: isTarget,
      note: isTarget && <span className="ml-1.5 text-xs font-semibold text-brand-700 dark:text-brand-100">Target year</span>,
      cells: [
        formatMoney(row.goal, currency, { maxDigits: 0 }),
        formatMoney(row.contributed, currency, { maxDigits: 0 }),
        ...GOAL_PLAN_IDS.map((id) => <PlanValue key={id} id={id} row={row} reachedYear={reached[id]} currency={currency} />),
      ],
    };
  });

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
      {selection.hasHidden && <p className="muted mb-2 text-xs">The CSV always contains every year and scenario, whatever is excluded here.</p>}
      <SelectableTable
        caption={`${column} per year for each scenario, against the inflation-adjusted goal. Contributions are ${perMonth} per month.`}
        rowHeader="Year"
        columns={columns}
        rows={tableRows}
        selection={selection}
        tableClassName="w-full min-w-[40rem] text-sm"
        scrollClassName="max-h-[28rem] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800"
        headClassName="sticky top-0 bg-slate-50 dark:bg-slate-900"
      />
      <p className="muted mt-2 text-xs">Forecasts are approximate. Future values are calculated from today’s date and today’s portfolio.</p>
    </section>
  );
}
