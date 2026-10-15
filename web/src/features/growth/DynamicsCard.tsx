import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AnalyticsGrowthResponse } from '@portfolio/shared';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useTheme } from '../../theme/ThemeProvider';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { PanelHeader } from '../analytics/TableShell';
import { ChartLegend } from './GrowthChart';
import { signedLabel, DynamicsChart } from './DynamicsChart';
import { GrowthTable } from './GrowthTable';
import { InfoNote } from './InfoNote';
import { CompareToggle } from './RangeButtons';
import { DYNAMICS_LAST_12M, availableBenchmarks, benchmarkColors, dynamicsMonths, dynamicsOptions, monthShortLabel } from './growthFormat';

const TABLE_ID = 'growth-dynamics-table';

function DynamicsContent({ data, compare }: Readonly<{ data: AnalyticsGrowthResponse; compare: boolean }>) {
  const { theme } = useTheme();
  const [selection, setSelection] = useState(DYNAMICS_LAST_12M);
  const [details, setDetails] = useState(false);
  const options = dynamicsOptions(data.monthly);
  const active = options.some((o) => o.value === selection) ? selection : DYNAMICS_LAST_12M;
  const months = dynamicsMonths(data.monthly, active);
  if (data.monthly.length === 0) return <p className="muted py-8 text-center text-sm">Not enough history yet to show monthly returns.</p>;

  const bench = compare ? availableBenchmarks(data) : [];
  const t = analyticsTheme(theme);
  const colors = benchmarkColors(theme);
  const best = months.reduce((a, m) => (m.portfolioPct > a.portfolioPct ? m : a), months[0]!);
  const summary = `Monthly portfolio return over ${months.length} months. Best month ${monthShortLabel(best.month)} ${signedLabel(best.portfolioPct)}.`;
  const rows = [...months].reverse().map((m) => [monthShortLabel(m.month), signedLabel(m.portfolioPct, 2), ...bench.map((b) => signedLabel(m.benchmarks[b.symbol] ?? 0, 2))]);
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
      <ChartLegend
        items={[
          { key: 'portfolio', color: t.gain, label: 'Portfolio', detail: 'green = gain, red = loss' },
          ...bench.map((b) => ({ key: b.symbol, color: colors[b.index % colors.length]!, label: b.symbol })),
        ]}
      />
      <DynamicsChart months={months} benchmarks={bench} summary={summary} />
      <div id={TABLE_ID} className="mt-4" hidden={!details}>
        {details && <GrowthTable caption="Monthly returns, newest first" columns={['Month', 'Portfolio', ...bench.map((b) => b.symbol)]} rows={rows} />}
      </div>
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
