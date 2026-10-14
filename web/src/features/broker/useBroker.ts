import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import type { BrokerStatusResponse, ConnectBrokerRequest } from '@portfolio/shared';
import { brokerApi } from './brokerApi';

export const brokerKeys = {
  all: ['broker'] as const,
  status: (portfolioId: string) => ['broker', 'status', portfolioId] as const,
};

/** How often a running sync is polled (fast in tests). */
export const SYNC_POLL_MS = import.meta.env.MODE === 'test' ? 25 : 2500;

export interface BrokerOverview {
  /** The connected portfolio's status, if any (one credential set per user). */
  connected?: BrokerStatusResponse;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Status of every portfolio, because the connection belongs to one of them and the page has to find it. Polls while a
 * sync is running; when it finishes the imported transactions are refreshed.
 */
export function useBrokerOverview(portfolioIds: readonly string[]): BrokerOverview {
  const qc = useQueryClient();
  const results = useQueries({
    queries: portfolioIds.map((portfolioId) => ({
      queryKey: brokerKeys.status(portfolioId),
      queryFn: ({ signal }: { signal: AbortSignal }) => brokerApi.status(portfolioId, signal),
      staleTime: 0,
      refetchInterval: (query: { state: { data?: BrokerStatusResponse } }) =>
        query.state.data?.status === 'RUNNING' ? SYNC_POLL_MS : false,
    })),
  });
  const connected = results.map((r) => r.data).find((s) => s?.connected);
  return {
    ...(connected ? { connected } : {}),
    isLoading: results.some((r) => r.isLoading),
    error: results.find((r) => r.error)?.error,
    refetch: () => {
      void qc.invalidateQueries({ queryKey: brokerKeys.all });
    },
  };
}

/** Validates the key at Trading 212, stores it and starts the first sync. */
export function useConnectBroker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectBrokerRequest) => {
      await brokerApi.connect(input);
      await brokerApi.sync(input.portfolioId);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: brokerKeys.all }),
  });
}

export function useSyncBroker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (portfolioId: string) => brokerApi.sync(portfolioId),
    onSuccess: () => qc.invalidateQueries({ queryKey: brokerKeys.all }),
  });
}

export function useDisconnectBroker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => brokerApi.disconnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: brokerKeys.all }),
  });
}
