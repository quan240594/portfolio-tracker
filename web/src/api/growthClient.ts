import {
  type AnalyticsGrowthResponse,
  type AnalyticsHoldingsPerformanceResponse,
  type GrowthRange,
} from '@portfolio/shared';
import { request, scopeQuery } from './client';

export const growthApi = {
  /** `benchmarks` is always sent (even empty): omitting it would select the default benchmark. */
  growth: (scope: string, range: GrowthRange, benchmarks: readonly string[], signal?: AbortSignal) =>
    request<AnalyticsGrowthResponse>('GET', '/analytics/growth', { query: { ...scopeQuery(scope), range, benchmarks: benchmarks.join(',') }, signal }),
  holdingsPerformance: (scope: string, range: GrowthRange, signal?: AbortSignal) =>
    request<AnalyticsHoldingsPerformanceResponse>('GET', '/analytics/holdings-performance', { query: { ...scopeQuery(scope), range }, signal }),
};
