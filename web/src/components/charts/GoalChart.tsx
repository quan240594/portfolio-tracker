import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GoalScenario } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney } from '../../lib/format';
import { compactMoneyTick, moneyTooltip } from './chartFormatters';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';

interface Props {
  scenarios: readonly GoalScenario[];
  targetIncome: number;
  currency: string;
}

const SCENARIO_NAMES: Record<string, string> = { cautious: 'Cautious', base: 'Base', optimistic: 'Optimistic' };
export const scenarioName = (name: unknown) => SCENARIO_NAMES[String(name)] ?? String(name);

/** One row per year with a column per scenario id. */
export function goalRows(scenarios: readonly GoalScenario[]): Record<string, number>[] {
  const years = scenarios[0]?.points.map((p) => p.year) ?? [];
  return years.map((year, i) => ({ year, ...Object.fromEntries(scenarios.map((s) => [s.id, s.points[i]?.income ?? 0])) }));
}

export function GoalChart({ scenarios, targetIncome, currency }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colours: Record<string, string> = { cautious: c.cautious, base: c.base, optimistic: c.optimistic };
  const base = scenarios.find((s) => s.id === 'base');
  const end = base?.points.at(-1);
  const label = end
    ? `Projected annual passive income over ${end.year} years: ${formatMoney(end.income, currency)} in the base scenario, against a target of ${formatMoney(targetIncome, currency)}.`
    : 'No projection available.';

  return (
    <div role="img" aria-label={label} className="h-72 w-full" data-testid="goal-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={goalRows(scenarios)} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="year" tickFormatter={(y: number) => `${y}y`} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} />
          <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={(y) => `In ${String(y)} years`} formatter={moneyTooltip(currency, scenarioName)} />
          <Legend formatter={scenarioName} wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={targetIncome} stroke={c.benchmark} strokeDasharray="6 4" label={{ value: 'Target', fill: c.axis, fontSize: 11, position: 'insideTopLeft' }} />
          {scenarios.map((s) => (
            <Line key={s.id} type="monotone" dataKey={s.id} stroke={colours[s.id]} strokeWidth={s.id === 'base' ? 2.5 : 1.5} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
