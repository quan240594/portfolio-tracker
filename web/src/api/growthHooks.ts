import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { GrowthRange } from '@portfolio/shared';
import type { Scope } from './client';
import { ANALYTICS_ROOT_KEY } from './analyticsHooks';
import { growthApi } from './growthClient';

export const growthKeys = {
  growth: (scope: Scope, range: GrowthRange, benchmarks: readonly string[]) => [ANALYTICS_ROOT_KEY, scope, 'growth', range, benchmarks.join(',')] as const,
  holdings: (scope: Scope, range: GrowthRange) => [ANALYTICS_ROOT_KEY, scope, 'holdings-performance', range] as const,
};

interface ReadOptions {
  /** False while the scope is not yet known to be valid (avoids 404s for stale ids). */
  enabled?: boolean;
}

export const useGrowth = (scope: Scope, range: GrowthRange, benchmarks: readonly string[], { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: growthKeys.growth(scope, range, benchmarks),
    queryFn: ({ signal }) => growthApi.growth(scope, range, benchmarks, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useHoldingsPerformance = (scope: Scope, range: GrowthRange, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: growthKeys.holdings(scope, range),
    queryFn: ({ signal }) => growthApi.holdingsPerformance(scope, range, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
