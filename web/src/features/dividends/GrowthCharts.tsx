import type { ReactElement, ReactNode } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsDividendGrowthResponse, ForecastTotals, GrowthTimeline } from '@portfolio/shared';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import {
  NothingSelected,
  SelectableDataTable,
  SelectableLegend,
  maskSeries,
  selectRows,
  useSeriesSelection,
  type SelectableColumn,
  type SelectableRow,
} from '../../components/charts/selection';
import { ChartFrame, DataGrid, useDividendTheme } from './chartParts';
import {
  TABLE_COLUMNS,
  declaredKey,
  estimatedKey,
  forecastLabel,
  summaryParts,
  tableRows,
  timelineLegendItems,
  timelineRows,
  selectYearRows,
  visiblePoints,
  yearBarVisible,
  yearForecastModel,
  yearLegendItems,
  type YearForecastModel,
} from './growthForecast';
import { ForecastSummary, TimelineTooltip, TrendMethod, TrendNote, YearTooltip, growthLegendEntries } from './GrowthForecastParts';

type Theme = ReturnType<typeof useDividendTheme>;

/** Colour of a year, newest first: the current year stands out, earlier years fade. */
export function yearColour(c: Theme, years: readonly string[], year: string): string {
  return [c.received, c.base, c.previous][years.length - 1 - years.indexOf(year)]!;
}

const cell = (value: number | string | undefined, currency: string): string => (typeof value === 'number' ? formatMoney(value, currency) : '—');

