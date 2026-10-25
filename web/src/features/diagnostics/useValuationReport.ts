import { useQuery } from '@tanstack/react-query';
import type { GetValuationReportResponse } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { fetchValuationReport } from './valuationClient';

export interface ValuationReportResult {
  report?: GetValuationReportResponse;
  /** The backend has no such report (an older deployment). */
  notExposed: boolean;
  isLoading: boolean;
  error?: unknown;
}

/**
 * The chart reconciliation for `dates` (none: the default three days). It reads about a year of closes, so it only runs once the
 * user asks (`enabled`) and is not polled; asking for another day is another read.
 */
export function useValuationReport(dates: readonly string[] | undefined, enabled: boolean): ValuationReportResult {
  const query = useQuery({
    queryKey: ['diagnostics', 'valuation', dates?.join(',') ?? 'default'],
    queryFn: ({ signal }) => fetchValuationReport(dates, signal),
    enabled: enabled && !USE_MOCKS,
    retry: false,
    staleTime: 60_000,
  });
  if (query.data) return { report: query.data, notExposed: false, isLoading: false };
  if (query.isError) return { notExposed: false, isLoading: false, error: query.error };
  return { notExposed: query.data === null, isLoading: query.isFetching };
}
