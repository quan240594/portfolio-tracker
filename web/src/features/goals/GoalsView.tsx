import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { useGoal, useResetGoal } from '../../api/goalsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { GoalPlanner } from './GoalPlanner';

/** Loads the saved goal of the active portfolio scope and renders the planner (reset reloads the defaults). */
export function GoalsView() {
  const { scope, ready } = usePortfolioScope();
  const query = useGoal(scope, { enabled: ready });
  const reset = useResetGoal(scope);
  const [resets, setResets] = useState(0);

  return (
    <QueryBoundary query={query} loadingLabel="Loading your goal" errorTitle="Could not load your goal" skeletonClassName="h-[32rem] w-full">
      {(saved) => (
        <GoalPlanner
          key={`${scope}:${resets}`}
          saved={saved}
          scope={scope}
          resetting={reset.isPending}
          resetError={reset.isError ? errorMessage(reset.error) : undefined}
          onReset={() => reset.mutate(undefined, { onSuccess: () => setResets((n) => n + 1) })}
        />
      )}
    </QueryBoundary>
  );
}
