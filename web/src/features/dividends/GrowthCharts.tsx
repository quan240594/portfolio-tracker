import { useMemo, type ReactElement, type ReactNode } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsDividendGrowthResponse, ForecastTotals, GrowthTimeline } from '@portfolio/shared';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import {
  NothingSelected,
  SelectableDataTable,
  SelectableLegend,
  focusOpacity,
  maskSeries,
  selectRows,
  useSeriesSelection,
  type SelectableColumn,
  type SelectableRow,
} from '../../components/charts/selection';
import { ChartFrame, DataGrid, useDividendTheme } from './chartParts';
import { DECLARED_LABEL, ESTIMATED_LABEL } from './forecastLabels';
import {
  TABLE_COLUMNS,
  declaredKey,
  estimatedKey,
  forecastLabel,
  summaryItems,
  tableRows,
  timelineLegendItems,
  timelineRows,
  selectYearRows,
  visiblePoints,
  yearBarEntries,
  yearBarVisible,
  yearForecastModel,
  yearLegendItems,
  type YearForecastModel,
} from './growthForecast';
import { ForecastSummary, GrowthLegendNote, TimelineTooltip, TrendMethod, TrendNote, YearTooltip, growthLegendEntries } from './GrowthForecastParts';

type Theme = ReturnType<typeof useDividendTheme>;

/** Colour of a year, newest first: the current year stands out, earlier years fade. */
export function yearColour(c: Theme, years: readonly string[], year: string): string {
  return [c.received, c.base, c.previous][years.length - 1 - years.indexOf(year)]!;
}

/** Taller than the other dividend charts: the grouped bars and the forecast need the room. */
const CHART_HEIGHT = 'h-80 md:h-[22rem]';

const cell = (value: number | string | undefined, currency: string): string => (typeof value === 'number' ? formatMoney(value, currency) : '—');

/**
 * Bars of the grouped chart: per year its received bar with the declared and estimated forecast stacked on top. Bars that are excluded are left out, the top one of each stack gets the rounded corners.
 * `focusKey` = the legend entry being previewed: the bars that do not belong to it fade.
 */
