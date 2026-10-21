import { useQuery } from '@tanstack/react-query';
import type { AlarmDiagnosticsReport } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { fetchAlarmDiagnostics } from './diagnosticsClient';

export const DIAGNOSTICS_QUERY_KEY = ['diagnostics', 'alarms'] as const;

/** How many runs the page asks for. */
export const DIAGNOSTICS_RUNS = 50;

export type DiagnosticsAvailability =
  /** The first reading is on its way. */
  | 'loading'
  /** A report is available. */
  | 'ready'
  /** The backend has no such endpoint (the AWS deployment, the demo): offer nothing. */
  | 'not-exposed'
  /** The endpoint could not be read. */
  | 'error';

export interface AlarmDiagnosticsResult {
  availability: DiagnosticsAvailability;
  report?: AlarmDiagnosticsReport;
  error?: unknown;
  refetch: () => void;
  isFetching: boolean;
}

/**
 * The alarm diagnostics of the personal Cloudflare deployment, `limit` runs. Mock mode (the public demo) never asks; a missing
 * endpoint means "not exposed" and is not asked for again. No polling: the page has a Refresh button.
 */
export function useAlarmDiagnostics(limit: number = DIAGNOSTICS_RUNS, { enabled = true }: { enabled?: boolean } = {}): AlarmDiagnosticsResult {
  const query = useQuery({
    queryKey: [...DIAGNOSTICS_QUERY_KEY, limit],
    queryFn: ({ signal }) => fetchAlarmDiagnostics(limit, signal),
    enabled: enabled && !USE_MOCKS,
    retry: false,
    staleTime: (q) => (q.state.data === null ? Infinity : 60_000),
  });
  const refetch = () => {
    query.refetch().catch(() => undefined);
  };
  const base = { refetch, isFetching: query.isFetching };
  if (USE_MOCKS || query.data === null) return { ...base, availability: 'not-exposed' };
  if (query.data) return { ...base, availability: 'ready', report: query.data };
  if (query.isError) return { ...base, availability: 'error', error: query.error };
  return { ...base, availability: 'loading' };
}
