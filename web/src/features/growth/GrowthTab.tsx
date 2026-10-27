import { useState } from 'react';
import { DEFAULT_GROWTH_RANGE } from '@portfolio/shared';
import { useGrowth } from '../../api/growthHooks';
import { CardGrid } from '../layout/CardGrid';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { BenchmarksBar } from './BenchmarksBar';
import { DynamicsCard } from './DynamicsCard';
import { HoldingsCard } from './HoldingsCard';
import { PerformanceCard } from './PerformanceCard';
import { ValueCard } from './ValueCard';
import { useBenchmarkSelection } from './benchmarkSelection';

/**
 * Growth: benchmark chips, portfolio value, cumulative performance, monthly return dynamics and holdings performance.
 * The cards with the default range share one request with the benchmarks bar and the dynamics card.
 */
export function GrowthTab() {
  const { benchmarks, setBenchmarks } = useBenchmarkSelection();
  const [compare, setCompare] = useState(true);
  const { scope, ready } = usePortfolioScope();
  const shared = useGrowth(scope, DEFAULT_GROWTH_RANGE, benchmarks, { enabled: ready });
  return (
    <div className="space-y-5">
      <BenchmarksBar selected={benchmarks} options={shared.data?.options} benchmarks={shared.data?.benchmarks} onChange={setBenchmarks} />
      <CardGrid
        pageId="analytics-growth"
        gap="gap-5"
        cards={[
          { id: 'value', title: 'Portfolio value', defaultWidth: 'full', render: () => <ValueCard benchmarks={benchmarks} /> },
          { id: 'performance', title: 'Portfolio performance', defaultWidth: 'full', render: () => <PerformanceCard benchmarks={benchmarks} compare={compare} onCompareChange={setCompare} /> },
          { id: 'dynamics', title: 'Dynamics of returns', defaultWidth: 'full', render: () => <DynamicsCard query={shared} compare={compare} onCompareChange={setCompare} /> },
          { id: 'holdings', title: 'Holdings performance', defaultWidth: 'full', render: () => <HoldingsCard /> },
        ]}
      />
    </div>
  );
}
