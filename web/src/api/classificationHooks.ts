import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ClassificationFields, ClassificationImportRequest } from '@portfolio/shared';
import { classificationApi } from './classificationClient';
import { invalidatePortfolioData } from './hooks';
import { managementKeys } from './management-hooks';

export const classificationKeys = {
  list: ['classification'] as const,
};

/** The public profile of a symbol (`assetKeys.detail`) is kept under this root; it carries the classification the screens show. */
const ASSET_DETAIL_ROOT_KEY = 'asset-detail';

/**
 * Everything that groups or labels by classification: the override list itself, the allocation, holdings, analytics, rebalance
 * and asset queries of every portfolio, the asset detail and the watchlist.
 */
export async function invalidateClassificationData(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: classificationKeys.list }),
    qc.invalidateQueries({ queryKey: [ASSET_DETAIL_ROOT_KEY] }),
    qc.invalidateQueries({ queryKey: managementKeys.watchlist }),
    invalidatePortfolioData(qc),
  ]);
}

export const useClassification = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: classificationKeys.list, queryFn: ({ signal }) => classificationApi.list(signal), enabled });

export function useSaveClassification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, fields }: { symbol: string; fields: ClassificationFields }) => classificationApi.put(symbol, fields),
    onSuccess: () => invalidateClassificationData(qc),
  });
}

export function useResetClassification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => classificationApi.remove(symbol),
    onSuccess: () => invalidateClassificationData(qc),
  });
}

/** `dryRun: true` only previews (nothing is stored, nothing is refreshed); a real import refreshes everything that depends on classification. */
export function useImportClassification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ClassificationImportRequest) => classificationApi.import(body),
    onSuccess: (_response, body) => (body.dryRun ? undefined : invalidateClassificationData(qc)),
  });
}
