import { useState } from 'react';
import { DEFAULT_GROWTH_RANGE, downsampleEvenly, type AnalyticsGrowthResponse, type GrowthPeriod, type GrowthRange } from '@portfolio/shared';
import { useGrowth } from '../../api/growthHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { formatDate, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { PanelHeader } from '../analytics/TableShell';
import { ChartLegend, GrowthChart, type LegendItem } from './GrowthChart';
import { ChartOrTable } from './ChartOrTable';
import { GrowthTable } from './GrowthTable';
import { InfoNote } from './InfoNote';
import { CompareToggle, RangeButtons } from './RangeButtons';
import { TABLE_ROWS, availableBenchmarks, benchmarkColors, growthRows, lastBenchmarkValue } from './growthFormat';
import { NO_TRANSACTIONS_TEXT } from './ValueCard';

interface Compare {
  compare: boolean;
  onCompareChange: (compare: boolean) => void;
}

function legendOf(data: AnalyticsGrowthResponse, period: GrowthPeriod, compare: boolean, theme: Theme): LegendItem[] {
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

function PerformanceContent({ data, compare }: Readonly<{ data: AnalyticsGrowthResponse; compare: boolean }>) {
  const { theme } = useTheme();
  const { period } = data;
  if (!period) return <p className="muted py-8 text-center text-sm">{NO_TRANSACTIONS_TEXT}</p>;
  const bench = compare ? availableBenchmarks(data) : [];
  const rows = growthRows(data);
  const summary = `Cumulative time-weighted return from ${formatDate(period.from)} to ${formatDate(period.to)}: ${formatPercent(period.returnPct, { signed: true })}.`;
  const tableRows = downsampleEvenly(rows, TABLE_ROWS).map((r) => [
    formatDate(String(r.date)),
    formatPercent(Number(r.returnPct), { signed: true }),
    ...bench.map((b) => formatPercent(Number(r[`r${b.index}`]), { signed: true })),
  ]);
  return (
    <div>
      <p className="muted mb-3 text-xs">
        {formatDate(period.from)} – {formatDate(period.to)} · Gain <Change amount={period.gain} pct={period.returnPct} currency={data.baseCurrency} className="text-xs" />
      </p>
      <ChartLegend items={legendOf(data, period, compare, theme)} />
      <ChartOrTable
        id="growth-performance-body"
        chart={<GrowthChart rows={rows} benchmarks={bench} kind="return" currency={data.baseCurrency} summary={summary} testId="growth-performance-chart" />}
        table={<GrowthTable caption="Cumulative return over time" columns={['Date', 'Portfolio', ...bench.map((b) => b.symbol)]} rows={tableRows} />}
      />
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
