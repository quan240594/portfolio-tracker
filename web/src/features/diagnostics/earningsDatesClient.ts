import { EARNINGS_DATES_ROUTES, earningsDatesSchema, type GetEarningsDatesResponse } from '@portfolio/shared';
import { send } from '../../api/client';

const DATES_PATH = EARNINGS_DATES_ROUTES.earningsDates.replace(/^GET /, '');
const REFRESH_PATH = EARNINGS_DATES_ROUTES.refreshEarningsDates.replace(/^POST /, '');

/** Statuses of a backend that has no such route (an older deployment) or does not show it to us. */
const NOT_EXPOSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405]);

/**
 * Reads the earnings dates report of the held symbols. Resolves `null` when the backend does not expose it or answers with something that is
 * not a report; rejects on network errors and server failures. Like the other diagnostics it bypasses `request`: a 401 here must not sign the user out.
 */
export async function fetchEarningsDates(signal?: AbortSignal): Promise<GetEarningsDatesResponse | null> {
  const res = await send(DATES_PATH, undefined, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new Error(`Earnings dates request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = earningsDatesSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export type RefreshOutcome = { accepted: true } | { accepted: false; message: string };

async function refusalMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // The body is not JSON: the status below says enough.
  }
  return `The refresh was refused (status ${res.status}).`;
}

/** Asks the backend to run the calendar job once. A refusal (once an hour, allowance nearly used, no key) comes back with its reason; other failures reject. */
export async function refreshEarningsDates(): Promise<RefreshOutcome> {
  const res = await send(REFRESH_PATH, undefined, { method: 'POST', headers: { Accept: 'application/json' } });
  if (res.status === 202) return { accepted: true };
  if (res.status === 429 || res.status === 503 || res.status === 404) return { accepted: false, message: await refusalMessage(res) };
  throw new Error(`Earnings dates refresh failed with status ${res.status}`);
}
