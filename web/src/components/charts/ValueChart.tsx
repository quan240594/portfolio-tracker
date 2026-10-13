import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ValuePoint } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatDate, formatMoney } from '../../lib/format';
import { chartTheme } from './palette';

interface Props {
  points: ValuePoint[];
  currency: string;
}

export function ValueChart({ points, currency }: Props) {
  const { theme } = useTheme();
  const c = chartTheme(theme);
  const first = points[0];
  const last = points.at(-1);
  const summary =
    first && last
      ? `Portfolio value from ${formatDate(first.date)} to ${formatDate(last.date)}: ${formatMoney(first.value, currency)} to ${formatMoney(last.value, currency)}; invested ${formatMoney(last.invested, currency)}.`
      : 'No history available.';
  const spanDays = first && last ? (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000 : 0;
  const tickFormat: Intl.DateTimeFormatOptions = spanDays > 200 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' };

  return (
    <div role="img" aria-label={summary} className="h-72 w-full" data-testid="value-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.value} stopOpacity={0.35} />
              <stop offset="100%" stopColor={c.value} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => formatDate(d, tickFormat)}
            stroke={c.axis}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            tickFormatter={(v: number) => formatMoney(v, currency, { compact: true })}
            stroke={c.axis}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={64}
            domain={['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, color: c.text, fontSize: 12 }}
            labelFormatter={(d) => formatDate(String(d))}
            formatter={(v, name) => [formatMoney(Number(v), currency), name === 'value' ? 'Value' : 'Invested']}
          />
          <Area type="monotone" dataKey="value" stroke={c.value} strokeWidth={2} fill="url(#valueFill)" isAnimationActive={false} />
          <Line type="stepAfter" dataKey="invested" stroke={c.invested} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
