import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney, formatPercent } from '../../lib/format';
import { compactMoneyTick, dateLabel, dateTickFormatter } from '../../components/charts/chartFormatters';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { benchmarkColors, monthTicks, niceAxis, percentTickWith, returnKey, valueKey, type GrowthRow } from './growthFormat';

interface Props {
  rows: readonly GrowthRow[];
  /** Symbols of the benchmarks to draw (the ones that are not excluded), by their index in the response: the index keeps the colour. */
  benchmarks: readonly { symbol: string; index: number }[];
  /** false = the portfolio line is excluded in the legend or the table. */
  showPortfolio: boolean;
  /** false = the invested line is excluded (value chart only; default true). */
  showInvested?: boolean;
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
export function GrowthChart({ rows, benchmarks, showPortfolio, showInvested = true, kind, currency, summary, testId }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colors = benchmarkColors(theme);
  const isValue = kind === 'value';
  const portfolioKey = isValue ? 'value' : 'returnPct';
  const dates = rows.map((r) => String(r.date));
  const longSpan = dates.length > 1 && Date.parse(dates.at(-1)!) - Date.parse(dates[0]!) > 200 * 86_400_000;
  const returns = rows.flatMap((r) => [...(showPortfolio ? [Number(r.returnPct)] : []), ...benchmarks.map((b) => Number(r[returnKey(b.index)] ?? 0))]);
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
          {isValue && showPortfolio && <Area type="monotone" dataKey="value" name="Portfolio" stroke={c.value} strokeWidth={2.5} fill={`url(#growth-fill-${kind})`} baseValue="dataMin" dot={false} isAnimationActive={false} />}
          {!isValue && showPortfolio && <Line type="monotone" dataKey={portfolioKey} name="Portfolio" stroke={c.value} strokeWidth={2.5} dot={false} isAnimationActive={false} />}
          {isValue && showInvested && <Line type="stepAfter" dataKey="invested" name="Invested" stroke={c.invested} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
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
