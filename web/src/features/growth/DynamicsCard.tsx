import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AnalyticsGrowthResponse, GrowthMonthRow } from '@portfolio/shared';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { NothingSelected, SelectableLegend, SelectableTable, selectRows, useSeriesSelection } from '../../components/charts/selection';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { PanelHeader } from '../analytics/TableShell';
import { DynamicsChart, dynamicsSummary, signedLabel } from './DynamicsChart';
import { InfoNote } from './InfoNote';
import { CompareToggle } from './RangeButtons';
import { DYNAMICS_LAST_12M, availableBenchmarks, benchmarkColors, dynamicsMonths, dynamicsOptions, monthShortLabel } from './growthFormat';
import { legendEntries, seriesKeys, shownLabels, visibleBenchmarks, type LineSeries } from './growthSelection';

const TABLE_ID = 'growth-dynamics-table';

type Bench = { symbol: string; index: number };

/** Series of the monthly bars: the portfolio (green/red by sign) and one per benchmark. */
export function dynamicsSeries(bench: readonly Bench[], theme: Theme): LineSeries[] {
  const colors = benchmarkColors(theme);
  return [
    { key: 'portfolio', color: analyticsTheme(theme).gain, label: 'Portfolio', detail: 'green = gain, red = loss' },
    ...bench.map((b) => ({ key: b.symbol, color: colors[b.index % colors.length]!, label: b.symbol })),
  ];
}

function DynamicsBody({ months, bench, details }: Readonly<{ months: readonly GrowthMonthRow[]; bench: readonly Bench[]; details: boolean }>) {
  const { theme } = useTheme();
  const series = dynamicsSeries(bench, theme);
  const selection = useSeriesSelection(
    seriesKeys(series),
    months.map((m) => m.month),
  );
  const shownMonths = selectRows(months, (m) => m.month, selection);
  const shownBench = visibleBenchmarks(bench, selection);
  const summary = dynamicsSummary(shownMonths, { portfolio: selection.isSeriesVisible('portfolio'), names: shownLabels(series, selection), hasHidden: selection.hasHidden });
  const rows = [...months].reverse().map((m) => ({
    id: m.month,
    header: monthShortLabel(m.month),
    cells: [signedLabel(m.portfolioPct, 2), ...bench.map((b) => signedLabel(m.benchmarks[b.symbol] ?? 0, 2))],
  }));
  return (
    <>
      <SelectableLegend entries={legendEntries(series, 'square')} selection={selection} label="Monthly return series" testId="growth-dynamics-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <DynamicsChart months={shownMonths} benchmarks={shownBench} showPortfolio={selection.isSeriesVisible('portfolio')} summary={summary} />
      )}
      <div id={TABLE_ID} className="mt-4" hidden={!details}>
        {details && (
          <SelectableTable
            caption="Monthly returns, newest first"
            rowHeader="Month"
            columns={series.map(({ key, label }) => ({ key, label }))}
            rows={rows}
            selection={selection}
          />
        )}
      </div>
    </>
  );
}

function DynamicsContent({ data, compare }: Readonly<{ data: AnalyticsGrowthResponse; compare: boolean }>) {
  const [selection, setSelection] = useState(DYNAMICS_LAST_12M);
  const [details, setDetails] = useState(false);
  const options = dynamicsOptions(data.monthly);
  const active = options.some((o) => o.value === selection) ? selection : DYNAMICS_LAST_12M;
  const months = dynamicsMonths(data.monthly, active);
  if (data.monthly.length === 0) return <p className="muted py-8 text-center text-sm">Not enough history yet to show monthly returns.</p>;

  const toggleDetails = () => {
    setDetails((d) => !d);
    // The table appears below the chart: bring it into view once it is rendered.
    setTimeout(() => document.getElementById(TABLE_ID)?.scrollIntoView?.({ block: 'nearest' }), 0);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl label="Dynamics period" options={options} value={active} onChange={setSelection} />
        <button type="button" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400" aria-expanded={details} aria-controls={TABLE_ID} onClick={toggleDetails}>
          {details ? 'Hide details' : 'View details'}
        </button>
      </div>
      <DynamicsBody months={months} bench={compare ? availableBenchmarks(data) : []} details={details} />
      <InfoNote>
        <p>
          Every column is the time-weighted return of one calendar month (the current month so far), so purchases and sales do not distort it and dividends count as
          return. Pick a calendar year to see its twelve months. Benchmark columns are the price return of the same month.
        </p>
      </InfoNote>
    </div>
  );
}

/** Card 4: monthly return columns for the last 12 months or a calendar year, optionally next to the benchmarks. */
export function DynamicsCard({ query, compare, onCompareChange }: Readonly<{ query: UseQueryResult<AnalyticsGrowthResponse>; compare: boolean; onCompareChange: (compare: boolean) => void }>) {
  return (
    <section aria-labelledby="growth-dynamics-title" className="card p-4">
      <PanelHeader id="growth-dynamics-title" title="Dynamics of portfolio returns" controls={<CompareToggle checked={compare} onChange={onCompareChange} />} />
      <QueryBoundary query={query} loadingLabel="Loading monthly returns" errorTitle="Could not load the monthly returns">
        {(data) => <DynamicsContent data={data} compare={compare} />}
      </QueryBoundary>
    </section>
  );
}
