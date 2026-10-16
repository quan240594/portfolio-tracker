import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DividendsOverviewResponse, FutureMonth } from '@portfolio/shared';
import {
  LegendSwatch,
  NothingSelected,
  SelectableDataTable,
  SelectableLegend,
  focusOpacity,
  selectRows,
  useSeriesSelection,
  visibleTotal,
  type SelectableColumn,
  type SeriesSelection,
} from '../../components/charts/selection';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney, formatMonth, formatPercent } from '../../lib/format';
import { ChartFrame, useDividendTheme } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { ForecastNote } from './ForecastNote';
import { DECLARED_LABEL, ESTIMATED_LABEL, STATUS_NOTE } from './forecastLabels';
import { useScopedDividendsOverview } from './useDividendsOverview';

interface GrowthBar {
  symbol: string;
  name: string;
  growthPct: number;
  years: number;
}

/** Holdings with a measurable per-share growth, fastest growing first. */
export function growthBars(data: DividendsOverviewResponse): GrowthBar[] {
  return data.holdings
    .flatMap((h) => (h.growthPct === null ? [] : [{ symbol: h.symbol, name: h.name, growthPct: h.growthPct, years: h.growthYears }]))
    .sort((a, b) => b.growthPct - a.growthPct || a.symbol.localeCompare(b.symbol));
}

/** The one series of the chart: the growth bars. */
const GROWTH_SERIES = ['growth'];
const GROWTH_COLUMNS: SelectableColumn[] = [
  { key: 'growth', label: 'Growth per year' },
  { key: 'years', label: 'Years measured', selectable: false },
];

function GrowthBars({ bars, skipped }: Readonly<{ bars: readonly GrowthBar[]; skipped: number }>) {
  const c = useDividendTheme();
  const selection = useSeriesSelection(
    GROWTH_SERIES,
    bars.map((b) => b.symbol),
  );
  const shown = selectRows(bars, (b) => b.symbol, selection);
  const summary = shown.map((b) => `${b.symbol} ${formatPercent(b.growthPct, { signed: true, digits: 1 })}`).join(', ');
  const label = `Average annual dividend growth per share, ${shown.length} holdings: ${summary}.`;
  return (
    <>
      <SelectableLegend entries={[{ key: 'growth', label: 'Average annual growth', swatch: <LegendSwatch color={c.gain} /> }]} selection={selection} testId="growth-cagr-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame label={label} testId="growth-cagr-chart" bars={shown.length}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={shown as GrowthBar[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="symbol" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
              <YAxis tickFormatter={(v: number) => formatPercent(v, { digits: 0 })} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
              <ReferenceLine y={0} stroke={c.axis} />
              <Tooltip
                cursor={{ fill: c.grid, opacity: 0.5 }}
                contentStyle={c.tooltip}
                labelFormatter={(_l, payload) => payload[0]?.payload.name ?? ''}
                formatter={(v: unknown) => [formatPercent(Number(v), { signed: true }), 'Average annual growth']}
              />
              <Bar dataKey="growthPct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {shown.map((b) => (
                  <Cell key={b.symbol} fill={b.growthPct >= 0 ? c.gain : c.loss} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      {skipped > 0 && <p className="muted mt-1 text-xs">{skipped} holding{skipped === 1 ? '' : 's'} without two full years of payments not shown.</p>}
      <SelectableDataTable
        caption="Average annual dividend growth per share"
        rowHeader="Holding"
        columns={GROWTH_COLUMNS}
        selection={selection}
        rows={bars.map((b) => ({ id: b.symbol, header: b.name, cells: [formatPercent(b.growthPct, { signed: true }), b.years] }))}
      />
    </>
  );
}

