import { alarmDiagnosticsSchema, DIAGNOSTICS_ROUTES, type AlarmDiagnosticsReport } from '@portfolio/shared';
import { send } from '../../api/client';

/** `GET /diagnostics/alarms` path, derived from the shared route constant (`'GET /diagnostics/alarms'`). */
const ALARMS_PATH = DIAGNOSTICS_ROUTES.alarms.replace(/^GET /, '');

/** Statuses of a backend that has no such route (the AWS deployment) or does not show it to us. */
const NOT_EXPOSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405]);

/**
 * Reads the alarm diagnostics of the personal Cloudflare deployment. Resolves `null` when the backend does not expose them (a missing
 * route, or a body that is not a report, such as a static host's HTML fallback); rejects on network errors and server failures.
 * Like the usage reading it bypasses `request`: a 401 here must not sign the user out.
 */
export async function fetchAlarmDiagnostics(limit: number, signal?: AbortSignal): Promise<AlarmDiagnosticsReport | null> {
  const res = await send(ALARMS_PATH, { limit: String(limit) }, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new Error(`Diagnostics request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = alarmDiagnosticsSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
