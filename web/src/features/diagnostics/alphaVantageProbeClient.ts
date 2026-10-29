import { ALPHAVANTAGE_PROBE_ROUTES, alphaVantageProbeResultSchema, alphaVantageProbeStatusSchema, type AlphaVantageProbeStatus, type RunAlphaVantageProbeResponse } from '@portfolio/shared';
import { send } from '../../api/client';

const STATUS_PATH = ALPHAVANTAGE_PROBE_ROUTES.alphaVantageProbeStatus.replace(/^GET /, '');
const RUN_PATH = ALPHAVANTAGE_PROBE_ROUTES.alphaVantageProbe.replace(/^POST /, '');

/** Statuses of a backend that has no such route (an older deployment) or does not show it to us. */
const NOT_EXPOSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405]);

/**
 * Whether the Alpha Vantage test may run now and the last result. Resolves `null` when the backend does not expose it or answers with something else;
 * rejects on network errors and server failures. Like the other diagnostics it bypasses `request`: a 401 here must not sign the user out.
 */
export async function fetchAlphaVantageProbe(signal?: AbortSignal): Promise<AlphaVantageProbeStatus | null> {
  const res = await send(STATUS_PATH, undefined, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new Error(`Alpha Vantage test status request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = alphaVantageProbeStatusSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export type ProbeOutcomeResponse = { accepted: true; result: RunAlphaVantageProbeResponse } | { accepted: false; message: string };

async function refusalMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // The body is not JSON: the status below says enough.
  }
  return `The test was refused (status ${res.status}).`;
}

/** Runs the test (one call of the provider's allowance). A refusal (once per 10 minutes, allowance nearly used, no key) comes back with its reason; other failures reject. */
export async function runAlphaVantageProbe(): Promise<ProbeOutcomeResponse> {
  const res = await send(RUN_PATH, undefined, { method: 'POST', headers: { Accept: 'application/json' } });
  if (res.status === 429 || res.status === 503 || res.status === 404) return { accepted: false, message: await refusalMessage(res) };
  if (!res.ok) throw new Error(`Alpha Vantage test failed with status ${res.status}`);
  const parsed = alphaVantageProbeResultSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('Alpha Vantage test answered with something unexpected');
  return { accepted: true, result: parsed.data };
}
