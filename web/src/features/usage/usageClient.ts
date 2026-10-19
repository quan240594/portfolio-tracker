import { usageSnapshotSchema, USAGE_ROUTES, type UsageSnapshot } from '@portfolio/shared';
import { send } from '../../api/client';

/** `GET /usage` path, derived from the shared route constant (`'GET /usage'`). */
const USAGE_PATH = USAGE_ROUTES.usage.replace(/^GET /, '');

/** Statuses of a backend that does not offer (or does not show us) the usage endpoint, e.g. the AWS deployment. */
const NOT_EXPOSED_STATUSES: readonly number[] = [401, 403, 404, 405];

/**
 * Reads the free-plan usage. Resolves `null` when the backend does not expose it (a missing route, or a body that is not
 * a usage snapshot, such as a static host's HTML fallback); rejects on network errors and server failures.
 * Deliberately bypasses `request`: a 401 here must not sign the user out, and a usage failure is never an error to show.
 */
export async function fetchUsage(signal?: AbortSignal): Promise<UsageSnapshot | null> {
  const res = await send(USAGE_PATH, undefined, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.includes(res.status)) return null;
  if (!res.ok) throw new Error(`Usage request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = usageSnapshotSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
