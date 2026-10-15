import type { ReactElement, ReactNode } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsDividendGrowthResponse, ForecastTotals, GrowthTimeline } from '@portfolio/shared';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { ChartDataTable, ChartFrame, DataGrid, useDividendTheme } from './chartParts';
import {
  TABLE_COLUMNS,
  declaredKey,
  estimatedKey,
  forecastLabel,
  summaryParts,
  tableRows,
  timelineLegendItems,
  timelineRows,
  visiblePoints,
  yearForecastModel,
  yearLegendItems,
  type YearForecastModel,
} from './growthForecast';
import { ForecastSummary, GrowthLegend, TimelineTooltip, TrendMethod, TrendNote, YearTooltip } from './GrowthForecastParts';

type Theme = ReturnType<typeof useDividendTheme>;

/** Colour of a year, newest first: the current year stands out, earlier years fade. */
export function yearColour(c: Theme, years: readonly string[], year: string): string {
  return [c.received, c.base, c.previous][years.length - 1 - years.indexOf(year)]!;
}

const cell = (value: number | string | undefined, currency: string): string => (typeof value === 'number' ? formatMoney(value, currency) : '—');

/** Bars of the grouped chart: per year its received bar with the declared and estimated forecast stacked on top. */
export function yearBars(model: YearForecastModel, c: Theme): ReactElement[] {
  return model.bars.flatMap((year) => {
    const stacked = model.forecastYears.includes(year);
    const bars: ReactElement[] = [];
    if (model.years.includes(year)) {
      bars.push(<Bar key={year} dataKey={year} stackId={year} fill={yearColour(c, model.years, year)} radius={stacked ? undefined : [3, 3, 0, 0]} isAnimationActive={false} />);
    }
    if (stacked) {
      bars.push(
        <Bar key={declaredKey(year)} dataKey={declaredKey(year)} stackId={year} fill={c.declared} stroke={c.declaredEdge} isAnimationActive={false} />,
        <Bar key={estimatedKey(year)} dataKey={estimatedKey(year)} stackId={year} fill={c.estimated} stroke={c.estimatedEdge} strokeDasharray="4 3" radius={[3, 3, 0, 0]} isAnimationActive={false} />,
      );
    }
    return bars;
  });
}

interface ChartProps {
  data: AnalyticsDividendGrowthResponse;
  timeline: GrowthTimeline;
  showForecast: boolean;
  /** Totals of the Future payments card; null while it loads or failed. */
  forecast: ForecastTotals | null;
  /** Rendered directly below the chart (the growth stat tiles). */
  children?: ReactNode;
}

/** The existing chart: Jan–Dec, one colour per calendar year, plus forecast bars and the average of the years. */
export function YearChart({ data, timeline, showForecast, forecast, children }: Readonly<ChartProps>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const include = showForecast && forecast !== null;
  const model = yearForecastModel(data.byMonth, timeline, include);
  const colorOf = (year: string) => yearColour(c, model.years, year);
  const totals = model.years.map((y) => `${y}: ${formatMoney(data.byYear.find((b) => b.year === y)?.total ?? 0, ccy)}`).join(', ');
  const summary = forecastLabel(timeline, ccy, include ? forecast : null);
  const average = model.hasAverage ? ' The dashed line is the average of the years.' : '';
  const forecastNote = model.forecastYears.length > 0 ? ` Forecast bars (declared and estimated) are stacked on the received amounts for ${model.forecastYears.join(' and ')}.` : '';
  const label = `Dividends received per calendar month, compared for ${model.years.join(', ')}. Totals per year: ${totals}.${forecastNote}${average} ${summary}`.trim();
  const ahead = timeline.points.filter((p) => p.phase !== 'PAST');
  return (
    <>
      <ForecastBlock timeline={timeline} ccy={ccy} forecast={forecast} />
      <GrowthLegend items={yearLegendItems(model, colorOf)} c={c} />
      <ChartFrame label={label} testId="year-compare-chart" bars={model.forecastYears.length > 0 ? 18 : 12} height="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={model.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="month" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
            <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<YearTooltip model={model} ccy={ccy} c={c} colorOf={colorOf} />} />
            {yearBars(model, c)}
            {model.hasAverage && <Line dataKey="average" stroke={c.invested} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      {children}
      <TrendMethod />
      <ChartDataTable
        caption="Dividends received per calendar month and year"
        columns={['Month', ...model.years]}
        rows={model.rows.map((r) => [r.month, ...model.years.map((y) => cell(r[y], ccy))])}
        extra={
          showForecast &&
          include && (
            <DataGrid className="mt-4" caption="Dividend forecast and trend per month" columns={TABLE_COLUMNS} rows={tableRows(ahead, ccy)} />
          )
        }
      />
    </>
  );
}

/** One chronological series: received bars, forecast bars to the right, the 12-month average and the trend. */
export function TimelineChart({ data, timeline, showForecast, forecast, children }: Readonly<ChartProps>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const include = showForecast && forecast !== null;
  const rows = timelineRows(timeline, include);
  const last = rows.at(-1);
  const label = `Dividends received per month from ${rows[0]?.label ?? ''} to ${last?.label ?? ''}, ${include ? 'with forecast bars and a trend line' : 'forecast hidden'}. ${forecastLabel(timeline, ccy, include ? forecast : null)}`.trim();
  return (
    <>
      <ForecastBlock timeline={timeline} ccy={ccy} forecast={forecast} />
      <GrowthLegend items={timelineLegendItems(rows, c.received)} c={c} />
      <ChartFrame label={label} testId="growth-timeline-chart" scrollToEnd bars={Math.ceil(rows.length / 2)} height="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<TimelineTooltip ccy={ccy} c={c} />} />
            <Bar dataKey="received" stackId="t" fill={c.received} isAnimationActive={false} />
            <Bar dataKey="declared" stackId="t" fill={c.declared} stroke={c.declaredEdge} isAnimationActive={false} />
            <Bar dataKey="estimated" stackId="t" fill={c.estimated} stroke={c.estimatedEdge} strokeDasharray="4 3" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Line dataKey="average" type="monotone" stroke={c.invested} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="trend" stroke={c.value} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="projection" stroke={c.value} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      {children}
      <TrendMethod />
      <ChartDataTable caption="Dividends received, forecast and trend per month" columns={TABLE_COLUMNS} rows={tableRows(visiblePoints(timeline, include), ccy)} />
    </>
  );
}

/** The summary line and the "needs history" note, between the toggles and the chart of both views. */
export function ForecastBlock({ timeline, ccy, forecast }: Readonly<{ timeline: GrowthTimeline; ccy: string; forecast: ForecastTotals | null }>) {
  const parts = summaryParts(timeline, ccy, forecast);
  return (
    <>
      <ForecastSummary parts={parts} />
      {timeline.trend === null && <TrendNote />}
    </>
  );
}
