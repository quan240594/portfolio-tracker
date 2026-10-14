import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignCategoryHoldingsRequest,
  CreateCategoryRequest,
  CreateCustomAssetRequest,
  PutValuationRequest,
  RebalanceQuery,
  UpdateCategoryRequest,
  UpdateCustomAssetRequest,
  UpdatePortfolioSettingsRequest,
} from '@portfolio/shared';
import { invalidatePortfolioData } from './hooks';
import { managementApi } from './management-client';

export const managementKeys = {
  settings: (portfolioId: string) => ['settings', portfolioId] as const,
  categories: (portfolioId: string) => ['categories', portfolioId] as const,
  rebalance: (portfolioId: string, query: RebalanceQuery) => ['rebalance', portfolioId, query] as const,
  assets: (portfolioId: string) => ['assets', portfolioId] as const,
  watchlist: ['watchlist'] as const,
};

interface Enabled {
  enabled?: boolean;
}

export const usePortfolioSettings = (portfolioId: string | undefined, { enabled = true }: Enabled = {}) =>
  useQuery({
    queryKey: managementKeys.settings(portfolioId ?? ''),
    queryFn: ({ signal }) => managementApi.getSettings(portfolioId!, signal),
    enabled: enabled && portfolioId !== undefined,
  });

export const useCategories = (portfolioId: string | undefined, { enabled = true }: Enabled = {}) =>
  useQuery({
    queryKey: managementKeys.categories(portfolioId ?? ''),
    queryFn: ({ signal }) => managementApi.listCategories(portfolioId!, signal),
    enabled: enabled && portfolioId !== undefined,
  });

export const useRebalance = (portfolioId: string | undefined, query: RebalanceQuery | null) =>
  useQuery({
    queryKey: managementKeys.rebalance(portfolioId ?? '', query ?? {}),
    queryFn: ({ signal }) => managementApi.getRebalance(portfolioId!, query!, signal),
    enabled: portfolioId !== undefined && query !== null,
  });

export const useAssets = (portfolioId: string | undefined, { enabled = true }: Enabled = {}) =>
  useQuery({
    queryKey: managementKeys.assets(portfolioId ?? ''),
    queryFn: ({ signal }) => managementApi.listAssets(portfolioId!, signal),
    enabled: enabled && portfolioId !== undefined,
  });

export const useWatchlist = () =>
  useQuery({ queryKey: managementKeys.watchlist, queryFn: ({ signal }) => managementApi.listWatchlist(signal), staleTime: 60_000 });

/** A mutation on a portfolio's management data: refreshes `ownKey` plus everything derived from holdings. */
function usePortfolioMutation<V, R>(portfolioId: string, ownKey: readonly unknown[], fn: (vars: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ownKey }), invalidatePortfolioData(qc, portfolioId)]);
    },
  });
}

export const useUpdateSettings = (portfolioId: string) =>
  usePortfolioMutation(portfolioId, managementKeys.settings(portfolioId), (body: UpdatePortfolioSettingsRequest) =>
    managementApi.updateSettings(portfolioId, body),
  );

export function useCategoryMutations(portfolioId: string) {
  const key = managementKeys.categories(portfolioId);
  return {
    create: usePortfolioMutation(portfolioId, key, (body: CreateCategoryRequest) => managementApi.createCategory(portfolioId, body)),
    update: usePortfolioMutation(portfolioId, key, ({ id, body }: { id: string; body: UpdateCategoryRequest }) =>
      managementApi.updateCategory(portfolioId, id, body),
    ),
    remove: usePortfolioMutation(portfolioId, key, (id: string) => managementApi.deleteCategory(portfolioId, id)),
    assign: usePortfolioMutation(portfolioId, key, ({ id, body }: { id: string; body: AssignCategoryHoldingsRequest }) =>
      managementApi.assignHoldings(portfolioId, id, body),
    ),
  };
}

export function useAssetMutations(portfolioId: string) {
  const key = managementKeys.assets(portfolioId);
  return {
    create: usePortfolioMutation(portfolioId, key, (body: CreateCustomAssetRequest) => managementApi.createAsset(portfolioId, body)),
    update: usePortfolioMutation(portfolioId, key, ({ id, body }: { id: string; body: UpdateCustomAssetRequest }) =>
      managementApi.updateAsset(portfolioId, id, body),
    ),
    remove: usePortfolioMutation(portfolioId, key, (id: string) => managementApi.deleteAsset(portfolioId, id)),
    putValuation: usePortfolioMutation(portfolioId, key, ({ id, body }: { id: string; body: PutValuationRequest }) =>
      managementApi.putValuation(portfolioId, id, body),
    ),
    deleteValuation: usePortfolioMutation(portfolioId, key, ({ id, date }: { id: string; date: string }) =>
      managementApi.deleteValuation(portfolioId, id, date),
    ),
  };
}

export function useWatchlistMutations() {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: managementKeys.watchlist });
  return {
    add: useMutation({ mutationFn: (symbol: string) => managementApi.addWatchlist({ symbol }), onSuccess }),
    remove: useMutation({ mutationFn: (symbol: string) => managementApi.removeWatchlist(symbol), onSuccess }),
  };
}
