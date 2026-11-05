import { DIVIDEND_DATES_ROUTES, dividendDatesSchema, type GetDividendDatesResponse } from '@portfolio/shared';
import { send } from '../../api/client';

const DATES_PATH = DIVIDEND_DATES_ROUTES.dividendDates.replace(/^GET /, '');
const REFRESH_PATH = DIVIDEND_DATES_ROUTES.refreshDividendDates.replace(/^POST /, '');

/** Statuses of a backend that has no such route (an older deployment) or does not show it to us. */
const NOT_EXPOSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405]);

/**
 * Reads the dividend dates report of the held symbols. Resolves `null` when the backend does not expose it or answers with something that is
 * not a report; rejects on network errors and server failures. Like the other diagnostics it bypasses `request`: a 401 here must not sign the user out.
 */
export async function fetchDividendDates(signal?: AbortSignal): Promise<GetDividendDatesResponse | null> {
  const res = await send(DATES_PATH, undefined, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new Error(`Dividend dates request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = dividendDatesSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export type CheckOutcome = { accepted: true } | { accepted: false; message: string };

async function refusalMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // The body is not JSON: the status below says enough.
  }
  return `The check was refused (status ${res.status}).`;
}

/** Asks the backend to read the dividends of the held symbols once. A refusal (once an hour, allowance spent, no key) comes back with its reason; other failures reject. */
export async function checkDividendsNow(): Promise<CheckOutcome> {
  const res = await send(REFRESH_PATH, undefined, { method: 'POST', headers: { Accept: 'application/json' } });
  if (res.status === 202) return { accepted: true };
  if (res.status === 429 || res.status === 503 || res.status === 404) return { accepted: false, message: await refusalMessage(res) };
  throw new Error(`Dividend check failed with status ${res.status}`);
}
