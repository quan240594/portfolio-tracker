import { useState } from 'react';
import { BENCHMARK_SYMBOLS, HISTORY_RANGES, type AnalyticsBenchmarkResponse, type HistoryRange } from '@portfolio/shared';
import { useAnalyticsBenchmark } from '../../api/analyticsHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { BenchmarkChart } from '../../components/charts/BenchmarkChart';
import { formatDate, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { CardGrid } from '../layout/CardGrid';
import { PanelHeader } from './TableShell';

const BENCHMARK_OPTIONS = BENCHMARK_SYMBOLS.map((s) => ({ value: s, label: s }));
const RANGE_OPTIONS = HISTORY_RANGES.map((r) => ({ value: r, label: r }));

function Stat({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div>
      <dt className="muted text-xs">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function ComparisonStats({ data }: Readonly<{ data: AnalyticsBenchmarkResponse }>) {
  const c = data.comparison;
  if (!c) return null;
  const symbol = data.benchmark.symbol;
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Your return (TWR)">{formatPercent(c.portfolioReturnPct, { signed: true })}</Stat>
        <Stat label={`${symbol} return`}>{formatPercent(c.benchmarkReturnPct, { signed: true })}</Stat>
        <Stat label="Difference">
          <Change pct={c.differencePct} />
        </Stat>
        <Stat label="Gain vs same money in benchmark">
          <Change amount={c.portfolioGain - c.benchmarkGain} currency={data.baseCurrency} />
        </Stat>
      </dl>
      <p className="muted text-xs">
        {formatDate(c.from)} – {formatDate(c.to)}. The benchmark is replayed with your buys and sells: the same amounts go into {symbol} on the same days.
        Your line includes dividends received; the benchmark shows its price only.
      </p>
    </div>
  );
}

function BenchmarkContent({ data }: Readonly<{ data: AnalyticsBenchmarkResponse }>) {
  if (data.points.length === 0) {
    return <p className="muted py-8 text-center text-sm">{data.benchmark.message ?? 'No history for this period yet.'}</p>;
  }
  return (
    <div className="space-y-4">
      {data.benchmark.message && (
        <output className="block rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          {data.benchmark.message}
        </output>
      )}
      <CardGrid
        pageId="analytics-benchmark"
        gap="gap-4"
        cards={[
          { id: 'benchmark-chart', title: 'Benchmark chart', defaultWidth: 'full', render: () => <BenchmarkChart points={data.points} currency={data.baseCurrency} benchmark={data.benchmark.symbol} /> },
          { id: 'benchmark-stats', title: 'Comparison figures', defaultWidth: 'full', render: () => <ComparisonStats data={data} /> },
        ]}
      />
    </div>
  );
}

export function BenchmarkTab() {
  const [benchmark, setBenchmark] = useState<string>(BENCHMARK_SYMBOLS[0]);
  const [range, setRange] = useState<HistoryRange>('1Y');
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsBenchmark(scope, benchmark, range, { enabled: ready });
  return (
    <section aria-labelledby="benchmark-title">
      <PanelHeader
        id="benchmark-title"
        title="Portfolio vs benchmark"
        controls={
          <>
            <SegmentedControl label="Benchmark" options={BENCHMARK_OPTIONS} value={benchmark} onChange={setBenchmark} />
            <SegmentedControl label="Benchmark range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
          </>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading benchmark comparison" errorTitle="Could not load the benchmark comparison">
        {(data) => <BenchmarkContent data={data} />}
      </QueryBoundary>
    </section>
  );
}
