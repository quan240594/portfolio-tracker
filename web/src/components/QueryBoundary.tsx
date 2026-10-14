import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState } from './ErrorState';
import { LoadingRegion, Skeleton } from './Skeleton';

type QueryLike<T> = Pick<UseQueryResult<T>, 'data' | 'isPending' | 'isError' | 'error' | 'refetch' | 'isPlaceholderData'>;

interface Props<T> {
  query: QueryLike<T>;
  loadingLabel: string;
  errorTitle: string;
  skeletonClassName?: string;
  /** Rendered once data is available; previous data stays visible (dimmed) while a new request is in flight. */
  children: (data: T) => ReactNode;
}

/** Shared loading / error / content switch for query-backed panels. */
export function QueryBoundary<T>({ query, loadingLabel, errorTitle, skeletonClassName = 'h-72 w-full', children }: Readonly<Props<T>>) {
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} title={errorTitle} />;
  const { data } = query;
  if (query.isPending || data === undefined) {
    return (
      <LoadingRegion label={loadingLabel}>
        <Skeleton className={skeletonClassName} />
      </LoadingRegion>
    );
  }
  return <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>{children(data)}</div>;
}
