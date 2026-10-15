import { ALL_PORTFOLIOS, type CalendarParams, type GetCalendarResponse } from '@portfolio/shared';
import { authorizationHeaders, notifyUnauthorized } from '../features/auth/tokenHooks';
import { ApiError, apiUrl, request } from './client';

const NETWORK_ERROR = 'Could not reach the server. Check your connection and try again.';
const DEFAULT_ICS_NAME = 'portfolio-calendar.ics';

/** Query string of GET /calendar and /calendar.ics: `?portfolioId=` for one portfolio, omitted for the combined view. */
function calendarQuery(scope: string, params: CalendarParams): Record<string, string | undefined> {
  const list = (values: readonly string[] | undefined) => (values && values.length > 0 ? values.join(',') : undefined);
  return {
    ...(scope === ALL_PORTFOLIOS ? {} : { portfolioId: scope }),
    from: params.from,
    to: params.to,
    types: list(params.types),
    status: list(params.status),
    scope: params.scope,
  };
}

function errorOf(status: number, statusText: string, text: string): ApiError {
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
    if (typeof body.error?.message === 'string') return new ApiError(status, body.error.code ?? `HTTP_${status}`, body.error.message, body.error.details);
  } catch {
    // Not a JSON error envelope: fall through to the status line.
  }
  return new ApiError(status, `HTTP_${status}`, statusText || `Request failed with status ${status}`);
}

export const filenameFromDisposition = (header: string | null): string => /filename="?([^";]+)"?/i.exec(header ?? '')?.[1] ?? DEFAULT_ICS_NAME;

export interface IcsDownload {
  fileName: string;
  text: string;
}

export const calendarApi = {
  get: (scope: string, params: CalendarParams, signal?: AbortSignal) =>
    request<GetCalendarResponse>('GET', '/calendar', { query: calendarQuery(scope, params), signal }),

  /** The .ics document: fetched with the user's token and saved as a file (calendar apps cannot send a JWT, so it is no subscription URL). */
  async downloadIcs(scope: string, params: CalendarParams, signal?: AbortSignal): Promise<IcsDownload> {
    let res: Response;
    try {
      res = await fetch(apiUrl('/calendar.ics', calendarQuery(scope, params)), { headers: { Accept: 'text/calendar', ...(await authorizationHeaders()) }, signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR);
    }
    const text = await res.text();
    if (res.status === 401) notifyUnauthorized();
    if (!res.ok) throw errorOf(res.status, res.statusText, text);
    return { fileName: filenameFromDisposition(res.headers.get('content-disposition')), text };
  },
};
