import { useMemo, type ReactElement } from 'react';
import { Bar, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CalendarMonth, CalendarSummary } from '@portfolio/shared';
import { KpiCard } from '../../components/KpiCard';
import { chartTheme } from '../../components/charts/palette';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatMoney, formatMonth, formatPercent } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import {
  focusOpacity,
  LegendSwatch,
  NothingSelected,
  SelectableDataTable,
  SelectableLegend,
  useSeriesSelection,
  type LegendEntry,
  type SelectableColumn,
} from '../../components/charts/selection';
import { incomeColours, type IncomeColours } from './calendarColours';
import { IncomeTooltip } from './IncomeTooltip';
import { INCOME_SERIES, incomeRows, selectMonths, selectedAverage, seriesName, useNarrowScreen, type IncomeRow, type IncomeSeries } from './incomeChartModel';

export function CalendarKpis({ summary, currency, loading }: Readonly<{ summary?: CalendarSummary; currency: string; loading: boolean }>) {
  // Two tiles per row, except in the third-width card of the grid (from `lg`) when it is too narrow for a money amount at the tile's size.
  return (
    <div className="@container">
      <div className="grid h-full grid-cols-2 gap-3 lg:@max-sm:grid-cols-1">
        <KpiCard loading={loading} label="Annual income" value={summary && formatMoney(summary.annualIncome, currency)} hint="Next 12 months, net" />
        <KpiCard loading={loading} label="Monthly average" value={summary && formatMoney(summary.monthlyAverage, currency)} hint="Annual income ÷ 12" />
        <KpiCard loading={loading} label="Daily average" value={summary && formatMoney(summary.dailyAverage, currency)} hint="Annual income ÷ 365" />
        <KpiCard loading={loading} label="Yield" value={summary && formatPercent(summary.yieldPct)} hint={summary && `${formatPercent(summary.yieldOnCostPct)} on cost`} />
      </div>
    </div>
  );
}

interface BarsProps {
  rows: readonly IncomeRow[];
  average: number;
  currency: string;
  statuses: readonly IncomeSeries[];
  label: string;
  /** The legend entry being previewed (hover / keyboard focus), or null. */
  focusKey: string | null;
}

/** The value labels above the bars describe the whole stack, not one status: they only fade (less than the bars) while a legend entry is previewed. */
const LABEL_FADE = 0.5;

/** Stroke width and dash of a status bar: estimated has a dashed edge, so it is not told apart by colour alone. */
const STATUS_EDGE: Readonly<Record<IncomeSeries, { width: number; dash?: string }>> = {
  paid: { width: 1 },
  declared: { width: 1 },
  estimated: { width: 1.5, dash: '4 2' },
};