function AverageGrowth({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const bars = growthBars(data);
  if (bars.length === 0) return <EmptyNote>Not enough payment history yet: growth needs two full years of payments.</EmptyNote>;
  return <GrowthBars bars={bars} skipped={data.holdings.length - bars.length} />;
}

export function AverageGrowthCard() {
  const query = useScopedDividendsOverview();
  return (
    <QueryCard
      id="div-growth-cagr"
      title="Average annual growth"
      query={query}
      loadingLabel="Loading dividend growth"
      errorTitle="Could not load dividend growth"
      info={
        <>
          <p>Compound annual growth of each holding&apos;s dividend per share, measured over the full years of payments known: your received payments plus the provider&apos;s past events (about two years).</p>
          <p>A year is a block of consecutive payments (4 for a quarterly payer). Per-share amounts are in the paying currency, so exchange rates do not distort it. Special dividends count as regular payments.</p>
        </>
      }
    >
      {(data) => <AverageGrowth data={data} />}
    </QueryCard>
  );
}

// --- Future payments ---------------------------------------------------------------------------------

function FutureHeader({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-4 text-sm">
      <div>
        <p className="muted text-xs">Next 12 months</p>
        <p className="text-lg font-semibold tabular-nums" data-testid="future-total">
          {formatMoney(data.summary.forward12m, data.baseCurrency)}
        </p>
      </div>
      <div>
        <p className="muted text-xs">Monthly average</p>
        <p className="text-lg font-semibold tabular-nums" data-testid="future-average">
          {formatMoney(data.summary.monthlyAverage, data.baseCurrency)}
        </p>
      </div>
    </div>
  );
}

const STATUS_NAMES: Readonly<Record<string, string>> = { paid: 'Received', declared: DECLARED_LABEL, estimated: ESTIMATED_LABEL };

function swatchOf(status: string, c: ReturnType<typeof useDividendTheme>) {
  if (status === 'paid') return { fill: c.paid, edge: c.paidEdge };
  if (status === 'declared') return { fill: c.declared, edge: c.declaredEdge };
  return { fill: c.estimated, edge: c.estimatedEdge };
}

/** Tooltip row label: a colour swatch plus the name, so the pastel colours do not have to carry the text. `avg` is the dashed average line of the received chart. */
export function FutureKey({ name, c }: Readonly<{ name: unknown; c: ReturnType<typeof useDividendTheme> }>) {
  const status = String(name);
  if (status === 'avg') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: c.text }} />
        <span>avg</span>
      </span>
    );
  }
  const swatch = swatchOf(status, c);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: swatch.fill, border: `1px ${status === 'estimated' ? 'dashed' : 'solid'} ${swatch.edge}` }} />
      {STATUS_NAMES[status] ?? 'Estimated'}
    </span>
  );
}

/** Tooltip row for one status: the amount and its swatch + name. */
export function futureTooltipRow(ccy: string, c: ReturnType<typeof useDividendTheme>) {
  return (value: unknown, name: unknown): [string, React.JSX.Element] => [formatMoney(Number(value), ccy), <FutureKey key={String(name)} name={name} c={c} />];
}

/** The series of the chart: the stacked bars. The monthly average line is derived, not a series of its own. */
const FUTURE_SERIES = ['declared', 'estimated'];

/** Mean of the visible bars per shown month: the dashed line follows the selection (the headline keeps the portfolio's own average). */
function selectedAverage(months: readonly FutureMonth[], selection: SeriesSelection): number {
  if (months.length === 0) return 0;
  return months.reduce((sum, m) => sum + visibleTotal(m, FUTURE_SERIES, selection), 0) / months.length;
}

function futureLabel(data: DividendsOverviewResponse, shown: readonly FutureMonth[], selection: SeriesSelection): string {
  const ccy = data.baseCurrency;
  const { summary } = data;
  if (!selection.hasHidden) {
    return `Expected dividends per month over the next 12 months, ${formatMoney(summary.forward12m, ccy)} in total: ${formatMoney(summary.declared, ccy)} declared and ${formatMoney(summary.estimated, ccy)} estimated.`;
  }
  const total = shown.reduce((sum, m) => sum + visibleTotal(m, FUTURE_SERIES, selection), 0);
  return `Expected dividends for the ${shown.length} selected months, ${formatMoney(total, ccy)} in total (current selection).`;
}

