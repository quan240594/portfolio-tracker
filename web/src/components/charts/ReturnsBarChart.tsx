import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ReturnPeriod, ReturnPeriodRow } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatPercent } from '../../lib/format';
import { periodLabel, percentTick } from '../../features/analytics/labels';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';

interface Props {
  /** The periods to draw: the ones that are not excluded (at least one). */
  rows: readonly ReturnPeriodRow[];
  period: ReturnPeriod;
  /** Some periods are excluded: the text alternative says the chart shows a selection. */
  filtered?: boolean;
}

export const returnsTooltip = (v: unknown): [string, string] => [formatPercent(Number(v), { signed: true }), 'Time-weighted return'];

export function ReturnsBarChart({ rows, period, filtered = false }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const best = rows.reduce((a, r) => (r.twrPct > a.twrPct ? r : a), rows[0]!);
  const worst = rows.reduce((a, r) => (r.twrPct < a.twrPct ? r : a), rows[0]!);
  const label = `Time-weighted return per ${period} over ${rows.length} periods. Best ${periodLabel(period, best.period)} ${formatPercent(best.twrPct, { signed: true })}, worst ${periodLabel(period, worst.period)} ${formatPercent(worst.twrPct, { signed: true })}.${filtered ? ' Chart shows the current selection.' : ''}`;
  const data = rows.map((r) => ({ label: periodLabel(period, r.period), twrPct: r.twrPct }));

  return (
    <div role="img" aria-label={label} className="h-72 w-full" data-testid="returns-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={12} />
          <YAxis tickFormatter={percentTick} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={returnsTooltip} />
          <ReferenceLine y={0} stroke={c.axis} />
          <Bar dataKey="twrPct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.label} fill={d.twrPct >= 0 ? c.gain : c.loss} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
