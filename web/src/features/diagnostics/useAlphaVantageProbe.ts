import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { probeSummary, type AlphaVantageProbeStatus, type RunAlphaVantageProbeResponse } from '@portfolio/shared';
import { USE_MOCKS } from '../../config';
import { fetchAlphaVantageProbe, runAlphaVantageProbe, type ProbeOutcomeResponse } from './alphaVantageProbeClient';
import type { DiagnosticsAvailability } from './useAlarmDiagnostics';

export const ALPHAVANTAGE_PROBE_QUERY_KEY = ['diagnostics', 'alphavantage-probe'] as const;

/** What the demo and the mock mode show: the answer of a free key that hits a limit, as a sample. No request is made. */
export const SAMPLE_PROBE: RunAlphaVantageProbeResponse = {
  at: '2026-10-29T08:20:00.000Z',
  symbol: 'IBM',
  call: 'EARNINGS_ESTIMATES',
  outcome: 'rate-limited',
  summary: probeSummary('rate-limited'),
  message: 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.',
  budget: { provider: 'Alpha Vantage', day: '2026-10-29', used: 3, limit: 25, remaining: 22, calendarUsed: 1, calendarLimit: 1 },
};

const SAMPLE_STATUS: AlphaVantageProbeStatus = { available: true, reason: null, nextAllowedAt: null, budget: SAMPLE_PROBE.budget, last: null, sample: true };

export interface AlphaVantageProbeHook {
  availability: DiagnosticsAvailability;
  status?: AlphaVantageProbeStatus;
  error?: unknown;
  /** Runs the test (the "Test Alpha Vantage now" button); what came of it is in `outcome`. */
  runNow: () => void;
  isRunning: boolean;
  outcome?: ProbeOutcomeResponse;
  runError?: unknown;
}

/**
 * The "Test Alpha Vantage now" action of the Diagnostics page (personal Cloudflare deployment; the demo and the mock mode show a sample and never call).
 * A missing endpoint means "not exposed" and is not asked for again. No polling: the test is run by hand.
 */
export function useAlphaVantageProbe(): AlphaVantageProbeHook {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ALPHAVANTAGE_PROBE_QUERY_KEY,
    queryFn: ({ signal }) => fetchAlphaVantageProbe(signal),
    enabled: !USE_MOCKS,
    retry: false,
    staleTime: (q) => (q.state.data === null ? Infinity : 60_000),
  });
  const run = useMutation({
    mutationFn: (): Promise<ProbeOutcomeResponse> => (USE_MOCKS ? Promise.resolve({ accepted: true, result: SAMPLE_PROBE }) : runAlphaVantageProbe()),
    onSettled: () => client.invalidateQueries({ queryKey: ALPHAVANTAGE_PROBE_QUERY_KEY }),
  });
  const base = { runNow: () => run.mutate(), isRunning: run.isPending, outcome: run.data, runError: run.error ?? undefined };
  if (USE_MOCKS) return { ...base, availability: 'ready', status: SAMPLE_STATUS };
  if (query.data === null) return { ...base, availability: 'not-exposed' };
  if (query.data) return { ...base, availability: 'ready', status: query.data };
  if (query.isError) return { ...base, availability: 'error', error: query.error };
  return { ...base, availability: 'loading' };
}
