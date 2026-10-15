import { Bar, BarChart, CartesianGrid, Cell, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DividendsOverviewResponse } from '@portfolio/shared';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney, formatMonth, formatPercent } from '../../lib/format';
import { ChartDataTable, ChartFrame, useDividendTheme } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
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

function AverageGrowth({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const c = useDividendTheme();
  const bars = growthBars(data);
  if (bars.length === 0) return <EmptyNote>Not enough payment history yet: growth needs two full years of payments.</EmptyNote>;
  const skipped = data.holdings.length - bars.length;
  const summary = bars.map((b) => `${b.symbol} ${formatPercent(b.growthPct, { signed: true, digits: 1 })}`).join(', ');
  const label = `Average annual dividend growth per share, ${bars.length} holdings: ${summary}.`;
  return (
    <>
      <ChartFrame label={label} testId="growth-cagr-chart" bars={bars.length}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
              {bars.map((b) => (
                <Cell key={b.symbol} fill={b.growthPct >= 0 ? c.gain : c.loss} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      {skipped > 0 && <p className="muted mt-1 text-xs">{skipped} holding{skipped === 1 ? '' : 's'} without two full years of payments not shown.</p>}
      <ChartDataTable
        caption="Average annual dividend growth per share"
        columns={['Holding', 'Growth per year', 'Years measured']}
        rows={bars.map((b) => [b.name, formatPercent(b.growthPct, { signed: true }), b.years])}
      />
    </>
  );
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

const STATUS_NAMES: Readonly<Record<string, string>> = { paid: 'Received', declared: 'Declared', estimated: 'Estimated' };

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
        avg
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

interface LegendEntry {
  value?: unknown;
  /** `none` marks helper series (e.g. the invisible total line behind value labels) that have no legend entry. */
  type?: string;
}

/** Tooltip row for one status: the amount and its swatch + name. */
export function futureTooltipRow(ccy: string, c: ReturnType<typeof useDividendTheme>) {
  return (value: unknown, name: unknown): [string, React.JSX.Element] => [formatMoney(Number(value), ccy), <FutureKey key={String(name)} name={name} c={c} />];
}

/** Own legend: recharts paints its default legend text in the (pastel) bar colour, which is unreadable on white. */
export function FutureLegend({ payload, c }: Readonly<{ payload?: readonly LegendEntry[]; c: ReturnType<typeof useDividendTheme> }>) {
  return (
    <ul className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-1 p-0 text-xs" style={{ color: c.text }}>
      {(payload ?? []).filter((entry) => entry.type !== 'none').map((entry) => (
        <li key={String(entry.value)}>
          <FutureKey name={entry.value} c={c} />
        </li>
      ))}
    </ul>
  );
}

function FuturePayments({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const c = useDividendTheme();
  const ccy = data.baseCurrency;
  const { futureMonths: months, summary } = data;
  const label = `Expected dividends per month over the next 12 months, ${formatMoney(summary.forward12m, ccy)} in total: ${formatMoney(summary.declared, ccy)} declared and ${formatMoney(summary.estimated, ccy)} estimated.`;
  return (
    <>
      <FutureHeader data={data} />
      <ChartFrame label={label} testId="future-chart" bars={months.length} height="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={months} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            <Legend content={<FutureLegend c={c} />} />
            <ReferenceLine y={summary.monthlyAverage} stroke={c.invested} strokeDasharray="5 4" ifOverflow="extendDomain" />
            <Bar dataKey="declared" stackId="f" fill={c.declared} stroke={c.declaredEdge} isAnimationActive={false} />
            <Bar dataKey="estimated" stackId="f" fill={c.estimated} stroke={c.estimatedEdge} strokeDasharray="4 3" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted mt-1 text-xs">The dashed line is the monthly average.</p>
      <ChartDataTable
        caption="Expected dividends per month"
        columns={['Month', 'Declared', 'Estimated']}
        rows={months.map((m) => [formatMonth(m.month), formatMoney(m.declared, ccy), formatMoney(m.estimated, ccy)])}
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
