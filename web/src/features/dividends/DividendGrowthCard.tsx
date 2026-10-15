import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsDividendGrowthResponse } from '@portfolio/shared';
import { useAnalyticsDividendGrowth } from '../../api/analyticsHooks';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { ChartDataTable, ChartFrame, useDividendTheme } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { yearComparison } from './receivedSeries';

/** Colour of a year, newest first: the current year stands out, earlier years fade. */
function yearColors(c: ReturnType<typeof useDividendTheme>): string[] {
  return [c.received, c.base, c.previous];
}

const cell = (value: number | string | undefined, currency: string): string => (typeof value === 'number' ? formatMoney(value, currency) : '—');

function YearColumns({ data }: Readonly<{ data: AnalyticsDividendGrowthResponse }>) {
  const c = useDividendTheme();
  const { years, rows } = yearComparison(data.byMonth);
  if (years.length === 0) return <EmptyNote>No dividends received yet. Add dividend transactions to compare years.</EmptyNote>;
  const ccy = data.baseCurrency;
  const colorOf = (year: string) => yearColors(c)[years.length - 1 - years.indexOf(year)]!;
  const totals = years.map((y) => `${y}: ${formatMoney(data.byYear.find((b) => b.year === y)?.total ?? 0, ccy)}`).join(', ');
  const label = `Dividends received per calendar month, compared for ${years.join(', ')}. Totals per year: ${totals}.`;
  return (
    <>
      <ChartFrame label={label} testId="year-compare-chart" bars={12} height="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="month" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
            <YAxis tickFormatter={compactMoneyTick(ccy)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={c.tooltip} formatter={(v: unknown, name: unknown) => [formatMoney(Number(v), ccy), String(name)]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {years.map((y) => (
              <Bar key={y} dataKey={y} name={y} fill={colorOf(y)} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartDataTable
        caption="Dividends received per calendar month and year"
        columns={['Month', ...years]}
        rows={rows.map((r) => [r.month, ...years.map((y) => cell(r[y], ccy))])}
      />
    </>
  );
}

export function DividendGrowthCard() {
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsDividendGrowth(scope, { enabled: ready });
  return (
    <QueryCard
      id="div-year-compare"
      title="Dividend growth"
      query={query}
      loadingLabel="Loading dividend growth"
      errorTitle="Could not load dividend growth"
      skeletonClassName="h-72 w-full"
      info={
        <>
          <p>Net dividends received in each calendar month, with the last three years side by side (years without payments are left out), so you can see how each month grows.</p>
          <p>Source: your DIVIDEND transactions, converted to EUR at the rate of the payment date. The current year is incomplete.</p>
        </>
      }
    >
      {(data) => <YearColumns data={data} />}
    </QueryCard>
  );
}