export function yearBars(model: YearForecastModel, c: Theme, isDrawn: (dataKey: string) => boolean = () => true, focusKey: string | null = null): ReactElement[] {
  return model.bars.flatMap((year) => {
    const stacked = model.forecastYears.includes(year);
    const specs: { key: string; fill: string; stroke?: string; dash?: string }[] = [];
    if (model.years.includes(year)) specs.push({ key: year, fill: yearColour(c, model.years, year) });
    if (stacked) {
      specs.push({ key: declaredKey(year), fill: c.declared, stroke: c.declaredEdge }, { key: estimatedKey(year), fill: c.estimated, stroke: c.estimatedEdge, dash: '4 3' });
    }
    const drawn = specs.filter((spec) => isDrawn(spec.key));
    return drawn.map((spec, i) => {
      const opacity = focusOpacity(focusKey, yearBarEntries(spec.key));
      return (
        <Bar
          key={spec.key}
          dataKey={spec.key}
          stackId={year}
          fill={spec.fill}
          fillOpacity={opacity}
          stroke={spec.stroke}
          strokeOpacity={opacity}
          strokeDasharray={spec.dash}
          radius={i === drawn.length - 1 ? [3, 3, 0, 0] : undefined}
          isAnimationActive={false}
        />
      );
    });
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
  const full = useMemo(() => yearForecastModel(data.byMonth, timeline, include), [data.byMonth, timeline, include]);
  const colorOf = (year: string) => yearColour(c, full.years, year);
  const items = yearLegendItems(full, colorOf);
  const selection = useSeriesSelection(
    items.map((i) => i.key),
    full.rows.map((r) => r.month),
  );
  const { isSeriesVisible, isRowVisible, hiddenSeries } = selection;
  const isDrawn = useMemo(() => yearBarVisible(isSeriesVisible), [isSeriesVisible]);
  // the hover preview re-renders this card on every move: the model and the rows are only rebuilt when the selection or the data change
  const model = useMemo(
    () =>
      yearForecastModel(
        data.byMonth,
        timeline,
        include,
        3,
        full.years.filter((y) => hiddenSeries.has(y)),
      ),
    [data.byMonth, timeline, include, full.years, hiddenSeries],
  );
  const rows = useMemo(() => selectYearRows(model.rows, isRowVisible, isDrawn), [model.rows, isRowVisible, isDrawn]);
  const shownYears = model.years.filter((y) => isSeriesVisible(y));
  const totals = shownYears.map((y) => `${y}: ${formatMoney(data.byYear.find((b) => b.year === y)?.total ?? 0, ccy)}`).join(', ');
  const totalsShown = include ? forecast : null;
  const summary = selection.hasHidden ? 'Current selection.' : forecastLabel(timeline, ccy, totalsShown);
  const average = model.hasAverage && isDrawn('average') ? ' The dashed line is the average of the years.' : '';
  const forecastNote = model.forecastYears.length > 0 ? ` Forecast bars (declared and estimated) are stacked on the received amounts for ${model.forecastYears.join(' and ')}.` : '';
  const label = `Dividends received per calendar month, compared for ${shownYears.join(', ')}. Totals per year: ${totals}.${forecastNote}${average} ${summary}`.trim();
  const ahead = timeline.points.filter((p) => p.phase !== 'PAST');
  // the average is context, not the message: a thin dashed line without markers, so the bars dominate
  const averageOpacity = focusOpacity(selection.focusKey, 'average');
  return (
    <>
      <ForecastBlock timeline={timeline} ccy={ccy} forecast={forecast} />
      <SelectableLegend entries={growthLegendEntries(items, c)} selection={selection} testId="growth-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame label={label} testId="year-compare-chart" bars={Math.ceil(rows.length * (model.forecastYears.length > 0 ? 1.5 : 1))} height={CHART_HEIGHT}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={4} barCategoryGap="22%">
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="month" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
              <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<YearTooltip model={model} ccy={ccy} c={c} colorOf={colorOf} />} />
              {yearBars(model, c, isDrawn, selection.focusKey)}
              {model.hasAverage && isDrawn('average') && <Line dataKey="average" stroke={c.invested} strokeWidth={1.25} strokeOpacity={averageOpacity} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      {children}
      <GrowthLegendNote items={items} />
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
  { key: 'declared', label: DECLARED_LABEL },
  { key: 'estimated', label: ESTIMATED_LABEL },
  { key: 'trend', label: 'Trend' },
];

/** Bars and lines of the timeline, in drawing order; the ones that do not belong to the previewed legend entry fade. */
export function timelineSeries(c: Theme, isDrawn: (key: string) => boolean, focusKey: string | null): ReactElement[] {
  const fade = (key: string) => focusOpacity(focusKey, key);
  const series: ReactElement[] = [];
  if (isDrawn('received')) series.push(<Bar key="received" dataKey="received" stackId="t" fill={c.received} fillOpacity={fade('received')} isAnimationActive={false} />);
  if (isDrawn('declared')) series.push(<Bar key="declared" dataKey="declared" stackId="t" fill={c.declared} fillOpacity={fade('declared')} stroke={c.declaredEdge} strokeOpacity={fade('declared')} isAnimationActive={false} />);
  if (isDrawn('estimated')) {
    series.push(
      <Bar key="estimated" dataKey="estimated" stackId="t" fill={c.estimated} fillOpacity={fade('estimated')} stroke={c.estimatedEdge} strokeOpacity={fade('estimated')} strokeDasharray="4 3" radius={[3, 3, 0, 0]} isAnimationActive={false} />,
    );
  }
  if (isDrawn('average')) series.push(<Line key="average" dataKey="average" type="monotone" stroke={c.invested} strokeWidth={2} strokeOpacity={fade('average')} dot={false} isAnimationActive={false} />);
  if (isDrawn('trend')) series.push(<Line key="trend" dataKey="trend" stroke={c.value} strokeWidth={2} strokeOpacity={fade('trend')} dot={false} isAnimationActive={false} />);
  if (isDrawn('projection')) series.push(<Line key="projection" dataKey="projection" stroke={c.value} strokeWidth={2} strokeOpacity={fade('projection')} strokeDasharray="6 4" dot={false} isAnimationActive={false} />);
  return series;
}

/**
 * One chronological series: received bars, forecast bars to the right, the 12-month average and the trend.
 * Series = received / declared / estimated bars and the average, trend and projected-trend lines; rows = the months.
 * The average and the trend always describe the whole history: hiding months only removes their points from view.
 */
export function TimelineChart({ data, timeline, showForecast, forecast, children }: Readonly<ChartProps>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const include = showForecast && forecast !== null;
  const all = useMemo(() => timelineRows(timeline, include), [timeline, include]);
  const items = useMemo(() => timelineLegendItems(all, c.received), [all, c.received]);
  const keys = useMemo(() => items.map((i) => i.key), [items]);
  const selection = useSeriesSelection(
    keys,
    all.map((r) => r.month),
  );
  const { isSeriesVisible, isRowVisible } = selection;
  // the hover preview re-renders this card on every move: the rows are only rebuilt when the selection or the data change
  const rows = useMemo(() => {
    const view = { isSeriesVisible, isRowVisible };
    return selectRows(all, (r) => r.month, view).map((r) => maskSeries(r, keys, view));
  }, [all, keys, isSeriesVisible, isRowVisible]);
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
        <ChartFrame label={label} testId="growth-timeline-chart" scrollToEnd bars={Math.ceil(rows.length / 2)} height={CHART_HEIGHT}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={8} />
              <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={<TimelineTooltip ccy={ccy} c={c} />} />
              {timelineSeries(c, selection.isSeriesVisible, selection.focusKey)}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      {children}
      <GrowthLegendNote items={items} />
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
  const items = summaryItems(timeline, ccy, forecast);
  return (
    <>
      <ForecastSummary items={items} />
      {timeline.trend === null && <TrendNote />}
    </>
  );
}
