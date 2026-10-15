import { analyticsMetricsQuerySchema, computeMetrics, type AnalyticsMetricsResponse, type METRICS_ROUTES } from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import type { RouteHandler } from '../router.js';
import { loadAnalyticsData } from './analytics.js';

/** The five cards of Analytics → Metrics. The benchmark's own profile is loaded too, for its P/E when it has one. */
export async function getMetrics(ctx: RouteContext): Promise<RouteResult> {
  const { benchmark } = validate(analyticsMetricsQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const [data, benchmarkProfiles] = await Promise.all([
    loadAnalyticsData(ctx, { holdings: true, eod: true, benchmark }),
    ctx.deps.repo.getProfiles([benchmark]),
  ]);
  return ok(computeMetrics({ ...data, profiles: { ...benchmarkProfiles, ...data.profiles } }, benchmark) satisfies AnalyticsMetricsResponse);
}

export const metricsHandlers: Record<keyof typeof METRICS_ROUTES, RouteHandler> = {
  analyticsMetrics: getMetrics,
};