/** Bars of the grouped chart: per year its received bar with the declared and estimated forecast stacked on top. Bars that are excluded are left out, the top one of each stack gets the rounded corners. */
export function yearBars(model: YearForecastModel, c: Theme, isDrawn: (dataKey: string) => boolean = () => true): ReactElement[] {
  return model.bars.flatMap((year) => {
    const stacked = model.forecastYears.includes(year);
    const specs: { key: string; fill: string; stroke?: string; dash?: string }[] = [];
    if (model.years.includes(year)) specs.push({ key: year, fill: yearColour(c, model.years, year) });
    if (stacked) {
      specs.push({ key: declaredKey(year), fill: c.declared, stroke: c.declaredEdge }, { key: estimatedKey(year), fill: c.estimated, stroke: c.estimatedEdge, dash: '4 3' });
    }
    const drawn = specs.filter((spec) => isDrawn(spec.key));
    return drawn.map((spec, i) => (
      <Bar
        key={spec.key}
        dataKey={spec.key}
        stackId={year}
        fill={spec.fill}
        stroke={spec.stroke}
        strokeDasharray={spec.dash}
        radius={i === drawn.length - 1 ? [3, 3, 0, 0] : undefined}
        isAnimationActive={false}
      />
    ));
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

/** Rows of the data table of the grouped chart: a month per row, a column per year. */
function yearTableRows(model: YearForecastModel, ccy: string): SelectableRow[] {
  return model.rows.map((r) => ({ id: r.month, header: r.month, cells: model.years.map((y) => cell(r[y], ccy)) }));
}

/**
 * The existing chart: Jan–Dec, one colour per calendar year, plus forecast bars and the average of the years.
 * Series (legend, table columns) = the years, the forecast kinds, the average line; rows = the calendar months.
 */
export function YearChart({ data, timeline, showForecast, forecast, children }: Readonly<ChartProps>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const include = showForecast && forecast !== null;
  const full = yearForecastModel(data.byMonth, timeline, include);
  const colorOf = (year: string) => yearColour(c, full.years, year);
  const items = yearLegendItems(full, colorOf);
  const selection = useSeriesSelection(
    items.map((i) => i.key),
    full.rows.map((r) => r.month),
  );
  const isDrawn = yearBarVisible(selection.isSeriesVisible);
  const model = yearForecastModel(
    data.byMonth,
    timeline,
    include,
    3,
    full.years.filter((y) => !selection.isSeriesVisible(y)),
  );
  const rows = selectYearRows(model.rows, selection.isRowVisible, isDrawn);
  const shownYears = model.years.filter((y) => selection.isSeriesVisible(y));
  const totals = shownYears.map((y) => `${y}: ${formatMoney(data.byYear.find((b) => b.year === y)?.total ?? 0, ccy)}`).join(', ');
  const totalsShown = include ? forecast : null;
  const summary = selection.hasHidden ? 'Current selection.' : forecastLabel(timeline, ccy, totalsShown);
  const average = model.hasAverage && isDrawn('average') ? ' The dashed line is the average of the years.' : '';
  const forecastNote = model.forecastYears.length > 0 ? ` Forecast bars (declared and estimated) are stacked on the received amounts for ${model.forecastYears.join(' and ')}.` : '';
  const label = `Dividends received per calendar month, compared for ${shownYears.join(', ')}. Totals per year: ${totals}.${forecastNote}${average} ${summary}`.trim();
  const ahead = timeline.points.filter((p) => p.phase !== 'PAST');
  return (
    <>
      <ForecastBlock timeline={timeline} ccy={ccy} forecast={forecast} />
      <SelectableLegend entries={growthLegendEntries(items, c)} selection={selection} testId="growth-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame label={label} testId="year-compare-chart" bars={Math.ceil(rows.length * (model.forecastYears.length > 0 ? 1.5 : 1))} height="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="month" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
              <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<YearTooltip model={model} ccy={ccy} c={c} colorOf={colorOf} />} />
              {yearBars(model, c, isDrawn)}
              {model.hasAverage && isDrawn('average') && <Line dataKey="average" stroke={c.invested} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      {children}
      <TrendMethod />
      <SelectableDataTable
        caption="Dividends received per calendar month and year"
        rowHeader="Month"
        columns={full.years.map((y) => ({ key: y, label: y }))}
        rows={yearTableRows(full, ccy)}
        selection={selection}
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

/** Series of the timeline, named like the fields of its rows. */
const TIMELINE_COLUMNS: SelectableColumn[] = [
  { key: 'received', label: 'Received' },
  { key: 'declared', label: 'Declared' },
  { key: 'estimated', label: 'Estimated' },
  { key: 'trend', label: 'Trend' },
];

/**
 * One chronological series: received bars, forecast bars to the right, the 12-month average and the trend.
 * Series = received / declared / estimated bars and the average, trend and projected-trend lines; rows = the months.
 * The average and the trend always describe the whole history: hiding months only removes their points from view.
 */
export function TimelineChart({ data, timeline, showForecast, forecast, children }: Readonly<ChartProps>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const include = showForecast && forecast !== null;
  const all = timelineRows(timeline, include);
  const items = timelineLegendItems(all, c.received);
  const keys = items.map((i) => i.key);
  const selection = useSeriesSelection(
    keys,
    all.map((r) => r.month),
  );
  const rows = selectRows(all, (r) => r.month, selection).map((r) => maskSeries(r, keys, selection));
  const last = rows.at(-1);
  const totalsShown = include ? forecast : null;
  const scope = selection.hasHidden ? 'current selection' : forecastLabel(timeline, ccy, totalsShown);
  const label = `Dividends received per month from ${rows[0]?.label ?? ''} to ${last?.label ?? ''}, ${include ? 'with forecast bars and a trend line' : 'forecast hidden'}. ${scope}`.trim();
  const points = visiblePoints(timeline, include);
  const table = tableRows(points, ccy);
  return (
    <>
      <ForecastBlock timeline={timeline} ccy={ccy} forecast={forecast} />
      <SelectableLegend entries={growthLegendEntries(items, c)} selection={selection} testId="growth-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame label={label} testId="growth-timeline-chart" scrollToEnd bars={Math.ceil(rows.length / 2)} height="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={8} />
              <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<TimelineTooltip ccy={ccy} c={c} />} />
              {selection.isSeriesVisible('received') && <Bar dataKey="received" stackId="t" fill={c.received} isAnimationActive={false} />}
              {selection.isSeriesVisible('declared') && <Bar dataKey="declared" stackId="t" fill={c.declared} stroke={c.declaredEdge} isAnimationActive={false} />}
              {selection.isSeriesVisible('estimated') && <Bar dataKey="estimated" stackId="t" fill={c.estimated} stroke={c.estimatedEdge} strokeDasharray="4 3" radius={[3, 3, 0, 0]} isAnimationActive={false} />}
              {selection.isSeriesVisible('average') && <Line dataKey="average" type="monotone" stroke={c.invested} strokeWidth={2} dot={false} isAnimationActive={false} />}
              {selection.isSeriesVisible('trend') && <Line dataKey="trend" stroke={c.value} strokeWidth={2} dot={false} isAnimationActive={false} />}
              {selection.isSeriesVisible('projection') && <Line dataKey="projection" stroke={c.value} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      {children}
      <TrendMethod />
      <SelectableDataTable
        caption="Dividends received, forecast and trend per month"
        rowHeader="Period"
        columns={TIMELINE_COLUMNS}
        selection={selection}
        rows={points.map((p, i) => ({ id: p.month, header: table[i]![0]!, cells: table[i]!.slice(1) }))}
      />
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
