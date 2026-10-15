import { Bar, CartesianGrid, ComposedChart, Legend, LabelList, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CalendarMonth, CalendarSummary } from '@portfolio/shared';
import { KpiCard } from '../../components/KpiCard';
import { chartTheme } from '../../components/charts/palette';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatMoney, formatMonth, formatPercent } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { incomeColours } from './calendarColours';
import { IncomeTooltip, legendLabel } from './IncomeTooltip';
import { incomeRows, seriesName, useNarrowScreen } from './incomeChartModel';

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

/** Income by month, stacked: received (green), declared (blue) and estimated (yellow, dashed outline); dashed average line. */
export function IncomeChart({ monthly, average, currency }: Readonly<{ monthly: readonly CalendarMonth[]; average: number; currency: string }>) {
  const { theme } = useTheme();
  const narrow = useNarrowScreen();
  const c = chartTheme(theme);
  const colours = incomeColours(theme);
  const rows = incomeRows(monthly, currency, narrow);
  const total = monthly.reduce((s, m) => s + m.total, 0);
  const label = `Dividend income per month over ${monthly.length} months: ${formatMoney(total, currency)} in total, ${formatMoney(average, currency)} on average.`;
  const tooltip = <IncomeTooltip currency={currency} colours={colours} background={c.tooltipBg} border={c.tooltipBorder} text={c.text} />;
  return (
    <figure className="m-0">
      <div role="img" aria-label={label} className="h-72 w-full" data-testid="calendar-income-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 22, right: 30, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="month" tickFormatter={formatMonth} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={tooltip} />
            <Legend formatter={legendLabel} wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="paid" stackId="income" fill={colours.paid.fill} stroke={colours.paid.stroke} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="declared" stackId="income" fill={colours.declared.fill} stroke={colours.declared.stroke} strokeWidth={1} isAnimationActive={false} />
            <Bar dataKey="estimated" stackId="income" fill={colours.estimated.fill} stroke={colours.estimated.stroke} strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} />
            <Line dataKey="total" stroke="none" dot={false} activeDot={false} legendType="none" tooltipType="none" isAnimationActive={false}>
              <LabelList dataKey="label" position="top" fill={c.text} fontSize={10} />
            </Line>
            <ReferenceLine y={average} stroke={c.text} strokeDasharray="5 4" label={{ value: 'avg', position: 'right', fill: c.text, fontSize: 11 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Dividend income per month</figcaption>
      <table className="sr-only">
        <caption>Dividend income per month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">{seriesName('paid')}</th>
            <th scope="col">{seriesName('declared')}</th>
            <th scope="col">{seriesName('estimated')}</th>
          </tr>
        </thead>
        <tbody>
          {monthly.map((m) => (
            <tr key={m.month}>
              <th scope="row">{formatMonth(m.month)}</th>
              <td>{formatMoney(m.paid, currency)}</td>
              <td>{formatMoney(m.declared, currency)}</td>
              <td>{formatMoney(m.estimated, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
