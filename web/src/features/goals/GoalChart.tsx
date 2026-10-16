import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GoalPlanId, GoalProjection, GoalRow } from '@portfolio/shared';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { compactMoneyTick, moneyTooltip } from '../../components/charts/chartFormatters';
import { LegendSwatch, NothingSelected, SelectableLegend, focusOpacity, selectRows, type SeriesSelection } from '../../components/charts/selection';
import { formatMoney } from '../../lib/format';
import { GOAL_MEASURE, verdictText } from './goalText';

const SERIES_NAMES: Record<string, string> = { plan: 'Your plan', safe: 'Safe', alternative: 'Alternative', goal: 'Goal (inflation-adjusted)' };
export const goalSeriesName = (name: unknown): string => SERIES_NAMES[String(name)] ?? String(name);

export function goalLineColours(theme: Theme): Record<GoalPlanId | 'goal', string> {
  const c = analyticsTheme(theme);
  return { plan: c.base, safe: theme === 'dark' ? '#38bdf8' : '#0284c7', alternative: c.optimistic, goal: c.benchmark };
}

/** Screen-reader summary of the chart; the table below lists the same values. */
export function goalChartSummary(p: GoalProjection): string {
  const end = p.rows.at(-1)!;
  const measure = GOAL_MEASURE[p.goalType].column.toLowerCase();
  const goal = formatMoney(p.targetAmountAtTargetYear, p.baseCurrency, { maxDigits: 0 });
  return `Projected ${measure} from ${p.startYear} to ${end.year} for three scenarios against a goal of ${goal} in ${p.targetYear}. ${verdictText(p)}.`;
}

/** Vertical room above the highest goal; scenarios that grow far beyond the goal are clipped instead of flattening the rest. */
export const goalChartMax = (rows: readonly Pick<GoalRow, 'goal'>[]): number => Math.max(...rows.map((r) => r.goal)) * 1.5;

/** The value axis: clipped above the goal while the goal line is drawn; without it the axis simply fits what is left. */
export const goalAxisDomain = (rows: readonly Pick<GoalRow, 'goal'>[], drawn: readonly string[]): [number, number | 'auto'] => [0, drawn.includes('goal') ? goalChartMax(rows) : 'auto'];

/** Legend order = the order the lines are drawn in. */
export const GOAL_SERIES = ['goal', 'safe', 'alternative', 'plan'] as const;

/** The years of a projection: the table's rows, which can be excluded one by one. */
export const goalRowIds = (p: Pick<GoalProjection, 'rows'>): string[] => p.rows.map((r) => String(r.year));

const LINE_WIDTHS: Record<(typeof GOAL_SERIES)[number], number> = { goal: 2, safe: 1.5, alternative: 1.5, plan: 2.75 };

interface Props {
  projection: GoalProjection;
  /** Shared with the year-by-year table: the series are its Goal and scenario columns, the years its rows. */
  selection: SeriesSelection;
}

/** The goal and scenario lines. The verdict and the summary describe the whole calculation, so they do not change when a line is excluded here. */
export function GoalChart({ projection, selection }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colours = goalLineColours(theme);
  const { scenarios, baseCurrency } = projection;
  // the preview changes on every hover: these depend on what is included only, so they keep their identity meanwhile
  const { isRowVisible, isSeriesVisible } = selection;
  const rows = useMemo(() => selectRows(projection.rows, (r) => String(r.year), { isRowVisible }), [projection.rows, isRowVisible]);
  const drawn = useMemo(() => GOAL_SERIES.filter((key) => isSeriesVisible(key)), [isSeriesVisible]);
  const markers = useMemo(
    () =>
      scenarios.flatMap((s) => {
        const row = rows.find((r) => r.year === s.reachedYear);
        return row && isSeriesVisible(s.id) ? [{ id: s.id, year: row.year, value: row[s.id] }] : [];
      }),
    [scenarios, rows, isSeriesVisible],
  );
  // a line and its "goal reached" dot are one legend entry; the target-year rule is not a series and stays
  const fade = (key: string) => focusOpacity(selection.focusKey, key);
  const entries = GOAL_SERIES.map((key) => ({ key, label: goalSeriesName(key), swatch: <LegendSwatch shape="line" color={colours[key]} dashed={key === 'goal'} /> }));

  return (
    <figure>
      <figcaption className="sr-only">
        {goalChartSummary(projection)} {selection.hasHidden && 'The chart shows the current selection. '}The table below lists the same values.
      </figcaption>
      <SelectableLegend entries={entries} selection={selection} label="Chart series" testId="goal-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <>
          <div aria-hidden="true" className="chart-focus h-72 w-full sm:h-80" data-testid="goal-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 22, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis dataKey="year" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} minTickGap={28} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis domain={goalAxisDomain(rows, drawn)} allowDataOverflow tickFormatter={compactMoneyTick(baseCurrency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={76} />
                <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={String} formatter={moneyTooltip(baseCurrency, goalSeriesName)} />
                <ReferenceLine x={projection.targetYear} stroke={c.axis} strokeWidth={1} label={{ value: `Target year ${projection.targetYear}`, fill: c.axis, fontSize: 11, position: 'top' }} />
                {drawn.map((key) => (
                  <Line key={key} type="monotone" dataKey={key} stroke={colours[key]} strokeWidth={LINE_WIDTHS[key]} strokeOpacity={fade(key)} strokeDasharray={key === 'goal' ? '6 4' : undefined} dot={false} isAnimationActive={false} />
                ))}
                {markers.map((m) => (
                  <ReferenceDot key={m.id} x={m.year} y={m.value} r={5} fill={colours[m.id]} fillOpacity={fade(m.id)} stroke={c.tooltipBg} strokeWidth={2} strokeOpacity={fade(m.id)} ifOverflow="hidden" />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="muted mt-1 text-xs">The dots mark the year each scenario first reaches the goal.</p>
        </>
      )}
    </figure>
  );
}
