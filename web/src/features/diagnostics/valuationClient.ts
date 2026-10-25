import { valuationReportSchema, type GetValuationReportResponse } from '@portfolio/shared';
import { send } from '../../api/client';

const VALUATION_PATH = '/diagnostics/valuation';

/** Statuses of a backend that has no such route or does not show it to us. */
const NOT_EXPOSED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 405]);

/**
 * Reads the chart reconciliation (`GET /diagnostics/valuation`) for `dates` (none: today, yesterday and about six months back).
 * Resolves `null` when the backend does not expose it or answers with something that is not a report; rejects on network errors
 * and server failures. Like the other diagnostics it bypasses `request`: a 401 here must not sign the user out.
 */
export async function fetchValuationReport(dates: readonly string[] | undefined, signal?: AbortSignal): Promise<GetValuationReportResponse | null> {
  const query = dates === undefined ? undefined : { dates: dates.join(',') };
  const res = await send(VALUATION_PATH, query, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  if (NOT_EXPOSED_STATUSES.has(res.status)) return null;
  if (!res.ok) throw new Error(`Valuation report request failed with status ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const parsed = valuationReportSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
