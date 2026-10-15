import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import {
  analyticsBenchmarkQuerySchema,
  analyticsMetricsQuerySchema,
  analyticsGoalQuerySchema,
  analyticsReturnsQuerySchema,
  analyticsRiskQuerySchema,
  computeAnalyticsSummary,
  computeBenchmark,
  computeDividendGrowth,
  computeGoal,
  computeMetrics,
  computeReturns,
  computeRisk,
  portfolioScopeSchema,
  type ApiError,
} from '@portfolio/shared';
import type { z } from 'zod';
import { API_BASE_URL } from '../config';
import * as db from './db';

/**
 * Mock backend for GET /analytics/*: the shared calculators run on the demo fixtures, exactly as the API runs them on
 * DynamoDB data, so the demo shows real numbers for every portfolio scope.
 */
const api = (path: string) => `${API_BASE_URL}/analytics${path}`;

const errorResponse = (status: number, code: string, message: string, details?: unknown): Response =>
  HttpResponse.json<ApiError>({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });

async function latency() {
  if (import.meta.env.MODE !== 'test') await delay(150 + (crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32) * 250);
}

/** Validates the query string with the API's schema and runs `compute` on the scoped demo data. */
export async function respond<S extends z.ZodTypeAny>(request: Request, schema: S, compute: (query: z.output<S>, data: ReturnType<typeof db.getAnalyticsData>) => unknown) {
  await latency();
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = schema.safeParse(params);
  if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.issues);
  try {
    const { portfolioId } = portfolioScopeSchema.parse(params);
    return HttpResponse.json(compute(parsed.data, db.getAnalyticsData(portfolioId)) as object);
  } catch (err) {
    if (err instanceof db.MockHttpError) return errorResponse(err.status, err.code, err.message, err.details);
    throw err;
  }
}

export const analyticsHandlers: HttpHandler[] = [
  http.get(api('/summary'), ({ request }) => respond(request, portfolioScopeSchema, (_q, data) => computeAnalyticsSummary(data))),
  http.get(api('/returns'), ({ request }) => respond(request, analyticsReturnsQuerySchema, (q, data) => computeReturns(data, q.period))),
  http.get(api('/risk'), ({ request }) => respond(request, analyticsRiskQuerySchema, (q, data) => computeRisk(data, q.benchmark))),
  http.get(api('/benchmark'), ({ request }) => respond(request, analyticsBenchmarkQuerySchema, (q, data) => computeBenchmark(data, q.benchmark, q.range))),
  http.get(api('/metrics'), ({ request }) => respond(request, analyticsMetricsQuerySchema, (q, data) => computeMetrics(data, q.benchmark))),
  http.get(api('/dividend-growth'), ({ request }) => respond(request, portfolioScopeSchema, (_q, data) => computeDividendGrowth(data))),
  http.get(api('/goal'), ({ request }) => respond(request, analyticsGoalQuerySchema, ({ portfolioId: _scope, ...q }, data) => computeGoal(data, q))),
];
