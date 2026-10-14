import type { AnalyticsDividendGrowthResponse, DividendPerShareSeries } from '@portfolio/shared';
import { useAnalyticsDividendGrowth } from '../../api/analyticsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { DividendGrowthChart, type GrowthBar } from '../../components/charts/DividendGrowthChart';
import { formatMoney, formatMonth } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { signedPercentOrDash } from './labels';
import { PanelHeader, TableShell, numCell, rowClass } from './TableShell';

/** Months shown in the year-over-year chart. */
const MONTHS_SHOWN = 12;

function YearTable({ data }: Readonly<{ data: AnalyticsDividendGrowthResponse }>) {
  return (
    <TableShell caption="Dividends per year" columns={[{ label: 'Year' }, { label: 'Payments', align: 'right' }, { label: 'Received', align: 'right' }, { label: 'Growth', align: 'right' }]}>
      {[...data.byYear].reverse().map((y) => (
        <tr key={y.year} className={rowClass}>
          <th scope="row" className="py-2 pr-3 text-left font-medium">
            {y.year}
            {y.partial && <span className="muted ml-2 text-xs font-normal">year to date</span>}
          </th>
          <td className={numCell}>{y.payments}</td>
          <td className={`${numCell} font-medium`}>{formatMoney(y.total, data.baseCurrency)}</td>
          <td className={numCell}>{signedPercentOrDash(y.yoyPct, 1)}</td>
        </tr>
      ))}
    </TableShell>
  );
}

function PerShareTable({ series }: Readonly<{ series: readonly DividendPerShareSeries[] }>) {
  return (
    <TableShell caption="Dividend per share by year" columns={[{ label: 'Symbol' }, { label: 'Year', align: 'right' }, { label: 'Per share', align: 'right' }, { label: 'Growth', align: 'right' }]}>
      {series.flatMap((s) =>
        [...s.years].reverse().map((y) => (
          <tr key={`${s.symbol}-${y.year}`} className={rowClass}>
            <th scope="row" className="py-2 pr-3 text-left font-medium">
              {s.symbol}
            </th>
            <td className={numCell}>
              {y.year}
              {y.partial && <span className="muted ml-1 text-xs">YTD</span>}
            </td>
            <td className={numCell}>{formatMoney(y.perShare, s.currency, { maxDigits: 4 })}</td>
            <td className={numCell}>{signedPercentOrDash(y.yoyPct, 1)}</td>
          </tr>
        )),
      )}
    </TableShell>
  );
}

function GrowthContent({ data }: Readonly<{ data: AnalyticsDividendGrowthResponse }>) {
  if (data.byYear.length === 0) {
    return <p className="muted py-8 text-center text-sm">No dividends received yet. Add dividend transactions to see how your income grows.</p>;
  }
  const yearBars: GrowthBar[] = data.byYear.map((y) => ({ label: y.year, current: y.total }));
  const monthBars: GrowthBar[] = data.byMonth.slice(-MONTHS_SHOWN).map((m) => ({ label: formatMonth(m.month), current: m.total, previous: m.previousYearTotal }));
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-medium">Per year</h3>
          <DividendGrowthChart bars={yearBars} currency={data.baseCurrency} title="Dividends received per year" testId="dividend-year-chart" />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Last {MONTHS_SHOWN} months vs a year earlier</h3>
          <DividendGrowthChart bars={monthBars} currency={data.baseCurrency} title="Monthly dividends compared with a year earlier" testId="dividend-month-chart" currentName="This period" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <YearTable data={data} />
        <PerShareTable series={data.perShare} />
      </div>
      <p className="muted text-xs">
        Net dividends received, converted at the rate of the payment date. Growth compares with the previous calendar year; the current year is incomplete.
      </p>
    </div>
  );
}

export function DividendGrowthTab() {
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsDividendGrowth(scope, { enabled: ready });
  return (
    <section aria-labelledby="growth-title">
      <PanelHeader id="growth-title" title="Dividend growth" description="How your dividend income and the dividend per share develop year over year." />
      <QueryBoundary query={query} loadingLabel="Loading dividend growth" errorTitle="Could not load dividend growth" skeletonClassName="h-64 w-full">
        {(data) => <GrowthContent data={data} />}
      </QueryBoundary>
    </section>
  );
}
