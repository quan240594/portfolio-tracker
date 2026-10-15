import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { QueryBoundary } from '../../components/QueryBoundary';

/** Short "i" disclosure explaining a metric; a native `<details>` so it works with keyboard and screen readers. The panel is positioned against the surrounding (relative) card. */
export function InfoTip({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <details className="group">
      <summary
        aria-label={`About ${label}`}
        className="flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded-full border border-slate-300 text-[11px] font-semibold text-slate-500 select-none hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800 [&::-webkit-details-marker]:hidden"
      >
        i
      </summary>
      <div className="absolute inset-x-4 top-12 z-20 space-y-1.5 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed font-normal text-slate-700 shadow-lg sm:right-auto sm:w-80 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{children}</div>
    </details>
  );
}

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
