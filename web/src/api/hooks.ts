import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ALL_PORTFOLIOS, type AllocationDimension, type CreateTransactionRequest, type HistoryRange, type Transaction } from '@portfolio/shared';
import { api, type Scope } from './client';

export const queryKeys = {
  portfolios: ['portfolios'] as const,
  portfolio: (scope: Scope) => ['portfolio', scope] as const,
  holdings: (scope: Scope) => ['holdings', scope] as const,
  allocation: (scope: Scope, by: AllocationDimension) => ['allocation', scope, by] as const,
  history: (scope: Scope, range: HistoryRange) => ['history', scope, range] as const,
  dividends: (scope: Scope) => ['dividends', scope] as const,
  transactions: (scope: Scope) => ['transactions', scope] as const,
  import: (id: string) => ['imports', id] as const,
};

/** Root keys of everything derived from transactions; the second key segment is the scope. */
const PORTFOLIO_ROOT_KEYS = ['portfolio', 'holdings', 'allocation', 'history', 'dividends', 'transactions'] as const;

/**
 * Invalidates transaction-derived queries. With a portfolio id only that portfolio's queries and the
 * combined ('all') view are refreshed; without one every scope is.
 */
export function invalidatePortfolioData(qc: QueryClient, portfolioId?: string): Promise<void> {
  const scopes = portfolioId ? [...new Set([portfolioId, ALL_PORTFOLIOS])] : [undefined];
  return Promise.all(
    PORTFOLIO_ROOT_KEYS.flatMap((k) => scopes.map((s) => qc.invalidateQueries({ queryKey: s ? [k, s] : [k] }))),
  ).then(() => undefined);
}

interface ReadOptions {
  /** False while the scope is not yet known to be valid (avoids 404s for stale ids). */
  enabled?: boolean;
}

export const usePortfolios = () =>
  useQuery({ queryKey: queryKeys.portfolios, queryFn: ({ signal }) => api.listPortfolios(signal), staleTime: 60_000 });

export const usePortfolio = (scope: Scope, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: queryKeys.portfolio(scope), queryFn: ({ signal }) => api.getPortfolio(scope, signal), enabled });

export const useHoldings = (scope: Scope, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: queryKeys.holdings(scope), queryFn: ({ signal }) => api.getHoldings(scope, signal), enabled });

export const useAllocation = (scope: Scope, by: AllocationDimension, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: queryKeys.allocation(scope, by),
    queryFn: ({ signal }) => api.getAllocation(scope, by, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useHistory = (scope: Scope, range: HistoryRange, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: queryKeys.history(scope, range),
    queryFn: ({ signal }) => api.getHistory(scope, range, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useDividends = (scope: Scope, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: queryKeys.dividends(scope), queryFn: ({ signal }) => api.getDividends(scope, signal), enabled });

export const useTransactions = (scope: Scope, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: queryKeys.transactions(scope), queryFn: ({ signal }) => api.listTransactions(scope, signal), enabled });

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransactionRequest) => api.createTransaction(input),
    onSuccess: (txn) => invalidatePortfolioData(qc, txn.portfolioId),
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (txn: Pick<Transaction, 'id' | 'portfolioId'>) => api.deleteTransaction(txn.id),
    onSuccess: (_data, txn) => invalidatePortfolioData(qc, txn.portfolioId),
  });
}

export function useCreatePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createPortfolio(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.portfolios }),
  });
}

export function useRenamePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renamePortfolio(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.portfolios }),
  });
}

export function useDeletePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force = false }: { id: string; force?: boolean }) => api.deletePortfolio(id, force),
    onSuccess: async (_data, { id }) => {
      // Refresh the list first so a scope pointing at the deleted portfolio falls back to 'all'.
      await qc.invalidateQueries({ queryKey: queryKeys.portfolios });
      for (const k of PORTFOLIO_ROOT_KEYS) qc.removeQueries({ queryKey: [k, id] });
      await invalidatePortfolioData(qc, ALL_PORTFOLIOS);
    },
  });
}
