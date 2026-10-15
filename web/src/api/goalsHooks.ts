import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GoalSettings } from '@portfolio/shared';
import { ANALYTICS_ROOT_KEY } from './analyticsHooks';
import { goalsApi } from './goalsClient';

/**
 * Goal queries live under the `analytics` root (scope as second segment), so `invalidatePortfolioData` recalculates the
 * saved goal whenever transactions change.
 */
export const goalKeys = {
  saved: (scope: string) => [ANALYTICS_ROOT_KEY, scope, 'goal-plan'] as const,
  preview: (scope: string, settings: GoalSettings | null) => [ANALYTICS_ROOT_KEY, scope, 'goal-plan-preview', settings] as const,
};

export const useGoal = (scope: string, { enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: goalKeys.saved(scope), queryFn: ({ signal }) => goalsApi.get(scope, signal), enabled });

/** Stateless projection of unsaved settings (nothing is written); idle while `settings` is null. */
export const useGoalPreview = (scope: string, settings: GoalSettings | null) =>
  useQuery({
    queryKey: goalKeys.preview(scope, settings),
    queryFn: ({ signal }) => goalsApi.calculate(scope, settings!, signal),
    enabled: settings !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
  });

export function useSaveGoal(scope: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: GoalSettings) => goalsApi.save(scope, settings),
    onSuccess: (saved) => qc.setQueryData(goalKeys.saved(scope), saved),
  });
}

export function useResetGoal(scope: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => goalsApi.reset(scope),
    onSuccess: () => qc.invalidateQueries({ queryKey: goalKeys.saved(scope) }),
  });
}
