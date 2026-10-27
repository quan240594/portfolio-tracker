import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { DEFAULT_GROWTH_RANGE, type AssetDetailResponse, type AssetPositionsResponse, type GrowthRange } from '@portfolio/shared';
import { useAssetHistory } from '../../api/assetHooks';
import { LatestEarnings } from '../earnings/LatestEarnings';
import { BenchmarksBar } from '../growth/BenchmarksBar';
import { useBenchmarkSelection } from '../growth/benchmarkSelection';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { CardGrid } from '../layout/CardGrid';
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
    <CardGrid
      pageId="asset-detail-overview"
      gap="gap-5"
      cards={[
        {
          id: 'price-history',
          title: 'Price history',
          defaultWidth: 'twothirds',
          render: () => (
            <div className="min-w-0 space-y-5 self-start">
              <BenchmarksBar selected={benchmarks} options={history.data?.options} benchmarks={history.data?.benchmarks} onChange={setBenchmarks} />
              <PriceHistoryCard query={history} range={range} onRangeChange={setRange} />
            </div>
          ),
        },
        { id: 'stats', title: 'Key figures', defaultWidth: 'third', render: () => <StatsSidebar detail={detail} /> },
        { id: 'latest-earnings', title: 'Latest earnings', defaultWidth: 'full', render: () => <LatestEarnings symbol={detail.symbol} /> },
        { id: 'positions', title: 'Your positions', defaultWidth: 'full', render: () => <PositionsSection query={positions} symbol={detail.symbol} /> },
        { id: 'about', title: 'About', defaultWidth: 'full', render: () => <AboutCard detail={detail} /> },
      ]}
    />
  );
}
