import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { earningsApi } from './earningsClient';

export const earningsKeys = { all: ['earnings'] as const, list: (symbol?: string, limit?: number) => ['earnings', 'list', symbol ?? 'all', limit ?? 'default'] as const, status: ['earnings', 'status'] as const };

/**
 * Whether the deployment has the feature and how it is doing. A failure counts as "not available" (the menu entry stays hidden): the page
 * itself reports errors. Cheap: one API request per page load, shared by the menu, the page and the asset detail section.
 */
export const useEarningsStatus = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: earningsKeys.status, queryFn: ({ signal }) => earningsApi.status(signal), enabled, staleTime: 60_000, retry: false });

export const useEarnings = (params: { symbol?: string; limit?: number } = {}, { enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: earningsKeys.list(params.symbol, params.limit), queryFn: ({ signal }) => earningsApi.list(params, signal), enabled });

export function useRefreshEarnings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (symbol: string) => earningsApi.refresh(symbol), onSettled: () => qc.invalidateQueries({ queryKey: earningsKeys.all }) });
}
