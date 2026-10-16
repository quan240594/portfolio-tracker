import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GoalScenario } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney } from '../../lib/format';
import { compactMoneyTick, moneyTooltip } from './chartFormatters';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';
import { focusOpacity } from './selection';

interface Props {
  /** The scenarios to draw: the ones that are not excluded. */
  scenarios: readonly GoalScenario[];
  targetIncome: number;
  currency: string;
  /** Some scenarios are excluded: the text alternative says the chart shows a selection. */
  filtered?: boolean;
  /** The previewed scenario (its legend entry): the other scenario lines fade; the target line stays. */
  focusKey?: string | null;
}

const SCENARIO_NAMES: Record<string, string> = { cautious: 'Cautious', base: 'Base', optimistic: 'Optimistic' };
export const scenarioName = (name: unknown) => SCENARIO_NAMES[String(name)] ?? String(name);

/** One colour per scenario id, the same in the chart, the legend and the table. */
export const scenarioColours = (c: ReturnType<typeof analyticsTheme>): Record<string, string> => ({ cautious: c.cautious, base: c.base, optimistic: c.optimistic });

/** One row per year with a column per scenario id. */
export function goalRows(scenarios: readonly GoalScenario[]): Record<string, number>[] {
  const years = scenarios[0]?.points.map((p) => p.year) ?? [];
  return years.map((year, i) => ({ year, ...Object.fromEntries(scenarios.map((s) => [s.id, s.points[i]?.income ?? 0])) }));
}

/** Text alternative: the base scenario's end value when it is drawn, otherwise the first scenario that is. */
export function goalSummary(scenarios: readonly GoalScenario[], targetIncome: number, currency: string): string {
  const scenario = scenarios.find((s) => s.id === 'base') ?? scenarios[0];
  const end = scenario?.points.at(-1);
  if (!scenario || !end) return 'No projection available.';
  return `Projected annual passive income over ${end.year} years: ${formatMoney(end.income, currency)} in the ${scenarioName(scenario.id).toLowerCase()} scenario, against a target of ${formatMoney(targetIncome, currency)}.`;
}

export function GoalChart({ scenarios, targetIncome, currency, filtered = false, focusKey = null }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colours = scenarioColours(c);
  const rows = useMemo(() => goalRows(scenarios), [scenarios]);
  return (
    <div role="img" aria-label={filtered ? `${goalSummary(scenarios, targetIncome, currency)} Chart shows the current selection.` : goalSummary(scenarios, targetIncome, currency)} className="chart-focus h-72 w-full" data-testid="goal-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="year" tickFormatter={(y: number) => `${y}y`} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} />
          <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={(y) => `In ${String(y)} years`} formatter={moneyTooltip(currency, scenarioName)} />
          <ReferenceLine y={targetIncome} stroke={c.benchmark} strokeDasharray="6 4" label={{ value: 'Target', fill: c.axis, fontSize: 11, position: 'insideTopLeft' }} />
          {scenarios.map((s) => (
            <Line key={s.id} type="monotone" dataKey={s.id} stroke={colours[s.id]} strokeWidth={s.id === 'base' ? 2.5 : 1.5} strokeOpacity={focusOpacity(focusKey, s.id)} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
