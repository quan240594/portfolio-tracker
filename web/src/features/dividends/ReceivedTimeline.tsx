import { useMemo, type ReactElement } from 'react';
import { Bar, CartesianGrid, ComposedChart, LabelList, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { incomeColours, type IncomeColours } from '../calendar/calendarColours';
import { StatusAmounts, TooltipShell } from '../calendar/IncomeTooltip';
import {
  LegendSwatch,
  NothingSelected,
  SelectableDataTable,
  SelectableLegend,
  focusOpacity,
  useSeriesSelection,
  type LegendEntry,
  type SelectableColumn,
  type SeriesSelection,
} from '../../components/charts/selection';
import { ChartFrame, SLOT_PX, useDividendTheme } from './chartParts';
import { ForecastNote } from './ForecastNote';
import { DECLARED_LABEL, ESTIMATED_LABEL, STATUS_NOTE } from './forecastLabels';
import { STATUS_SERIES, averageReceived, chartRows, niceAxis, periodRowId, periodText, selectPeriods, timelineTotals, upcomingBand, type ChartRow, type TimelinePeriod } from './receivedFuture';
import type { Granularity } from './receivedSeries';

/** The forecast statuses are named by where they come from; the calendar keeps the short names. */
const STATUS_NAMES = { declared: DECLARED_LABEL, estimated: ESTIMATED_LABEL } as const;

const UNIT_NAMES: Readonly<Record<Granularity, string>> = { month: 'month', quarter: 'quarter', year: 'year' };

/** Holdings listed in the tooltip before "+ n more". */
const TOOLTIP_HOLDINGS = 6;

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: ChartRow }[];
  currency: string;
  colours: IncomeColours;
  background: string;
  border: string;
  text: string;
  /** Whether the future is part of the chart (then the phase of the period is named). */
  withFuture: boolean;
}

function HoldingList({ row, currency, border }: Readonly<{ row: ChartRow; currency: string; border: string }>) {
  if (row.holdings.length === 0) return null;
  const shown = row.holdings.slice(0, TOOLTIP_HOLDINGS);
  const more = row.holdings.length - shown.length;
  return (
    <div className="mt-1.5 border-t pt-1.5" style={{ borderColor: border }}>
      <p className="m-0 mb-0.5 font-semibold">By holding</p>
      <ul className="m-0 list-none p-0" data-testid="received-future-tooltip-holdings">
        {shown.map((h) => (
          <li key={h.symbol} className="flex justify-between gap-4">
            <span>{h.symbol}</span>
            <span className="tabular-nums">{formatMoney(h.amount, currency)}</span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="m-0 mt-0.5">+ {more} more</p>}
    </div>
  );
}

/** Tooltip of one period: the phase in words, the amount per status with the total, and the holdings behind it. */
export function ReceivedFutureTooltip({ active, payload, currency, colours, background, border, text, withFuture }: Readonly<TooltipProps>) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <TooltipShell title={periodText(row, withFuture)} testId="received-future-tooltip" background={background} border={border} text={text}>
      <StatusAmounts row={row} currency={currency} colours={colours} border={border} names={STATUS_NAMES} />
      <HoldingList row={row} currency={currency} border={border} />
    </TooltipShell>
  );
}

interface UpcomingLabelProps {
  viewBox?: { x?: number; y?: number };
  fill: string;
}

/** "Upcoming" in text above the shaded band, in the top margin clear of the value labels. */
export function UpcomingLabel({ viewBox, fill }: Readonly<UpcomingLabelProps>) {
  return (
    <text x={(viewBox?.x ?? 0) + 6} y={(viewBox?.y ?? 0) - 24} fill={fill} fontSize={11} fontWeight={600}>
      Upcoming
    </text>
  );
}

const CHART_MARGIN_TOP = 36;

/** Paints the label's outline behind its fill: a halo in the card colour keeps it readable where the avg line crosses it. */
const LABEL_HALO = { paintOrder: 'stroke' } as const;

interface FixedAxisProps {
  rows: readonly ChartRow[];
  scale: ReturnType<typeof niceAxis>;
  currency: string;
}

