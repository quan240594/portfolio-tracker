import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney } from '../../lib/format';
import { compactMoneyTick, moneyTooltip } from './chartFormatters';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';

export interface GrowthBar {
  label: string;
  current: number;
  /** Same period one year earlier; omit for a single series. */
  previous?: number;
}

interface Props {
  bars: readonly GrowthBar[];
  currency: string;
  title: string;
  testId: string;
  currentName?: string;
  previousName?: string;
}

export function DividendGrowthChart({ bars, currency, title, testId, currentName = 'Received', previousName = 'A year earlier' }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const total = bars.reduce((s, b) => s + b.current, 0);
  const withPrevious = bars.some((b) => b.previous !== undefined);
  const nameOf = (name: unknown) => (name === 'previous' ? previousName : currentName);

  return (
    <div role="img" aria-label={`${title}: ${bars.length} periods, ${formatMoney(total, currency)} in total.`} className="h-64 w-full" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars as GrowthBar[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={moneyTooltip(currency, nameOf)} />
          {withPrevious && <Legend formatter={nameOf} wrapperStyle={{ fontSize: 12 }} />}
          {withPrevious && <Bar dataKey="previous" fill={c.previous} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
          <Bar dataKey="current" fill={c.received} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
