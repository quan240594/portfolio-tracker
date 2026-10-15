import {
  ALL_PORTFOLIOS,
  type AnalyticsGrowthResponse,
  type AnalyticsHoldingsPerformanceResponse,
  type GrowthRange,
} from '@portfolio/shared';
import { request, type Scope } from './client';

const scopeQuery = (scope: Scope) => (scope === ALL_PORTFOLIOS ? {} : { portfolioId: scope });

export const growthApi = {
  /** `benchmarks` is always sent (even empty): omitting it would select the default benchmark. */
  growth: (scope: Scope, range: GrowthRange, benchmarks: readonly string[], signal?: AbortSignal) =>
    request<AnalyticsGrowthResponse>('GET', '/analytics/growth', { query: { ...scopeQuery(scope), range, benchmarks: benchmarks.join(',') }, signal }),
  holdingsPerformance: (scope: Scope, range: GrowthRange, signal?: AbortSignal) =>
    request<AnalyticsHoldingsPerformanceResponse>('GET', '/analytics/holdings-performance', { query: { ...scopeQuery(scope), range }, signal }),
};