function FuturePayments({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const { futureMonths: months, summary } = data;
  const selection = useSeriesSelection(
    FUTURE_SERIES,
    months.map((m) => m.month),
  );
  const shown = selectRows(months, (m) => m.month, selection);
  const average = selection.hasHidden ? selectedAverage(shown, selection) : summary.monthlyAverage;
  const showDeclared = selection.isSeriesVisible('declared');
  const showEstimated = selection.isSeriesVisible('estimated');
  const fade = (key: string) => focusOpacity(selection.focusKey, key);
  return (
    <>
      <FutureHeader data={data} />
      <SelectableLegend
        testId="future-legend"
        selection={selection}
        entries={[
          { key: 'declared', label: DECLARED_LABEL, swatch: <LegendSwatch color={c.declared} edge={c.declaredEdge} /> },
          { key: 'estimated', label: ESTIMATED_LABEL, swatch: <LegendSwatch color={c.estimated} edge={c.estimatedEdge} dashed /> },
          { key: 'avg', label: 'Monthly average', swatch: <LegendSwatch shape="line" color={c.invested} dashed />, toggleable: false },
        ]}
      />
      <ForecastNote text={STATUS_NOTE} testId="future-legend-note" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame label={futureLabel(data, shown, selection)} testId="future-chart" bars={shown.length} height="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={shown as FutureMonth[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="month" tickFormatter={formatMonth} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
              <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
              <Tooltip
                cursor={{ fill: c.grid, opacity: 0.5 }}
                contentStyle={c.tooltip}
                itemStyle={{ color: c.text }}
                labelFormatter={(m) => formatMonth(String(m))}
                formatter={futureTooltipRow(ccy, c)}
              />
              <ReferenceLine y={average} stroke={c.invested} strokeOpacity={fade('avg')} strokeDasharray="5 4" ifOverflow="extendDomain" />
              {showDeclared && <Bar dataKey="declared" stackId="f" fill={c.declared} fillOpacity={fade('declared')} stroke={c.declaredEdge} strokeOpacity={fade('declared')} radius={showEstimated ? undefined : [4, 4, 0, 0]} isAnimationActive={false} />}
              {showEstimated && <Bar dataKey="estimated" stackId="f" fill={c.estimated} fillOpacity={fade('estimated')} stroke={c.estimatedEdge} strokeOpacity={fade('estimated')} strokeDasharray="4 3" radius={[4, 4, 0, 0]} isAnimationActive={false} />}
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      <p className="muted mt-1 text-xs">{selection.hasHidden ? 'The dashed line is the monthly average of the current selection.' : 'The dashed line is the monthly average.'}</p>
      <SelectableDataTable
        caption="Expected dividends per month"
        rowHeader="Month"
        columns={[
          { key: 'declared', label: DECLARED_LABEL },
          { key: 'estimated', label: ESTIMATED_LABEL },
        ]}
        selection={selection}
        rows={months.map((m) => ({ id: m.month, header: formatMonth(m.month), cells: [formatMoney(m.declared, ccy), formatMoney(m.estimated, ccy)] }))}
      />
    </>
  );
}

export function FuturePaymentsCard() {
  const query = useScopedDividendsOverview();
  return (
    <QueryCard
      id="div-future"
      title="Future payments"
      query={query}
      loadingLabel="Loading future payments"
      errorTitle="Could not load future payments"
      info={
        <>
          <p>Expected net dividends per month for the next 12 months. Declared = announced dividends (ex-date in the next 12 months) × the shares you hold. Estimated = payments your history implies but that are not announced yet, placed in the months you were paid last year and valued at the latest per-share amount.</p>
          <p>Estimates are not a promise: companies can change or skip dividends. The window is the next 365 days, so a payment in this calendar month next year is shown in this month&apos;s bar.</p>
        </>
      }
    >
      {(data) => <FuturePayments data={data} />}
    </QueryCard>
  );
}
