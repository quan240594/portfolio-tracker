import { useQuery } from '@tanstack/react-query';
import type { UsageSnapshot } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { fetchUsage } from './usageClient';

export const USAGE_QUERY_KEY = ['usage'] as const;

/** A gentle poll: the guard's ledger moves slowly, and react-query pauses interval refetches while the tab is hidden. */
export const USAGE_POLL_MS = 5 * 60_000;
/** Focus refetches only when the reading is older than this. */
export const USAGE_STALE_MS = 60_000;

export type UsageAvailability =
  /** The first reading is on its way. */
  | 'loading'
  /** A snapshot is available (possibly the last good one while a refresh failed). */
  | 'ready'
  /** The backend has no usage endpoint (the AWS deployment, the demo): show nothing, never ask again. */
  | 'not-exposed'
  /** The endpoint could not be reached and there is no earlier reading: show nothing, keep trying gently. */
  | 'unreachable';

export interface UsageResult {
  availability: UsageAvailability;
  snapshot?: UsageSnapshot;
}

/**
 * The free-plan usage of the personal Cloudflare deployment. Mock mode (the public demo) never asks. A missing endpoint
 * (404 and friends) or an unreadable body means "not exposed": the query stops polling and nothing is shown. Network and
 * server errors keep the last reading and retry on the next poll or when the window regains focus.
 */
export function useUsage(): UsageResult {
  const query = useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: ({ signal }) => fetchUsage(signal),
    enabled: !USE_MOCKS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data === null ? false : USAGE_POLL_MS),
    staleTime: (q) => (q.state.data === null ? Infinity : USAGE_STALE_MS),
  });
  if (USE_MOCKS || query.data === null) return { availability: 'not-exposed' };
  if (query.data) return { availability: 'ready', snapshot: query.data };
  return { availability: query.isError ? 'unreachable' : 'loading' };
}
