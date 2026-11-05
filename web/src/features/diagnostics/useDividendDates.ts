import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GetDividendDatesResponse } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { checkDividendsNow, fetchDividendDates, type CheckOutcome } from './dividendDatesClient';
import type { DiagnosticsAvailability } from './useAlarmDiagnostics';

export const DIVIDEND_DATES_QUERY_KEY = ['diagnostics', 'dividend-dates'] as const;

export interface DividendDatesResult {
  availability: DiagnosticsAvailability;
  report?: GetDividendDatesResponse;
  error?: unknown;
  refetch: () => void;
  isFetching: boolean;
  /** Queues a dividends-only calendar run (the "Check dividends now" button); what came of it is in `outcome`. */
  checkNow: () => void;
  isChecking: boolean;
  outcome?: CheckOutcome;
  checkError?: unknown;
}

/**
 * Why each held symbol has, or has not, a declared dividend date (Cloudflare and AWS deployments; the public demo never asks). A missing
 * endpoint means "not exposed" and is not asked for again. No polling: the Diagnostics page has a Refresh button.
 */
export function useDividendDates(): DividendDatesResult {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: DIVIDEND_DATES_QUERY_KEY,
    queryFn: ({ signal }) => fetchDividendDates(signal),
    enabled: !USE_MOCKS,
    retry: false,
    staleTime: (q) => (q.state.data === null ? Infinity : 60_000),
  });
  const check = useMutation({
    mutationFn: checkDividendsNow,
    onSettled: () => client.invalidateQueries({ queryKey: DIVIDEND_DATES_QUERY_KEY }),
  });
  const refetch = () => {
    query.refetch().catch(() => undefined);
  };
  const checkNow = () => check.mutate();
  const base = { refetch, isFetching: query.isFetching, checkNow, isChecking: check.isPending, outcome: check.data, checkError: check.error ?? undefined };
  if (USE_MOCKS || query.data === null) return { ...base, availability: 'not-exposed' };
  if (query.data) return { ...base, availability: 'ready', report: query.data };
  if (query.isError) return { ...base, availability: 'error', error: query.error };
  return { ...base, availability: 'loading' };
}
