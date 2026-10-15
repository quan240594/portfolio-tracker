import { ALL_PORTFOLIOS, type CalendarParams, type GetCalendarResponse } from '@portfolio/shared';
import { request, requestText } from './client';

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
    const { text, headers } = await requestText('/calendar.ics', { accept: 'text/calendar', query: calendarQuery(scope, params), signal });
    return { fileName: filenameFromDisposition(headers.get('content-disposition')), text };
  },
};
