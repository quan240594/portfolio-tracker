import {
  ALL_PORTFOLIOS,
  type AnalyticsBenchmarkResponse,
  type AnalyticsDividendGrowthResponse,
  type AnalyticsGoalParams,
  type AnalyticsGoalResponse,
  type AnalyticsMetricsResponse,
  type AnalyticsReturnsResponse,
  type AnalyticsRiskResponse,
  type AnalyticsSummaryResponse,
  type HistoryRange,
  type ReturnPeriod,
} from '@portfolio/shared';
import { request } from './client';

/** `?portfolioId=` for one portfolio; omitted for the combined view. */
const scopeQuery = (scope: string) => (scope === ALL_PORTFOLIOS ? {} : { portfolioId: scope });

const stringify = (params: AnalyticsGoalParams): Record<string, string> =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

export const analyticsApi = {
  summary: (scope: string, signal?: AbortSignal) =>
    request<AnalyticsSummaryResponse>('GET', '/analytics/summary', { query: scopeQuery(scope), signal }),
  returns: (scope: string, period: ReturnPeriod, signal?: AbortSignal) =>
    request<AnalyticsReturnsResponse>('GET', '/analytics/returns', { query: { ...scopeQuery(scope), period }, signal }),
  risk: (scope: string, benchmark: string, signal?: AbortSignal) =>
    request<AnalyticsRiskResponse>('GET', '/analytics/risk', { query: { ...scopeQuery(scope), benchmark }, signal }),
  benchmark: (scope: string, benchmark: string, range: HistoryRange, signal?: AbortSignal) =>
    request<AnalyticsBenchmarkResponse>('GET', '/analytics/benchmark', { query: { ...scopeQuery(scope), benchmark, range }, signal }),
  metrics: (scope: string, benchmark: string, signal?: AbortSignal) =>
    request<AnalyticsMetricsResponse>('GET', '/analytics/metrics', { query: { ...scopeQuery(scope), benchmark }, signal }),
  dividendGrowth: (scope: string, signal?: AbortSignal) =>
    request<AnalyticsDividendGrowthResponse>('GET', '/analytics/dividend-growth', { query: scopeQuery(scope), signal }),
  goal: (scope: string, params: AnalyticsGoalParams, signal?: AbortSignal) =>
    request<AnalyticsGoalResponse>('GET', '/analytics/goal', { query: { ...scopeQuery(scope), ...stringify(params) }, signal }),
};
