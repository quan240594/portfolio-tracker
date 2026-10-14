import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BenchmarkPoint } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatDate, formatMoney } from '../../lib/format';
import { compactMoneyTick, dateLabel, dateTickFormatter, moneyTooltip } from './chartFormatters';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';

interface Props {
  points: readonly BenchmarkPoint[];
  currency: string;
  benchmark: string;
}

export const benchmarkSeriesName = (benchmark: string) => (name: unknown) => {
  if (name === 'portfolio') return 'Portfolio';
  return name === 'benchmark' ? benchmark : 'Invested';
};

export function BenchmarkChart({ points, currency, benchmark }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const first = points[0];
  const last = points.at(-1);
  const hasBenchmark = last?.benchmark !== null && last?.benchmark !== undefined;
  const summary =
    first && last
      ? `Portfolio value from ${formatDate(first.date)} to ${formatDate(last.date)}: ${formatMoney(first.portfolio, currency)} to ${formatMoney(last.portfolio, currency)}${hasBenchmark ? `, against ${benchmark} replayed with the same cash flows: ${formatMoney(last.benchmark!, currency)}` : ''}.`
      : 'No history available.';
  const nameOf = benchmarkSeriesName(benchmark);

  return (
    <div role="img" aria-label={summary} className="h-72 w-full" data-testid="benchmark-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points as BenchmarkPoint[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={dateTickFormatter(points)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
          <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={dateLabel} formatter={moneyTooltip(currency, nameOf)} />
          <Legend formatter={nameOf} wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="portfolio" stroke={c.value} strokeWidth={2} dot={false} isAnimationActive={false} />
          {hasBenchmark && <Line type="monotone" dataKey="benchmark" stroke={c.benchmark} strokeWidth={2} dot={false} isAnimationActive={false} />}
          <Line type="stepAfter" dataKey="invested" stroke={c.invested} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
