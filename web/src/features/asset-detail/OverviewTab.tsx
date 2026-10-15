import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { DEFAULT_GROWTH_RANGE, type AssetDetailResponse, type AssetPositionsResponse, type GrowthRange } from '@portfolio/shared';
import { useAssetHistory } from '../../api/assetHooks';
import { BenchmarksBar } from '../growth/BenchmarksBar';
import { useBenchmarkSelection } from '../growth/benchmarkSelection';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { AboutCard } from './AboutCard';
import { PositionsSection } from './PositionsSection';
import { PriceHistoryCard } from './PriceHistoryCard';
import { StatsSidebar } from './StatsSidebar';

/**
 * Overview tab: the benchmarks bar (the same picker and selection as the Growth tab), the price history with the
 * user's trades, the key figures sidebar, the user's positions and the company profile.
 */
export function OverviewTab({ detail, positions }: Readonly<{ detail: AssetDetailResponse; positions: UseQueryResult<AssetPositionsResponse> }>) {
  const { benchmarks, setBenchmarks } = useBenchmarkSelection();
  const [range, setRange] = useState<GrowthRange>(DEFAULT_GROWTH_RANGE);
  const { scope, ready } = usePortfolioScope();
  const history = useAssetHistory(scope, detail.symbol, range, benchmarks, { enabled: ready });
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <BenchmarksBar selected={benchmarks} options={history.data?.options} benchmarks={history.data?.benchmarks} onChange={setBenchmarks} />
          <PriceHistoryCard query={history} range={range} onRangeChange={setRange} />
        </div>
        <StatsSidebar detail={detail} />
      </div>
      <PositionsSection query={positions} symbol={detail.symbol} />
      <AboutCard detail={detail} />
    </div>
  );
}
