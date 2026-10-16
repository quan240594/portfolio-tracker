import { CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AssetMarkerType } from '@portfolio/shared';
import { compactMoneyTick, dateLabel, dateTickFormatter } from '../../components/charts/chartFormatters';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { benchmarkColors, monthTicks, niceAxis, percentTickWith } from '../growth/growthFormat';
import { benchKey, chartExtremes, chartTooltip, labelPosition, formatChartValue, type ChartMode, type ChartRow, type PlottedMarker } from './assetChartData';

interface Props {
  rows: readonly ChartRow[];
  mode: ChartMode;
  /** Benchmarks to draw (the ones that are not excluded), by their index in the response: the index keeps the colour. */
  benchmarks: readonly { symbol: string; index: number }[];
  /** false = the security's own line is excluded: its high/low labels and the trade markers (which sit on it) go with it. */
  showPrice: boolean;
  markers: readonly PlottedMarker[];
  currency: string;
  summary: string;
  symbol: string;
}

const tickProps = { fontSize: 11 } as const;

/** Shape of a trade marker: the shape (not only the colour) tells buys, sells and dividends apart. */
export function MarkerShape({ cx, cy, type, colors }: Readonly<{ cx?: number; cy?: number; type: AssetMarkerType; colors: Record<AssetMarkerType, string> }>) {
  if (cx === undefined || cy === undefined) return null;
  const fill = colors[type];
  const common = { fill, stroke: '#ffffff', strokeWidth: 1.5 } as const;
  if (type === 'BUY') return <path d={`M${cx} ${cy - 7} L${cx + 6} ${cy + 5} L${cx - 6} ${cy + 5} Z`} {...common} />;
  if (type === 'SELL') return <path d={`M${cx} ${cy + 7} L${cx + 6} ${cy - 5} L${cx - 6} ${cy - 5} Z`} {...common} />;
  return <path d={`M${cx} ${cy - 6} L${cx + 6} ${cy} L${cx} ${cy + 6} L${cx - 6} ${cy} Z`} {...common} />;
}

export const markerColors = (theme: Theme): Record<AssetMarkerType, string> => {
  const c = analyticsTheme(theme);
  return { BUY: c.gain, SELL: c.loss, DIVIDEND: c.upcoming };
};

/** The price (or percent change) line with benchmark lines, min/max labels and the user's trades. */
export function PriceChart({ rows, mode, benchmarks, showPrice, markers, currency, summary, symbol }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colors = benchmarkColors(theme);
  const shapeColors = markerColors(theme);
  const isPrice = mode === 'price';
  const dates = rows.map((r) => String(r.date));
  const longSpan = dates.length > 1 && Date.parse(dates.at(-1)!) - Date.parse(dates[0]!) > 200 * 86_400_000;
  const values = rows.flatMap((r) => [...(showPrice ? [Number(r.value)] : []), ...benchmarks.map((b) => Number(r[benchKey(b.index)] ?? 0))]);
  const percentAxis = niceAxis(values, 0.08);
  const { min, max } = chartExtremes(rows);
  const format = formatChartValue(mode, currency);

  return (
    <div role="img" aria-label={summary} className="h-72 w-full sm:h-80" data-testid="asset-price-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows as ChartRow[]} margin={{ top: 22, right: 16, bottom: 6, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={dateTickFormatter(rows as { date: string }[])} stroke={c.axis} tick={tickProps} tickLine={false} axisLine={false} tickMargin={8} minTickGap={48} ticks={longSpan ? monthTicks(dates) : undefined} />
          <YAxis
            tickFormatter={isPrice ? compactMoneyTick(currency) : percentTickWith(percentAxis.digits)}
            stroke={c.axis}
            tick={tickProps}
            tickLine={false}
            axisLine={false}
            width={isPrice ? 64 : 52}
            domain={isPrice ? ['auto', 'auto'] : percentAxis.domain}
            ticks={isPrice ? undefined : percentAxis.ticks}
          />
          <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={dateLabel} formatter={chartTooltip(mode, currency)} />
          {!isPrice && <ReferenceLine y={0} stroke={c.axis} strokeDasharray="3 3" />}
          {showPrice && <Line type="monotone" dataKey="value" name={symbol} stroke={c.value} strokeWidth={2.5} dot={false} isAnimationActive={false} />}
          {benchmarks.map((b) => (
            <Line key={b.symbol} type="monotone" dataKey={benchKey(b.index)} name={b.symbol} stroke={colors[b.index % colors.length]} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          ))}
          {showPrice && max && <ReferenceDot x={max.date} y={max.value} r={4} fill={c.text} stroke={c.tooltipBg} ifOverflow="extendDomain" label={{ value: `High ${format(max.value)}`, position: labelPosition(rows, max.date, 'top'), fontSize: 11, fill: c.text }} />}
          {showPrice && min && min.date !== max?.date && <ReferenceDot x={min.date} y={min.value} r={4} fill={c.text} stroke={c.tooltipBg} ifOverflow="extendDomain" label={{ value: `Low ${format(min.value)}`, position: labelPosition(rows, min.date, 'bottom'), fontSize: 11, fill: c.text }} />}
          {(showPrice ? markers : []).map((m) => (
            <ReferenceDot key={m.key} x={m.x} y={m.y} ifOverflow="extendDomain" shape={<MarkerShape type={m.type} colors={shapeColors} />} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
