import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AssetRange } from '@portfolio/shared';
import { ANALYTICS_ROOT_KEY } from './analyticsHooks';
import { assetApi } from './assetClient';

/**
 * Per-user asset queries live under the `analytics` root with the scope as second segment (and the closed securities
 * under `holdings`), so `invalidatePortfolioData` refreshes them together with the other transaction-derived data.
 * The public detail does not depend on transactions or scope and has its own key.
 */
export const assetKeys = {
  detail: (symbol: string) => ['asset-detail', symbol] as const,
  history: (scope: string, symbol: string, range: AssetRange, benchmarks: readonly string[]) =>
    [ANALYTICS_ROOT_KEY, scope, 'asset', symbol, 'history', range, benchmarks.join(',')] as const,
  positions: (scope: string, symbol: string) => [ANALYTICS_ROOT_KEY, scope, 'asset', symbol, 'positions'] as const,
  closed: (scope: string) => ['holdings', scope, 'closed'] as const,
};

interface ReadOptions {
  /** False while the scope is not yet known to be valid (avoids 404s for stale ids). */
  enabled?: boolean;
}

export const useAssetDetail = (symbol: string) =>
  useQuery({ queryKey: assetKeys.detail(symbol), queryFn: ({ signal }) => assetApi.detail(symbol, signal), staleTime: 5 * 60_000 });

export const useAssetHistory = (scope: string, symbol: string, range: AssetRange, benchmarks: readonly string[], { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: assetKeys.history(scope, symbol, range, benchmarks),
    queryFn: ({ signal }) => assetApi.history(scope, symbol, range, benchmarks, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAssetPositions = (scope: string, symbol: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: assetKeys.positions(scope, symbol), queryFn: ({ signal }) => assetApi.positions(scope, symbol, signal), enabled });

export const useClosedSecurities = (scope: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: assetKeys.closed(scope), queryFn: ({ signal }) => assetApi.closed(scope, signal), enabled });
