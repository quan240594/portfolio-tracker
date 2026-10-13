import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AllocationDimension, CreateTransactionRequest, HistoryRange } from '@portfolio/shared';
import { api } from './client';

export const queryKeys = {
  portfolio: ['portfolio'] as const,
  holdings: ['holdings'] as const,
  allocation: (by: AllocationDimension) => ['allocation', by] as const,
  history: (range: HistoryRange) => ['history', range] as const,
  dividends: ['dividends'] as const,
  transactions: ['transactions'] as const,
  import: (id: string) => ['imports', id] as const,
};

/** Root keys of everything derived from transactions. */
const PORTFOLIO_ROOT_KEYS = ['portfolio', 'holdings', 'allocation', 'history', 'dividends', 'transactions'] as const;

export function invalidatePortfolioData(qc: QueryClient): Promise<void> {
  return Promise.all(PORTFOLIO_ROOT_KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] }))).then(() => undefined);
}

export const usePortfolio = () =>
  useQuery({ queryKey: queryKeys.portfolio, queryFn: ({ signal }) => api.getPortfolio(signal) });

export const useHoldings = () =>
  useQuery({ queryKey: queryKeys.holdings, queryFn: ({ signal }) => api.getHoldings(signal) });

export const useAllocation = (by: AllocationDimension) =>
  useQuery({
    queryKey: queryKeys.allocation(by),
    queryFn: ({ signal }) => api.getAllocation(by, signal),
    placeholderData: keepPreviousData,
  });

export const useHistory = (range: HistoryRange) =>
  useQuery({
    queryKey: queryKeys.history(range),
    queryFn: ({ signal }) => api.getHistory(range, signal),
    placeholderData: keepPreviousData,
  });

export const useDividends = () =>
  useQuery({ queryKey: queryKeys.dividends, queryFn: ({ signal }) => api.getDividends(signal) });

export const useTransactions = () =>
  useQuery({ queryKey: queryKeys.transactions, queryFn: ({ signal }) => api.listTransactions(signal) });

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransactionRequest) => api.createTransaction(input),
    onSuccess: () => invalidatePortfolioData(qc),
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTransaction(id),
    onSuccess: () => invalidatePortfolioData(qc),
  });
}
