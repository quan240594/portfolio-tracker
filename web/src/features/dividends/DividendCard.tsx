import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { InfoTip } from '../../components/InfoTip';
import { QueryBoundary } from '../../components/QueryBoundary';

export { InfoTip };

interface CardProps {
  id: string;
  title: string;
  /** Explains the metric, its data source and assumptions. */
  info: ReactNode;
  /** Selectors or a summary shown next to the title. */
  controls?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Titled card with an info tip; every dividends card uses it for a consistent look. */
export function DividendCard({ id, title, info, controls, className = '', children }: Readonly<CardProps>) {
  return (
    <section className={`card relative min-w-0 p-4 ${className}`} aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <h2 id={id} className="font-semibold">
            {title}
          </h2>
          <InfoTip label={title}>{info}</InfoTip>
        </div>
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      </div>
      {children}
    </section>
  );
}

type QueryLike<T> = Pick<UseQueryResult<T>, 'data' | 'isPending' | 'isError' | 'error' | 'refetch' | 'isPlaceholderData'>;

interface QueryCardProps<T> extends Omit<CardProps, 'children'> {
  query: QueryLike<T>;
  loadingLabel: string;
  errorTitle: string;
  skeletonClassName?: string;
  children: (data: T) => ReactNode;
}

/** A DividendCard whose body follows a query: skeleton while loading, error with retry, then the content. */
export function QueryCard<T>({ query, loadingLabel, errorTitle, skeletonClassName = 'h-64 w-full', children, ...card }: Readonly<QueryCardProps<T>>) {
  return (
    <DividendCard {...card}>
      <QueryBoundary query={query} loadingLabel={loadingLabel} errorTitle={errorTitle} skeletonClassName={skeletonClassName}>
        {children}
      </QueryBoundary>
    </DividendCard>
  );
}

export const EmptyNote = ({ children }: Readonly<{ children: ReactNode }>) => <p className="muted py-10 text-center text-sm">{children}</p>;
