import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney, formatPercent } from '../../lib/format';
import { compactMoneyTick, dateLabel, dateTickFormatter } from '../../components/charts/chartFormatters';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { benchmarkColors, monthTicks, niceAxis, percentTickWith, returnKey, valueKey, type GrowthRow } from './growthFormat';

export interface LegendItem {
  key: string;
  color: string;
  label: string;
  detail?: string;
  dashed?: boolean;
}

/** Legend as plain markup (reads well for screen readers and never overlaps the plot area). */
export function ChartLegend({ items }: Readonly<{ items: readonly LegendItem[] }>) {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-0 w-5 border-t-[3px]" style={{ borderColor: it.color, borderTopStyle: it.dashed ? 'dashed' : 'solid' }} />
          <span className="font-medium">{it.label}</span>
          {it.detail && <span className="muted tabular-nums">{it.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

interface Props {
  rows: readonly GrowthRow[];
  /** Symbols of the benchmarks that have data, by their index in the response. */
  benchmarks: readonly { symbol: string; index: number }[];
  /** `value` = money area chart with invested line, `return` = cumulative return lines. */
  kind: 'value' | 'return';
  currency: string;
  summary: string;
  testId: string;
}

const tickProps = { fontSize: 11 } as const;

export const growthTooltip =
  (isValue: boolean, currency: string) =>
  (v: unknown, name: unknown): [string, string] => [isValue ? formatMoney(Number(v), currency) : formatPercent(Number(v), { signed: true }), String(name)];

/** Portfolio value (area + invested) or cumulative return (lines) with one line per benchmark. */
export function GrowthChart({ rows, benchmarks, kind, currency, summary, testId }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colors = benchmarkColors(theme);
  const isValue = kind === 'value';
  const portfolioKey = isValue ? 'value' : 'returnPct';
  const dates = rows.map((r) => String(r.date));
  const longSpan = dates.length > 1 && Date.parse(dates.at(-1)!) - Date.parse(dates[0]!) > 200 * 86_400_000;
  const returns = rows.flatMap((r) => [Number(r.returnPct), ...benchmarks.map((b) => Number(r[returnKey(b.index)] ?? 0))]);
  const percentAxis = niceAxis(returns);

  return (
    <div role="img" aria-label={summary} className="h-72 w-full" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows as GrowthRow[]} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`growth-fill-${kind}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.value} stopOpacity={0.28} />
              <stop offset="100%" stopColor={c.value} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={dateTickFormatter(rows as { date: string }[])} stroke={c.axis} tick={tickProps} tickLine={false} axisLine={false} tickMargin={8} minTickGap={48} ticks={longSpan ? monthTicks(dates) : undefined} />
          <YAxis
            tickFormatter={isValue ? compactMoneyTick(currency) : percentTickWith(percentAxis.digits)}
            stroke={c.axis}
            tick={tickProps}
            tickLine={false}
            axisLine={false}
            width={isValue ? 64 : 52}
            domain={isValue ? ['auto', 'auto'] : percentAxis.domain}
            ticks={isValue ? undefined : percentAxis.ticks}
          />
          <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={dateLabel} formatter={growthTooltip(isValue, currency)} />
          {!isValue && <ReferenceLine y={0} stroke={c.axis} strokeDasharray="3 3" />}
          {isValue && <Area type="monotone" dataKey="value" name="Portfolio" stroke={c.value} strokeWidth={2.5} fill={`url(#growth-fill-${kind})`} baseValue="dataMin" dot={false} isAnimationActive={false} />}
          {!isValue && <Line type="monotone" dataKey={portfolioKey} name="Portfolio" stroke={c.value} strokeWidth={2.5} dot={false} isAnimationActive={false} />}
          {isValue && <Line type="stepAfter" dataKey="invested" name="Invested" stroke={c.invested} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
          {benchmarks.map((b) => (
            <Line
              key={b.symbol}
              type="monotone"
              dataKey={isValue ? valueKey(b.index) : returnKey(b.index)}
              name={b.symbol}
              stroke={colors[b.index % colors.length]}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
