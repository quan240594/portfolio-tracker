import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
  /** Draw the current series (default true); false when it is excluded in the legend. */
  showCurrent?: boolean;
  /** Draw the previous-year series when the bars have one (default true). */
  showPrevious?: boolean;
  /** Some periods or series are excluded: the text alternative says the chart shows a selection. */
  filtered?: boolean;
}

/** True when any bar carries a previous-year value: the chart then has a second series. */
export const hasPreviousSeries = (bars: readonly GrowthBar[]): boolean => bars.some((b) => b.previous !== undefined);

export function DividendGrowthChart({ bars, currency, title, testId, currentName = 'Received', previousName = 'A year earlier', showCurrent = true, showPrevious = true, filtered = false }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const drawPrevious = showPrevious && hasPreviousSeries(bars);
  const total = showCurrent ? bars.reduce((s, b) => s + b.current, 0) : bars.reduce((s, b) => s + (b.previous ?? 0), 0);
  const what = showCurrent ? 'in total' : previousName.toLowerCase();
  const nameOf = (name: unknown) => (name === 'previous' ? previousName : currentName);
  const label = `${title}: ${bars.length} periods, ${formatMoney(total, currency)} ${what}.${filtered ? ' Chart shows the current selection.' : ''}`;

  return (
    <div role="img" aria-label={label} className="h-64 w-full" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars as GrowthBar[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={moneyTooltip(currency, nameOf)} />
          {drawPrevious && <Bar dataKey="previous" fill={c.previous} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
          {showCurrent && <Bar dataKey="current" fill={c.received} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
