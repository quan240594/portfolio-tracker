import { DIAGNOSTICS_ROUTES, pricesStatusHistorySchema, type PriceHistoryCoverage } from '@portfolio/shared';
import { send } from '../../api/client';

/** `GET /prices/status` path, derived from the shared route constant (`'GET /prices/status'`). */
const STATUS_PATH = DIAGNOSTICS_ROUTES.pricesStatus.replace(/^GET /, '');

/** Statuses of a backend that has no such route (the AWS deployment) or does not show it to us. */
const NOT_EXPOSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405]);

/**
 * Reads the price-data coverage of the held symbols from the personal Cloudflare deployment. Resolves `null` when the backend does not
 * expose it (a missing route, a body that is not a status, a Hub that predates the section, or one that could not read it); rejects on
 * network errors and server failures. Like the alarm diagnostics it bypasses `request`: a 401 here must not sign the user out.
 */
export async function fetchPriceCoverage(signal?: AbortSignal): Promise<PriceHistoryCoverage | null> {
  const res = await send(STATUS_PATH, undefined, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new Error(`Price status request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = pricesStatusHistorySchema.safeParse(body);
  return parsed.success ? (parsed.data.history ?? null) : null;
}
