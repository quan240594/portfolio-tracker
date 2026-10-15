import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GrowthRange } from '@portfolio/shared';
import { ANALYTICS_ROOT_KEY } from './analyticsHooks';
import { growthApi } from './growthClient';

export const growthKeys = {
  growth: (scope: string, range: GrowthRange, benchmarks: readonly string[]) => [ANALYTICS_ROOT_KEY, scope, 'growth', range, benchmarks.join(',')] as const,
  holdings: (scope: string, range: GrowthRange) => [ANALYTICS_ROOT_KEY, scope, 'holdings-performance', range] as const,
};

interface ReadOptions {
  /** False while the scope is not yet known to be valid (avoids 404s for stale ids). */
  enabled?: boolean;
}

export const useGrowth = (scope: string, range: GrowthRange, benchmarks: readonly string[], { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: growthKeys.growth(scope, range, benchmarks),
    queryFn: ({ signal }) => growthApi.growth(scope, range, benchmarks, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useHoldingsPerformance = (scope: string, range: GrowthRange, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: growthKeys.holdings(scope, range),
    queryFn: ({ signal }) => growthApi.holdingsPerformance(scope, range, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
