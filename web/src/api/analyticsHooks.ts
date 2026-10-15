import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AnalyticsGoalParams, HistoryRange, ReturnPeriod } from '@portfolio/shared';
import { analyticsApi } from './analyticsClient';

/**
 * All analytics queries live under the `analytics` root with the scope as second segment, so
 * `invalidatePortfolioData` (see hooks.ts) refreshes them together with the other transaction-derived data.
 */
export const ANALYTICS_ROOT_KEY = 'analytics';

export const analyticsKeys = {
  summary: (scope: string) => [ANALYTICS_ROOT_KEY, scope, 'summary'] as const,
  returns: (scope: string, period: ReturnPeriod) => [ANALYTICS_ROOT_KEY, scope, 'returns', period] as const,
  risk: (scope: string, benchmark: string) => [ANALYTICS_ROOT_KEY, scope, 'risk', benchmark] as const,
  benchmark: (scope: string, benchmark: string, range: HistoryRange) => [ANALYTICS_ROOT_KEY, scope, 'benchmark', benchmark, range] as const,
  metrics: (scope: string, benchmark: string) => [ANALYTICS_ROOT_KEY, scope, 'metrics', benchmark] as const,
  dividendGrowth: (scope: string) => [ANALYTICS_ROOT_KEY, scope, 'dividend-growth'] as const,
  goal: (scope: string, params: AnalyticsGoalParams) => [ANALYTICS_ROOT_KEY, scope, 'goal', params] as const,
};

interface ReadOptions {
  /** False while the scope is not yet known to be valid (avoids 404s for stale ids). */
  enabled?: boolean;
}

export const useAnalyticsSummary = (scope: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: analyticsKeys.summary(scope), queryFn: ({ signal }) => analyticsApi.summary(scope, signal), enabled });

export const useAnalyticsReturns = (scope: string, period: ReturnPeriod, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.returns(scope, period),
    queryFn: ({ signal }) => analyticsApi.returns(scope, period, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsRisk = (scope: string, benchmark: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.risk(scope, benchmark),
    queryFn: ({ signal }) => analyticsApi.risk(scope, benchmark, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsBenchmark = (scope: string, benchmark: string, range: HistoryRange, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.benchmark(scope, benchmark, range),
    queryFn: ({ signal }) => analyticsApi.benchmark(scope, benchmark, range, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsMetrics = (scope: string, benchmark: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.metrics(scope, benchmark),
    queryFn: ({ signal }) => analyticsApi.metrics(scope, benchmark, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsDividendGrowth = (scope: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: analyticsKeys.dividendGrowth(scope), queryFn: ({ signal }) => analyticsApi.dividendGrowth(scope, signal), enabled });

export const useAnalyticsGoal = (scope: string, params: AnalyticsGoalParams, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.goal(scope, params),
    queryFn: ({ signal }) => analyticsApi.goal(scope, params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
