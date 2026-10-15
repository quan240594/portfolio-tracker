import { http, HttpResponse, type HttpHandler } from 'msw';
import { computeDividendsOverview, portfolioScopeSchema, type DividendsOverviewResponse } from '@portfolio/shared';
import * as db from './db';
import { api, errorResponse, guard, latency } from './utils';

/**
 * Mock backend for GET /dividends/overview: the shared calculator runs on the (scoped) demo fixtures, exactly as the
 * API runs it on DynamoDB data.
 */
export const dividendsOverviewHandlers: HttpHandler[] = [
  http.get(api('/dividends/overview'), async ({ request }) => {
    await latency();
    const parsed = portfolioScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.issues);
    return guard(() => HttpResponse.json<DividendsOverviewResponse>(computeDividendsOverview(db.getAnalyticsData(parsed.data.portfolioId))))();
  }),
];
