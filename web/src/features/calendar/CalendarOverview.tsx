import { Bar, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CalendarMonth, CalendarSummary } from '@portfolio/shared';
import { KpiCard } from '../../components/KpiCard';
import { chartTheme } from '../../components/charts/palette';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatMoney, formatMonth, formatPercent } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import {
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
  return (
    <div className="grid grid-cols-2 gap-3">
      <KpiCard loading={loading} label="Annual income" value={summary && formatMoney(summary.annualIncome, currency)} hint="Next 12 months, net" />
      <KpiCard loading={loading} label="Monthly average" value={summary && formatMoney(summary.monthlyAverage, currency)} hint="Annual income ÷ 12" />
      <KpiCard loading={loading} label="Daily average" value={summary && formatMoney(summary.dailyAverage, currency)} hint="Annual income ÷ 365" />
      <KpiCard loading={loading} label="Yield" value={summary && formatPercent(summary.yieldPct)} hint={summary && `${formatPercent(summary.yieldOnCostPct)} on cost`} />
    </div>
  );
}

interface BarsProps {
  rows: readonly IncomeRow[];
  average: number;
  currency: string;
  statuses: readonly IncomeSeries[];
  label: string;
}

/** The stacked bars of the statuses that are included, their value labels and the dashed average line; the axis follows the data left. */
function IncomeBars({ rows, average, currency, statuses, label }: Readonly<BarsProps>) {
  const { theme } = useTheme();
  const c = chartTheme(theme);
  const colours = incomeColours(theme);
  const tooltip = <IncomeTooltip currency={currency} colours={colours} background={c.tooltipBg} border={c.tooltipBorder} text={c.text} statuses={statuses} />;
  return (
    <div role="img" aria-label={label} className="h-72 w-full" data-testid="calendar-income-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows as IncomeRow[]} margin={{ top: 22, right: 30, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={formatMonth} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={tooltip} />
          {statuses.includes('paid') && <Bar dataKey="paid" stackId="income" fill={colours.paid.fill} stroke={colours.paid.stroke} strokeWidth={1} isAnimationActive={false} />}
          {statuses.includes('declared') && <Bar dataKey="declared" stackId="income" fill={colours.declared.fill} stroke={colours.declared.stroke} strokeWidth={1} isAnimationActive={false} />}
          {statuses.includes('estimated') && (
            <Bar dataKey="estimated" stackId="income" fill={colours.estimated.fill} stroke={colours.estimated.stroke} strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} />
          )}
          <Line dataKey="total" stroke="none" dot={false} activeDot={false} legendType="none" tooltipType="none" isAnimationActive={false}>
            <LabelList dataKey="label" position="top" fill={c.text} fontSize={10} />
          </Line>
          <ReferenceLine y={average} stroke={c.text} strokeDasharray="5 4" label={{ value: 'avg', position: 'right', fill: c.text, fontSize: 11 }} />
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
  const shown = selectMonths(monthly, selection);
  const shownAverage = selectedAverage(shown, average, selection.hasHidden);
  const statuses = INCOME_SERIES.filter((key) => selection.isSeriesVisible(key));
  return (
    <figure className="m-0">
      <SelectableLegend entries={legendEntries(incomeColours(theme), c.text)} selection={selection} label="Income legend" testId="calendar-income-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <IncomeBars rows={incomeRows(shown, currency, narrow)} average={shownAverage} currency={currency} statuses={statuses} label={incomeLabel(shown, shownAverage, currency, selection.hasHidden)} />
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
