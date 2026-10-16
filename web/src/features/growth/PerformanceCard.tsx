import { useState } from 'react';
import { DEFAULT_GROWTH_RANGE, downsampleEvenly, type AnalyticsGrowthResponse, type GrowthPeriod, type GrowthRange } from '@portfolio/shared';
import { useGrowth } from '../../api/growthHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SelectableTable, useSeriesSelection } from '../../components/charts/selection';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { formatDate, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { PanelHeader } from '../analytics/TableShell';
import { GrowthChart } from './GrowthChart';
import { SelectableChartOrTable } from './ChartOrTable';
import { InfoNote } from './InfoNote';
import { CompareToggle, RangeButtons } from './RangeButtons';
import { TABLE_ROWS, availableBenchmarks, benchmarkColors, growthRows, lastBenchmarkValue, returnKey } from './growthFormat';
import { legendEntries, selectionSummary, seriesKeys, shownLabels, visibleBenchmarks, type LineSeries } from './growthSelection';
import { NO_TRANSACTIONS_TEXT } from './ValueCard';

interface Compare {
  compare: boolean;
  onCompareChange: (compare: boolean) => void;
}

/** Series of the return chart: the portfolio, plus one per benchmark while Compare is on. */
export function performanceSeries(data: AnalyticsGrowthResponse, period: GrowthPeriod, compare: boolean, theme: Theme): LineSeries[] {
  const colors = benchmarkColors(theme);
  const benchmarks = compare ? availableBenchmarks(data) : [];
  return [
    { key: 'portfolio', color: analyticsTheme(theme).value, label: 'Portfolio', detail: formatPercent(period.returnPct, { signed: true }) },
    ...benchmarks.map(({ symbol, index }) => ({
      key: symbol,
      color: colors[index % colors.length]!,
      label: symbol,
      detail: formatPercent(lastBenchmarkValue(data.benchmarks[index]!, 'returnPct') ?? 0, { signed: true }),
    })),
  ];
}

function PerformanceChartBlock({ data, period, compare }: Readonly<{ data: AnalyticsGrowthResponse; period: GrowthPeriod; compare: boolean }>) {
  const { theme } = useTheme();
  const bench = compare ? availableBenchmarks(data) : [];
  const rows = growthRows(data);
  const series = performanceSeries(data, period, compare, theme);
  const selection = useSeriesSelection(seriesKeys(series));
  const span = `from ${formatDate(period.from)} to ${formatDate(period.to)}`;
  const whole = `Cumulative time-weighted return ${span}: ${formatPercent(period.returnPct, { signed: true })}.`;
  const summary = selection.hasHidden ? selectionSummary('Cumulative time-weighted return', span, shownLabels(series, selection)) : whole;
  const columns = series.map(({ key, label }) => ({ key, label }));
  const tableRows = downsampleEvenly(rows, TABLE_ROWS).map((r) => ({
    id: String(r.date),
    header: formatDate(String(r.date)),
    selectable: false,
    cells: [formatPercent(Number(r.returnPct), { signed: true }), ...bench.map((b) => formatPercent(Number(r[returnKey(b.index)]), { signed: true }))],
  }));
  return (
    <SelectableChartOrTable
      id="growth-performance-body"
      entries={legendEntries(series)}
      selection={selection}
      legendTestId="growth-performance-legend"
      legendLabel="Portfolio performance series"
      chart={
        <GrowthChart rows={rows} benchmarks={visibleBenchmarks(bench, selection)} showPortfolio={selection.isSeriesVisible('portfolio')} kind="return" currency={data.baseCurrency} summary={summary} testId="growth-performance-chart" />
      }
      table={<SelectableTable caption="Cumulative return over time" rowHeader="Date" columns={columns} rows={tableRows} selection={selection} />}
    />
  );
}

function PerformanceContent({ data, compare }: Readonly<{ data: AnalyticsGrowthResponse; compare: boolean }>) {
  const { period } = data;
  if (!period) return <p className="muted py-8 text-center text-sm">{NO_TRANSACTIONS_TEXT}</p>;
  return (
    <div>
      <p className="muted mb-3 text-xs">
        {formatDate(period.from)} – {formatDate(period.to)} · Gain <Change amount={period.gain} pct={period.returnPct} currency={data.baseCurrency} className="text-xs" />
      </p>
      <PerformanceChartBlock data={data} period={period} compare={compare} />
      <InfoNote>
        <p>
          The line is the time-weighted return (TWR): daily returns are chained, with purchases and sales removed as cash flows, so it measures how your
          investments performed regardless of when you added money. It starts at 0% on the first day of the range and includes dividends. The money-weighted
          return (IRR, see the Returns tab) also reflects the timing of your deposits.
        </p>
        <p>
          Benchmarks are the plain price return of the same period, rebased to 0% on the same day, so they are comparable with your line. Foreign-currency
          prices are converted at the daily ECB rate, and your transactions at the rate of the transaction.
        </p>
      </InfoNote>
    </div>
  );
}

/** Card 3: cumulative time-weighted return, optionally against the benchmarks. */
export function PerformanceCard({ benchmarks, compare, onCompareChange }: Readonly<{ benchmarks: readonly string[] } & Compare>) {
  const [range, setRange] = useState<GrowthRange>(DEFAULT_GROWTH_RANGE);
  const { scope, ready } = usePortfolioScope();
  const query = useGrowth(scope, range, benchmarks, { enabled: ready });
  return (
    <section aria-labelledby="growth-performance-title" className="card p-4">
      <PanelHeader
        id="growth-performance-title"
        title="Portfolio performance"
        controls={
          <>
            <CompareToggle checked={compare} onChange={onCompareChange} />
            <RangeButtons label="Performance range" value={range} onChange={setRange} />
          </>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading portfolio performance" errorTitle="Could not load the portfolio performance">
        {(data) => <PerformanceContent data={data} compare={compare} />}
      </QueryBoundary>
    </section>
  );
}
