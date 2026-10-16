import type { AnalyticsDividendGrowthResponse, DividendPerShareSeries } from '@portfolio/shared';
import { useAnalyticsDividendGrowth } from '../../api/analyticsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import type { GrowthBar } from '../../components/charts/DividendGrowthChart';
import { SelectableDataTable, SelectableTable, useSeriesSelection, type SeriesSelection } from '../../components/charts/selection';
import { formatMoney, formatMonth } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { signedPercentOrDash } from './labels';
import { GrowthChartBlock, growthSeriesKeys } from './GrowthChartBlock';
import { PanelHeader, TableShell, numCell, rowClass } from './TableShell';

/** Months shown in the year-over-year chart. */
const MONTHS_SHOWN = 12;

/** Per year: the "Received" column is the chart's one series, a year is a row; payments and growth are plain columns. */
function YearTable({ data, selection }: Readonly<{ data: AnalyticsDividendGrowthResponse; selection: SeriesSelection }>) {
  return (
    <SelectableTable
      caption="Dividends per year"
      rowHeader="Year"
      columns={[
        { key: 'payments', label: 'Payments', selectable: false },
        { key: 'current', label: 'Received' },
        { key: 'growth', label: 'Growth', selectable: false },
      ]}
      selection={selection}
      tableClassName="w-full text-sm"
      scrollClassName="overflow-x-auto"
      rows={[...data.byYear].reverse().map((y) => ({
        id: y.year,
        header: y.year,
        note: y.partial && <span className="muted ml-2 text-xs font-normal">year to date</span>,
        cells: [y.payments, formatMoney(y.total, data.baseCurrency), signedPercentOrDash(y.yoyPct, 1)],
      }))}
    />
  );
}

/** The months of the chart with this period and the same month a year earlier. */
function MonthTable({ bars, currency, currentName, selection }: Readonly<{ bars: readonly GrowthBar[]; currency: string; currentName: string; selection: SeriesSelection }>) {
  const withPrevious = growthSeriesKeys(bars).includes('previous');
  return (
    <SelectableDataTable
      caption="Monthly dividends compared with a year earlier"
      rowHeader="Month"
      columns={[...(withPrevious ? [{ key: 'previous', label: 'A year earlier' }] : []), { key: 'current', label: currentName }]}
      selection={selection}
      rows={bars.map((b) => ({
        id: b.label,
        header: b.label,
        cells: [...(withPrevious ? [formatMoney(b.previous ?? 0, currency)] : []), formatMoney(b.current, currency)],
      }))}
    />
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

function GrowthBody({ data }: Readonly<{ data: AnalyticsDividendGrowthResponse }>) {
  const yearBars: GrowthBar[] = data.byYear.map((y) => ({ label: y.year, current: y.total }));
  const monthBars: GrowthBar[] = data.byMonth.slice(-MONTHS_SHOWN).map((m) => ({ label: formatMonth(m.month), current: m.total, previous: m.previousYearTotal }));
  const yearSelection = useSeriesSelection(growthSeriesKeys(yearBars), yearBars.map((b) => b.label));
  const monthSelection = useSeriesSelection(growthSeriesKeys(monthBars), monthBars.map((b) => b.label));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-medium">Per year</h3>
          <GrowthChartBlock bars={yearBars} selection={yearSelection} currency={data.baseCurrency} title="Dividends received per year" testId="dividend-year-chart" currentName="Received" />
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-medium">Last {MONTHS_SHOWN} months vs a year earlier</h3>
          <GrowthChartBlock bars={monthBars} selection={monthSelection} currency={data.baseCurrency} title="Monthly dividends compared with a year earlier" testId="dividend-month-chart" currentName="This period">
            <MonthTable bars={monthBars} currency={data.baseCurrency} currentName="This period" selection={monthSelection} />
          </GrowthChartBlock>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <YearTable data={data} selection={yearSelection} />
        <PerShareTable series={data.perShare} />
      </div>
      <p className="muted text-xs">
        Net dividends received, converted at the rate of the payment date. Growth compares with the previous calendar year; the current year is incomplete.
        The charts follow the years, months and series you include in the legends or the tables.
      </p>
    </div>
  );
}

function GrowthContent({ data }: Readonly<{ data: AnalyticsDividendGrowthResponse }>) {
  if (data.byYear.length === 0) {
    return <p className="muted py-8 text-center text-sm">No dividends received yet. Add dividend transactions to see how your income grows.</p>;
  }
  return <GrowthBody data={data} />;
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
