import { useState } from 'react';
import { BENCHMARK_SYMBOLS, type AnalyticsMetricsResponse } from '@portfolio/shared';
import { useAnalyticsMetrics } from '../../api/analyticsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { PanelHeader } from '../analytics/TableShell';
import { CardGrid } from '../layout/CardGrid';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { Notice } from './MetricCard';
import { PeCard } from './PeCard';
import { SharpeCard, SortinoCard, VolatilityCard } from './RiskCards';
import { TwrCard } from './TwrCard';

const BENCHMARK_OPTIONS = BENCHMARK_SYMBOLS.map((s) => ({ value: s, label: s }));

function MetricsContent({ data }: Readonly<{ data: AnalyticsMetricsResponse }>) {
  if (data.twr.from === null) {
    return <p className="muted py-8 text-center text-sm">{data.benchmark.message ?? 'Add transactions to see your portfolio metrics.'}</p>;
  }
  return (
    <div className="space-y-4">
      {!data.benchmark.available && data.benchmark.message && <Notice>{data.benchmark.message}</Notice>}
      <CardGrid
        pageId="analytics-metrics"
        gap="gap-4"
        cards={[
          { id: 'twr', title: 'Time-weighted return', defaultWidth: 'half', render: () => <TwrCard data={data} /> },
          { id: 'pe', title: 'Price/earnings', defaultWidth: 'half', render: () => <PeCard data={data} /> },
          { id: 'volatility', title: 'Volatility', defaultWidth: 'half', render: () => <VolatilityCard data={data} /> },
          { id: 'sharpe', title: 'Sharpe ratio', defaultWidth: 'half', render: () => <SharpeCard data={data} /> },
          { id: 'sortino', title: 'Sortino ratio', defaultWidth: 'full', render: () => <SortinoCard data={data} /> },
        ]}
      />
      <p className="muted text-xs">Past performance and risk do not predict future results. Not investment advice.</p>
    </div>
  );
}

/** Analytics → Metrics: lifetime TWR, P/E, volatility/beta, Sharpe and Sortino, each next to the chosen benchmark ("market"). */
export function MetricsTab() {
  const [benchmark, setBenchmark] = useState<string>(BENCHMARK_SYMBOLS[0]);
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsMetrics(scope, benchmark, { enabled: ready });
  return (
    <section aria-labelledby="metrics-title">
      <PanelHeader
        id="metrics-title"
        title="Portfolio metrics"
        description="Five figures that sum up return, valuation and risk. The market is the benchmark you pick."
        controls={
          <>
            <span className="muted text-xs">Benchmark</span>
            <SegmentedControl label="Metrics benchmark" options={BENCHMARK_OPTIONS} value={benchmark} onChange={setBenchmark} />
          </>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading metrics" errorTitle="Could not load metrics" skeletonClassName="h-96 w-full">
        {(data) => <MetricsContent data={data} />}
      </QueryBoundary>
    </section>
  );
}
