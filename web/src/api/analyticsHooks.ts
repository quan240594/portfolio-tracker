import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AnalyticsGoalParams, HistoryRange, ReturnPeriod } from '@portfolio/shared';
import type { Scope } from './client';
import { analyticsApi } from './analyticsClient';

/**
 * All analytics queries live under the `analytics` root with the scope as second segment, so
 * `invalidatePortfolioData` (see hooks.ts) refreshes them together with the other transaction-derived data.
 */
export const ANALYTICS_ROOT_KEY = 'analytics';

export const analyticsKeys = {
  summary: (scope: Scope) => [ANALYTICS_ROOT_KEY, scope, 'summary'] as const,
  returns: (scope: Scope, period: ReturnPeriod) => [ANALYTICS_ROOT_KEY, scope, 'returns', period] as const,
  risk: (scope: Scope, benchmark: string) => [ANALYTICS_ROOT_KEY, scope, 'risk', benchmark] as const,
  benchmark: (scope: Scope, benchmark: string, range: HistoryRange) => [ANALYTICS_ROOT_KEY, scope, 'benchmark', benchmark, range] as const,
  dividendGrowth: (scope: Scope) => [ANALYTICS_ROOT_KEY, scope, 'dividend-growth'] as const,
  goal: (scope: Scope, params: AnalyticsGoalParams) => [ANALYTICS_ROOT_KEY, scope, 'goal', params] as const,
};

interface ReadOptions {
  /** False while the scope is not yet known to be valid (avoids 404s for stale ids). */
  enabled?: boolean;
}

export const useAnalyticsSummary = (scope: Scope, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: analyticsKeys.summary(scope), queryFn: ({ signal }) => analyticsApi.summary(scope, signal), enabled });

export const useAnalyticsReturns = (scope: Scope, period: ReturnPeriod, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.returns(scope, period),
    queryFn: ({ signal }) => analyticsApi.returns(scope, period, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsRisk = (scope: Scope, benchmark: string, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.risk(scope, benchmark),
    queryFn: ({ signal }) => analyticsApi.risk(scope, benchmark, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsBenchmark = (scope: Scope, benchmark: string, range: HistoryRange, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.benchmark(scope, benchmark, range),
    queryFn: ({ signal }) => analyticsApi.benchmark(scope, benchmark, range, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useAnalyticsDividendGrowth = (scope: Scope, { enabled = true }: ReadOptions = {}) =>
  useQuery({ queryKey: analyticsKeys.dividendGrowth(scope), queryFn: ({ signal }) => analyticsApi.dividendGrowth(scope, signal), enabled });

export const useAnalyticsGoal = (scope: Scope, params: AnalyticsGoalParams, { enabled = true }: ReadOptions = {}) =>
  useQuery({
    queryKey: analyticsKeys.goal(scope, params),
    queryFn: ({ signal }) => analyticsApi.goal(scope, params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
