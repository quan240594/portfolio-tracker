import { Link } from 'react-router-dom';
import { useWatchlist } from '../../api/management-hooks';
import { ErrorState } from '../../components/ErrorState';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { WatchlistTable } from './WatchlistTable';

const WIDGET_ITEMS = 5;

/** Dashboard card with the first watched symbols; hidden when the user has none. */
export function WatchlistWidget() {
  const { withScope } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useWatchlist();
  if (!isPending && !isError && data.items.length === 0) return null;

  let body;
  if (isError) body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load watchlist" />;
  else if (isPending) {
    body = (
      <LoadingRegion label="Loading watchlist">
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  } else body = <WatchlistTable items={data.items.slice(0, WIDGET_ITEMS)} />;

  return (
    <section className="card p-4" aria-labelledby="watch-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="watch-title" className="font-semibold">Watchlist</h2>
        <Link to={withScope('/watchlist')} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
          Manage →
        </Link>
      </div>
      {body}
    </section>
  );
}