/** The stacked bars of the statuses that are included, in stacking order; the ones that do not belong to the previewed legend entry fade. */
export function incomeBars(colours: IncomeColours, statuses: readonly IncomeSeries[], focusKey: string | null): ReactElement[] {
  return INCOME_SERIES.filter((key) => statuses.includes(key)).map((key) => {
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

/** The stacked bars of the statuses that are included, their value labels and the dashed average line; the axis follows the data left. */
function IncomeBars({ rows, average, currency, statuses, label, focusKey }: Readonly<BarsProps>) {
  const { theme } = useTheme();
  const c = chartTheme(theme);
  const colours = incomeColours(theme);
  const avgOpacity = focusOpacity(focusKey, 'avg');
  const tooltip = <IncomeTooltip currency={currency} colours={colours} background={c.tooltipBg} border={c.tooltipBorder} text={c.text} statuses={statuses} />;
  return (
    <div role="img" aria-label={label} className="chart-focus h-72 w-full" data-testid="calendar-income-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows as IncomeRow[]} margin={{ top: 22, right: 30, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={formatMonth} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={tooltip} />
          {incomeBars(colours, statuses, focusKey)}
          <Line dataKey="total" stroke="none" dot={false} activeDot={false} legendType="none" tooltipType="none" isAnimationActive={false}>
            <LabelList dataKey="label" position="top" fill={c.text} opacity={focusKey === null ? 1 : LABEL_FADE} fontSize={10} />
          </Line>
          <ReferenceLine y={average} stroke={c.text} strokeOpacity={avgOpacity} strokeDasharray="5 4" label={{ value: 'avg', position: 'right', fill: c.text, fontSize: 11, opacity: avgOpacity }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Legend entries: the three statuses toggle, the dashed average line is a plain key (it has no state of its own). */
function legendEntries(colours: IncomeColours, lineColour: string): LegendEntry[] {
  return [
    { key: 'paid', label: seriesName('paid'), swatch: <LegendSwatch color={colours.paid.fill} edge={colours.paid.stroke} /> },
    { key: 'declared', label: seriesName('declared'), swatch: <LegendSwatch color={colours.declared.fill} edge={colours.declared.stroke} /> },
    { key: 'estimated', label: seriesName('estimated'), swatch: <LegendSwatch color={colours.estimated.fill} edge={colours.estimated.stroke} dashed /> },
    { key: 'avg', label: 'avg', swatch: <LegendSwatch shape="line" color={lineColour} dashed />, toggleable: false },
  ];
}

const INCOME_COLUMNS: SelectableColumn[] = [...INCOME_SERIES.map((key) => ({ key, label: seriesName(key) })), { key: 'total', label: 'Total', selectable: false }];

function incomeLabel(shown: readonly CalendarMonth[], average: number, currency: string, filtered: boolean): string {
  const total = formatMoney(shown.reduce((s, m) => s + m.total, 0), currency);
  const scope = filtered ? ', current selection' : ` over ${shown.length} months`;
  return `Dividend income per month${scope}: ${total} in total, ${formatMoney(average, currency)} on average.`;
}

/** Income by month, stacked: received (green), declared (blue) and estimated (yellow, dashed outline); dashed average line. Legend and data table include/exclude statuses and months. */
export function IncomeChart({ monthly, average, currency }: Readonly<{ monthly: readonly CalendarMonth[]; average: number; currency: string }>) {
  const { theme } = useTheme();
  const narrow = useNarrowScreen();
  const c = chartTheme(theme);
  const selection = useSeriesSelection(
    INCOME_SERIES,
    monthly.map((m) => m.month),
  );
  const { isRowVisible, isSeriesVisible } = selection;
  // the hover preview re-renders this card on every move: the months are only rebuilt when the selection or the data change
  const shown = useMemo(() => selectMonths(monthly, { isRowVisible, isSeriesVisible }), [monthly, isRowVisible, isSeriesVisible]);
  const rows = useMemo(() => incomeRows(shown, currency, narrow), [shown, currency, narrow]);
  const shownAverage = selectedAverage(shown, average, selection.hasHidden);
  const statuses = INCOME_SERIES.filter((key) => selection.isSeriesVisible(key));
  return (
    <figure className="m-0">
      <SelectableLegend entries={legendEntries(incomeColours(theme), c.text)} selection={selection} label="Income legend" testId="calendar-income-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <IncomeBars rows={rows} average={shownAverage} currency={currency} statuses={statuses} label={incomeLabel(shown, shownAverage, currency, selection.hasHidden)} focusKey={selection.focusKey} />
      )}
      <figcaption className="sr-only">Dividend income per month</figcaption>
      <SelectableDataTable
        caption="Dividend income per month"
        rowHeader="Month"
        columns={INCOME_COLUMNS}
        selection={selection}
        rows={monthly.map((m) => ({
          id: m.month,
          header: formatMonth(m.month),
          cells: [formatMoney(m.paid, currency), formatMoney(m.declared, currency), formatMoney(m.estimated, currency), formatMoney(m.total, currency)],
        }))}
      />
    </figure>
  );
}

export function IncomeChartCard({ monthly, summary, currency, loading }: Readonly<{ monthly?: readonly CalendarMonth[]; summary?: CalendarSummary; currency: string; loading: boolean }>) {
  return (
    <section className="card p-4" aria-labelledby="calendar-income">
      <h2 id="calendar-income" className="mb-3 font-semibold">
        Income per month
      </h2>
      {loading || !monthly || !summary ? (
        <LoadingRegion label="Loading chart">
          <Skeleton className="h-64 w-full" />
        </LoadingRegion>
      ) : (
        <IncomeChart monthly={monthly} average={summary.monthlyAverage} currency={currency} />
      )}
    </section>
  );
}

export function CoverageNotes({ earnings, corporateActions }: Readonly<{ earnings?: string; corporateActions?: string }>) {
  return (
    <details className="card p-4 text-sm">
      <summary className="cursor-pointer font-medium">What does this calendar cover?</summary>
      <ul className="muted mt-3 list-disc space-y-2 pl-5">
        <li>Ex-dividend and payment dates come from your market data provider and are re-checked on a rotating daily budget, so a newly declared dividend can take a few days to appear.</li>
        <li>Dates marked “Estimated” are projections from your own payment history (same frequency, latest amount), not announcements.</li>
        <li>Amounts are net of the withholding tax you paid in the last 12 months and use today’s exchange rates for future payments.</li>
        <li>{earnings ?? 'Earnings dates are mostly available for US-listed companies.'}</li>
        <li>{corporateActions ?? 'Stock splits are covered; mergers, spin-offs and symbol changes are not.'}</li>
      </ul>
    </details>
  );
}
