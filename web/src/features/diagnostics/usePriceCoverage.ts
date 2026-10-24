import { useQuery } from '@tanstack/react-query';
import type { PriceHistoryCoverage } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { fetchPriceCoverage } from './priceCoverageClient';
import type { DiagnosticsAvailability } from './useAlarmDiagnostics';

export const PRICE_COVERAGE_QUERY_KEY = ['diagnostics', 'price-coverage'] as const;

export interface PriceCoverageResult {
  availability: DiagnosticsAvailability;
  coverage?: PriceHistoryCoverage;
  error?: unknown;
  refetch: () => void;
  isFetching: boolean;
}

/**
 * The price-data coverage of the held symbols (the Cloudflare deployment only). Mock mode (the public demo) never asks; a missing
 * endpoint means "not exposed" and is not asked for again. No polling: the Diagnostics page has a Refresh button.
 */
export function usePriceCoverage(): PriceCoverageResult {
  const query = useQuery({
    queryKey: PRICE_COVERAGE_QUERY_KEY,
    queryFn: ({ signal }) => fetchPriceCoverage(signal),
    enabled: !USE_MOCKS,
    retry: false,
    staleTime: (q) => (q.state.data === null ? Infinity : 60_000),
  });
  const refetch = () => {
    query.refetch().catch(() => undefined);
  };
  const base = { refetch, isFetching: query.isFetching };
  if (USE_MOCKS || query.data === null) return { ...base, availability: 'not-exposed' };
  if (query.data) return { ...base, availability: 'ready', coverage: query.data };
  if (query.isError) return { ...base, availability: 'error', error: query.error };
  return { ...base, availability: 'loading' };
}
