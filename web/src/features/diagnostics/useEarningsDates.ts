import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GetEarningsDatesResponse } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { fetchEarningsDates, refreshEarningsDates, type RefreshOutcome } from './earningsDatesClient';
import type { DiagnosticsAvailability } from './useAlarmDiagnostics';

export const EARNINGS_DATES_QUERY_KEY = ['diagnostics', 'earnings-dates'] as const;

export interface EarningsDatesResult {
  availability: DiagnosticsAvailability;
  report?: GetEarningsDatesResponse;
  error?: unknown;
  refetch: () => void;
  isFetching: boolean;
  /** Queues the calendar job (the "Refresh earnings dates now" button); what came of it is in `outcome`. */
  refreshNow: () => void;
  isRefreshing: boolean;
  outcome?: RefreshOutcome;
  refreshError?: unknown;
}

/**
 * Why each held company has, or has not, an earnings date (Cloudflare and AWS deployments; the public demo never asks). A missing
 * endpoint means "not exposed" and is not asked for again. No polling: the Diagnostics page has a Refresh button.
 */
export function useEarningsDates(): EarningsDatesResult {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: EARNINGS_DATES_QUERY_KEY,
    queryFn: ({ signal }) => fetchEarningsDates(signal),
    enabled: !USE_MOCKS,
    retry: false,
    staleTime: (q) => (q.state.data === null ? Infinity : 60_000),
  });
  const refresh = useMutation({
    mutationFn: refreshEarningsDates,
    onSettled: () => client.invalidateQueries({ queryKey: EARNINGS_DATES_QUERY_KEY }),
  });
  const refetch = () => {
    query.refetch().catch(() => undefined);
  };
  const refreshNow = () => refresh.mutate();
  const base = { refetch, isFetching: query.isFetching, refreshNow, isRefreshing: refresh.isPending, outcome: refresh.data, refreshError: refresh.error ?? undefined };
  if (USE_MOCKS || query.data === null) return { ...base, availability: 'not-exposed' };
  if (query.data) return { ...base, availability: 'ready', report: query.data };
  if (query.isError) return { ...base, availability: 'error', error: query.error };
  return { ...base, availability: 'loading' };
}
