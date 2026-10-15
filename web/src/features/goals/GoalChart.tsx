import { CartesianGrid, Legend, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GoalPlanId, GoalProjection } from '@portfolio/shared';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { compactMoneyTick, moneyTooltip } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { GOAL_MEASURE, verdictText } from './goalText';

const SERIES_NAMES: Record<string, string> = { plan: 'Your plan', safe: 'Safe', alternative: 'Alternative', goal: 'Goal (inflation-adjusted)' };
export const goalSeriesName = (name: unknown): string => SERIES_NAMES[String(name)] ?? String(name);
export const yearLabel = (year: unknown): string => String(year);

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
export const goalChartMax = (p: GoalProjection): number => Math.max(...p.rows.map((r) => r.goal)) * 1.5;

export function GoalChart({ projection }: Readonly<{ projection: GoalProjection }>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colours = goalLineColours(theme);
  const { rows, scenarios, baseCurrency } = projection;
  const markers = scenarios.flatMap((s) => {
    const row = rows.find((r) => r.year === s.reachedYear);
    return row ? [{ id: s.id, year: row.year, value: row[s.id] }] : [];
  });

  return (
    <figure>
      <figcaption className="sr-only">{goalChartSummary(projection)} The table below lists the same values.</figcaption>
      <div aria-hidden="true" className="h-72 w-full sm:h-80" data-testid="goal-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 22, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="year" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} minTickGap={28} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis domain={[0, goalChartMax(projection)]} allowDataOverflow tickFormatter={compactMoneyTick(baseCurrency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={76} />
            <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={yearLabel} formatter={moneyTooltip(baseCurrency, goalSeriesName)} />
            <Legend formatter={goalSeriesName} wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine x={projection.targetYear} stroke={c.axis} strokeWidth={1} label={{ value: `Target year ${projection.targetYear}`, fill: c.axis, fontSize: 11, position: 'top' }} />
            <Line type="monotone" dataKey="goal" stroke={colours.goal} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="safe" stroke={colours.safe} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="alternative" stroke={colours.alternative} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="plan" stroke={colours.plan} strokeWidth={2.75} dot={false} isAnimationActive={false} />
            {markers.map((m) => (
              <ReferenceDot key={m.id} x={m.year} y={m.value} r={5} fill={colours[m.id]} stroke={c.tooltipBg} strokeWidth={2} ifOverflow="hidden" />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="muted mt-1 text-xs">The dots mark the year each scenario first reaches the goal.</p>
    </figure>
  );
}
