import {
  ALL_PORTFOLIOS,
  type AnalyticsBenchmarkResponse,
  type AnalyticsDividendGrowthResponse,
  type AnalyticsGoalParams,
  type AnalyticsGoalResponse,
  type AnalyticsReturnsResponse,
  type AnalyticsRiskResponse,
  type AnalyticsSummaryResponse,
  type HistoryRange,
  type ReturnPeriod,
} from '@portfolio/shared';
import { request, type Scope } from './client';

/** `?portfolioId=` for one portfolio; omitted for the combined view. */
const scopeQuery = (scope: Scope) => (scope === ALL_PORTFOLIOS ? {} : { portfolioId: scope });

const stringify = (params: AnalyticsGoalParams): Record<string, string> =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

export const analyticsApi = {
  summary: (scope: Scope, signal?: AbortSignal) =>
    request<AnalyticsSummaryResponse>('GET', '/analytics/summary', { query: scopeQuery(scope), signal }),
  returns: (scope: Scope, period: ReturnPeriod, signal?: AbortSignal) =>
    request<AnalyticsReturnsResponse>('GET', '/analytics/returns', { query: { ...scopeQuery(scope), period }, signal }),
  risk: (scope: Scope, benchmark: string, signal?: AbortSignal) =>
    request<AnalyticsRiskResponse>('GET', '/analytics/risk', { query: { ...scopeQuery(scope), benchmark }, signal }),
  benchmark: (scope: Scope, benchmark: string, range: HistoryRange, signal?: AbortSignal) =>
    request<AnalyticsBenchmarkResponse>('GET', '/analytics/benchmark', { query: { ...scopeQuery(scope), benchmark, range }, signal }),
  dividendGrowth: (scope: Scope, signal?: AbortSignal) =>
    request<AnalyticsDividendGrowthResponse>('GET', '/analytics/dividend-growth', { query: scopeQuery(scope), signal }),
  goal: (scope: Scope, params: AnalyticsGoalParams, signal?: AbortSignal) =>
    request<AnalyticsGoalResponse>('GET', '/analytics/goal', { query: { ...scopeQuery(scope), ...stringify(params) }, signal }),
};
