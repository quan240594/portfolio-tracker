import { Bar, CartesianGrid, ComposedChart, LabelList, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { incomeColours, type IncomeColours } from '../calendar/calendarColours';
import { StatusAmounts, TooltipShell } from '../calendar/IncomeTooltip';
import { ChartDataTable, ChartFrame, SLOT_PX, useDividendTheme } from './chartParts';
import { FutureLegend } from './GrowthAndFuture';
import { averageReceived, chartRows, niceAxis, periodText, timelineTotals, upcomingBand, type ChartRow, type TimelinePeriod } from './receivedFuture';
import type { Granularity } from './receivedSeries';

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
      <StatusAmounts row={row} currency={currency} colours={colours} border={border} />
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

/** The legend sits under the scrolling chart, not in it, so it stays centred in the card. */
const STATUS_ENTRIES = [{ value: 'paid' }, { value: 'declared' }, { value: 'estimated' }];
const legendEntries = (withAverage: boolean) => (withAverage ? [...STATUS_ENTRIES, { value: 'avg' }] : STATUS_ENTRIES);

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
}

/** Spells out what the dashed "avg" line is (or why there is none). */
export function AverageNote({ average, currency, granularity }: Readonly<AverageNoteProps>) {
  const unit = UNIT_NAMES[granularity];
  return (
    <p className="muted mt-1 text-xs" data-testid="received-average-note">
      {average === null
        ? `No completed ${unit} yet, so there is no average line.`
        : `The dashed line (avg) is the average received per completed ${unit} in this view: ${formatMoney(average, currency)}. The ${unit} in progress and the upcoming ones are not counted.`}
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

function timelineLabel({ periods, currency, granularity, upcoming: next }: TimelineProps, average: number | null): string {
  const received = `${formatMoney(timelineTotals(periods).paid, currency)} received`;
  const upcoming = next ? `, ${formatMoney(next.total, currency)} upcoming (${formatMoney(next.declared, currency)} declared, ${formatMoney(next.estimated, currency)} estimated)` : '';
  const avg = average === null ? '' : `, average ${formatMoney(average, currency)} received per completed ${UNIT_NAMES[granularity]}`;
  return `Dividends received over time: ${periods.length} bars, ${received}${upcoming}${avg}.`;
}

/** Stacked bars per month / quarter / year: received so far, declared and estimated income, with value labels, an "avg" line and a table alternative. */
export function ReceivedTimeline(props: Readonly<TimelineProps>) {
  const { periods, currency, granularity } = props;
  const withFuture = props.upcoming !== undefined;
  const { theme } = useTheme();
  const c = useDividendTheme();
  const colours = incomeColours(theme);
  const average = averageReceived(periods);
  const band = withFuture ? upcomingBand(periods) : null;
  const rows = chartRows(periods, currency, SLOT_PX);
  const scale = niceAxis(Math.max(average ?? 0, ...periods.map((p) => p.total)));
  const tooltip = <ReceivedFutureTooltip currency={currency} colours={colours} background={c.tooltipBg} border={c.tooltipBorder} text={c.text} withFuture={withFuture} />;
  return (
    <>
      <ChartFrame label={timelineLabel(props, average)} testId="received-time-chart" bars={periods.length} height="h-72" focusBar={periods.findIndex((p) => p.phase === 'current')} axis={<FixedAxis rows={rows} scale={scale} currency={currency} />}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: CHART_MARGIN_TOP, right: 34, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={2} />
            <YAxis hide domain={[0, scale.max]} ticks={scale.ticks} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={tooltip} />
            {band && <ReferenceArea x1={band.from} x2={band.to} fill={c.grid} fillOpacity={0.45} stroke={c.axis} strokeOpacity={0.5} strokeDasharray="3 3" label={<UpcomingLabel fill={c.text} />} />}
            <Bar dataKey="paid" stackId="income" fill={colours.paid.fill} stroke={colours.paid.stroke} strokeWidth={1} isAnimationActive={false} />
            {withFuture && <Bar dataKey="declared" stackId="income" fill={colours.declared.fill} stroke={colours.declared.stroke} strokeWidth={1} isAnimationActive={false} />}
            {withFuture && <Bar dataKey="estimated" stackId="income" fill={colours.estimated.fill} stroke={colours.estimated.stroke} strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} />}
            <Line dataKey="total" stroke="none" dot={false} activeDot={false} legendType="none" tooltipType="none" isAnimationActive={false}>
              <LabelList dataKey="barLabel" position="top" fill={c.text} fontSize={10} stroke={c.tooltipBg} strokeWidth={3} style={LABEL_HALO} />
            </Line>
            {average !== null && <ReferenceLine y={average} stroke={c.text} strokeDasharray="5 4" label={{ value: 'avg', position: 'right', fill: c.text, fontSize: 11 }} />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      {withFuture && <FutureLegend c={c} payload={legendEntries(average !== null)} />}
      <AverageNote average={average} currency={currency} granularity={granularity} />
      <TimelineTable periods={periods} currency={currency} withFuture={withFuture} />
    </>
  );
}

/** The chart's numbers as a table: future rows are named in words ("Upcoming", "Current"), not only coloured. */
export function TimelineTable({ periods, currency, withFuture }: Readonly<{ periods: readonly TimelinePeriod[]; currency: string; withFuture: boolean }>) {
  const money = (v: number) => formatMoney(v, currency);
  return withFuture ? (
    <ChartDataTable
      caption="Dividends received and upcoming per period"
      columns={['Period', 'Received', 'Declared', 'Estimated', 'Total']}
      rows={periods.map((p) => [periodText(p, true), money(p.paid), money(p.declared), money(p.estimated), money(p.total)])}
    />
  ) : (
    <ChartDataTable caption="Dividends received per period" columns={['Period', 'Received']} rows={periods.map((p) => [p.label, money(p.paid)])} />
  );
}