/** The value axis, kept outside the scrolling bars: same data, margins and scale as the chart next to it, with nothing else drawn. */
export function FixedAxis({ rows, scale, currency }: Readonly<FixedAxisProps>) {
  const c = useDividendTheme();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows as ChartRow[]} margin={{ top: CHART_MARGIN_TOP, right: 0, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" tick={false} tickLine={false} axisLine={false} />
        <YAxis domain={[0, scale.max]} ticks={scale.ticks} tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

interface AverageNoteProps {
  average: number | null;
  currency: string;
  granularity: Granularity;
  /** The chart shows a selection: say so, the average then covers the periods that are included. */
  filtered?: boolean;
}

/** Spells out what the dashed "avg" line is (or why there is none). */
export function AverageNote({ average, currency, granularity, filtered = false }: Readonly<AverageNoteProps>) {
  const unit = UNIT_NAMES[granularity];
  const view = filtered ? 'the current selection' : 'this view';
  const none = filtered ? 'in the current selection' : 'yet';
  return (
    <p className="muted mt-1 text-xs" data-testid="received-average-note">
      {average === null
        ? `No completed ${unit} ${none}, so there is no average line.`
        : `The dashed line (avg) is the average received per completed ${unit} in ${view}: ${formatMoney(average, currency)}. The ${unit} in progress and the upcoming ones are not counted.`}
    </p>
  );
}

/** The overview's own totals of the next 12 months, i.e. the figures of the Future payments card. */
export interface UpcomingSummary {
  total: number;
  declared: number;
  estimated: number;
}

export interface TimelineProps {
  periods: readonly TimelinePeriod[];
  currency: string;
  granularity: Granularity;
  /** Set when the upcoming payments are part of the chart; its totals go in the chart's accessible label. */
  upcoming?: UpcomingSummary;
}

function timelineLabel({ periods, currency, granularity, upcoming: next }: TimelineProps, average: number | null, filtered: boolean): string {
  const received = `${formatMoney(timelineTotals(periods).paid, currency)} received`;
  const upcoming = next && !filtered ? `, ${formatMoney(next.total, currency)} upcoming (${formatMoney(next.declared, currency)} declared, ${formatMoney(next.estimated, currency)} estimated)` : '';
  const avg = average === null ? '' : `, average ${formatMoney(average, currency)} received per completed ${UNIT_NAMES[granularity]}`;
  return `Dividends received over time${filtered ? ', current selection' : ''}: ${periods.length} bars, ${received}${upcoming}${avg}.`;
}

/** Legend entries of the stacked bars and the average line; the swatches repeat the colours of the chart. */
function legendEntriesOf(colours: IncomeColours, lineColour: string, withFuture: boolean, withAverage: boolean): LegendEntry[] {
  const entries: LegendEntry[] = [{ key: 'paid', label: 'Received', swatch: <LegendSwatch color={colours.paid.fill} edge={colours.paid.stroke} /> }];
  if (withFuture) {
    entries.push(
      { key: 'declared', label: DECLARED_LABEL, swatch: <LegendSwatch color={colours.declared.fill} edge={colours.declared.stroke} /> },
      { key: 'estimated', label: ESTIMATED_LABEL, swatch: <LegendSwatch color={colours.estimated.fill} edge={colours.estimated.stroke} dashed /> },
    );
  }
  if (withAverage) entries.push({ key: 'avg', label: 'avg', swatch: <LegendSwatch shape="line" color={lineColour} dashed /> });
  return entries;
}

/** The value labels above the stacks describe the whole stack, not one status: they only fade (less than the bars) while a legend entry is previewed. */
const LABEL_FADE = 0.5;

/** Stroke width and dash of a status bar: estimated has a dashed edge, so it is not told apart by colour alone. */
const STATUS_EDGE: Readonly<Record<(typeof STATUS_SERIES)[number], { width: number; dash?: string }>> = {
  paid: { width: 1 },
  declared: { width: 1 },
  estimated: { width: 1.5, dash: '4 2' },
};

/** The stacked bars that are drawn, in stacking order; the ones that do not belong to the previewed legend entry fade. */
export function statusBars(colours: IncomeColours, withFuture: boolean, isDrawn: (key: string) => boolean, focusKey: string | null): ReactElement[] {
  return STATUS_SERIES.filter((key) => (key === 'paid' || withFuture) && isDrawn(key)).map((key) => {
    const opacity = focusOpacity(focusKey, key);
    return (
      <Bar
        key={key}
        dataKey={key}
        stackId="income"
        fill={colours[key].fill}
        fillOpacity={opacity}
        stroke={colours[key].stroke}
        strokeOpacity={opacity}
        strokeWidth={STATUS_EDGE[key].width}
        strokeDasharray={STATUS_EDGE[key].dash}
        isAnimationActive={false}
      />
    );
  });
}

/** The series the selection controls: the status bars on the axis and the average line (when there is one). */
const seriesKeysOf = (withFuture: boolean, withAverage: boolean): string[] => [...(withFuture ? STATUS_SERIES : (['paid'] as const)), ...(withAverage ? ['avg'] : [])];

/** Stacked bars per month / quarter / year: received so far, declared and estimated income, with value labels, an "avg" line and a table alternative. Columns = the statuses and the avg line, rows = the periods. */
export function ReceivedTimeline(props: Readonly<TimelineProps>) {
  const { periods, currency, granularity } = props;
  const withFuture = props.upcoming !== undefined;
  const { theme } = useTheme();
  const c = useDividendTheme();
  const colours = incomeColours(theme);
  const fullAverage = averageReceived(periods);
  const selection = useSeriesSelection(
    seriesKeysOf(withFuture, fullAverage !== null),
    periods.map((p) => periodRowId(granularity, p)),
  );
  const { isRowVisible, isSeriesVisible } = selection;
  // the hover preview re-renders this card on every move: the periods and the rows are only rebuilt when the selection or the data change
  const shown = useMemo(() => selectPeriods(periods, (p) => periodRowId(granularity, p), { isRowVisible, isSeriesVisible }), [periods, granularity, isRowVisible, isSeriesVisible]);
  const average = selection.hasHidden ? averageReceived(shown) : fullAverage;
  const showAverage = average !== null && selection.isSeriesVisible('avg');
  const band = withFuture ? upcomingBand(shown) : null;
  const rows = useMemo(() => chartRows(shown, currency, SLOT_PX), [shown, currency]);
  const scale = niceAxis(Math.max(showAverage ? average : 0, ...shown.map((p) => p.total)));
  const avgOpacity = focusOpacity(selection.focusKey, 'avg');
  const tooltip = <ReceivedFutureTooltip currency={currency} colours={colours} background={c.tooltipBg} border={c.tooltipBorder} text={c.text} withFuture={withFuture} />;
  return (
    <>
      <SelectableLegend entries={legendEntriesOf(colours, c.text, withFuture, fullAverage !== null)} selection={selection} testId="received-legend" />
      {withFuture && <ForecastNote text={STATUS_NOTE} testId="received-legend-note" />}
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame
          label={timelineLabel({ ...props, periods: shown }, showAverage ? average : null, selection.hasHidden)}
          testId="received-time-chart"
          bars={shown.length}
          height="h-72"
          focusBar={shown.findIndex((p) => p.phase === 'current')}
          axis={<FixedAxis rows={rows} scale={scale} currency={currency} />}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: CHART_MARGIN_TOP, right: 34, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={2} />
              <YAxis hide domain={[0, scale.max]} ticks={scale.ticks} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={tooltip} />
              {band && <ReferenceArea x1={band.from} x2={band.to} fill={c.grid} fillOpacity={0.45} stroke={c.axis} strokeOpacity={0.5} strokeDasharray="3 3" label={<UpcomingLabel fill={c.text} />} />}
              {statusBars(colours, withFuture, selection.isSeriesVisible, selection.focusKey)}
              <Line dataKey="total" stroke="none" dot={false} activeDot={false} legendType="none" tooltipType="none" isAnimationActive={false}>
                <LabelList dataKey="barLabel" position="top" fill={c.text} opacity={selection.focusKey === null ? 1 : LABEL_FADE} fontSize={10} stroke={c.tooltipBg} strokeWidth={3} style={LABEL_HALO} />
              </Line>
              {showAverage && <ReferenceLine y={average} stroke={c.text} strokeOpacity={avgOpacity} strokeDasharray="5 4" label={{ value: 'avg', position: 'right', fill: c.text, fontSize: 11, opacity: avgOpacity }} />}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      <AverageNote average={showAverage ? average : null} currency={currency} granularity={granularity} filtered={selection.hasHidden} />
      <TimelineTable periods={periods} currency={currency} withFuture={withFuture} granularity={granularity} selection={selection} />
    </>
  );
}

interface TableProps {
  periods: readonly TimelinePeriod[];
  currency: string;
  withFuture: boolean;
  granularity: Granularity;
  selection: SeriesSelection;
}

const STATUS_COLUMNS: SelectableColumn[] = [
  { key: 'paid', label: 'Received' },
  { key: 'declared', label: DECLARED_LABEL },
  { key: 'estimated', label: ESTIMATED_LABEL },
  { key: 'total', label: 'Total', selectable: false },
];
const RECEIVED_COLUMNS: SelectableColumn[] = [{ key: 'paid', label: 'Received' }];

/** The chart's numbers as a table: future rows are named in words ("Upcoming", "Current"), not only coloured. The Total column is the whole period, not a series. */
export function TimelineTable({ periods, currency, withFuture, granularity, selection }: Readonly<TableProps>) {
  const money = (v: number) => formatMoney(v, currency);
  return (
    <SelectableDataTable
      caption={withFuture ? 'Dividends received and upcoming per period' : 'Dividends received per period'}
      rowHeader="Period"
      columns={withFuture ? STATUS_COLUMNS : RECEIVED_COLUMNS}
      selection={selection}
      rows={periods.map((p) => ({
        id: periodRowId(granularity, p),
        header: periodText(p, withFuture),
        cells: withFuture ? [money(p.paid), money(p.declared), money(p.estimated), money(p.total)] : [money(p.paid)],
      }))}
    />
  );
}
