import { useQuery } from '@tanstack/react-query';
import type { DividendsOverviewResponse } from '@portfolio/shared';
import { request, scopeQuery } from '../../api/client';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

/** Under the `dividends` root so `invalidatePortfolioData` refreshes it together with the other dividend data. */
export const dividendsOverviewKey = (scope: string) => ['dividends', scope, 'overview'] as const;

export const dividendsOverviewApi = {
  get: (scope: string, signal?: AbortSignal) => request<DividendsOverviewResponse>('GET', '/dividends/overview', { query: scopeQuery(scope), signal }),
};

export const useDividendsOverview = (scope: string, { enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: dividendsOverviewKey(scope), queryFn: ({ signal }) => dividendsOverviewApi.get(scope, signal), enabled });

/** The overview of the active portfolio scope (all cards share one request through the query cache). */
export function useScopedDividendsOverview() {
  const { scope, ready } = usePortfolioScope();
  return useDividendsOverview(scope, { enabled: ready });
}
