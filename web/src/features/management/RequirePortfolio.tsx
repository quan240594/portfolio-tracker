import type { ReactNode } from 'react';
import { ALL_PORTFOLIOS } from '@portfolio/shared';
import { EmptyState } from '../../components/EmptyState';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

interface Props {
  /** What the page needs a portfolio for, e.g. "Categories and targets". */
  what: string;
  children: (portfolio: { portfolioId: string; name: string }) => ReactNode;
}

/**
 * Management data (categories, custom assets) belongs to one portfolio. In the combined view this asks the user to
 * pick one instead of guessing.
 */
export function RequirePortfolio({ what, children }: Readonly<Props>) {
  const { scope, current, portfolios, setScope, ready } = usePortfolioScope();
  if (scope !== ALL_PORTFOLIOS && current) return <>{children({ portfolioId: current.portfolioId, name: current.name })}</>;
  if (scope !== ALL_PORTFOLIOS || !portfolios || !ready) {
    return (
      <LoadingRegion label="Loading portfolio">
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  }
  return (
    <EmptyState
      title="Choose a portfolio"
      description={`${what} are set per portfolio. Pick one to continue.`}
      actions={portfolios.map((p) => (
        <button key={p.portfolioId} type="button" className="btn-secondary" onClick={() => setScope(p.portfolioId)}>
          {p.name}
        </button>
      ))}
    />
  );
}
