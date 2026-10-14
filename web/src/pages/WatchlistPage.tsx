import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { useWatchlist, useWatchlistMutations } from '../api/management-hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { PageHeader } from '../components/Layout';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { WatchlistTable } from '../features/watchlist/WatchlistTable';

export function WatchlistPage() {
  const { data, isPending, isError, error, refetch } = useWatchlist();
  const { add, remove } = useWatchlistMutations();
  const [symbol, setSymbol] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.\-:^=]{1,20}$/.test(value)) return setFormError('Use letters, digits and . - : ^ = only (e.g. NVDA, SAP.DE)');
    setFormError(null);
    remove.reset();
    add.mutate(value, { onSuccess: () => setSymbol('') });
  };

  let body;
  if (isError) body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load watchlist" />;
  else if (isPending) {
    body = (
      <LoadingRegion label="Loading watchlist">
        <Skeleton className="h-32 w-full" />
      </LoadingRegion>
    );
  } else if (data.items.length === 0) {
    body = <EmptyState title="Your watchlist is empty" description="Add a ticker to follow its price and day change without owning it." />;
  } else {
    body = <WatchlistTable items={data.items} onRemove={(s) => {
      add.reset();
      remove.mutate(s);
    }} disabled={remove.isPending} />;
  }

  const failure = [add, remove].find((m) => m.isError)?.error;
  const shownError = formError ?? (failure ? errorMessage(failure) : null);

  return (
    <>
      <PageHeader title="Watchlist" description="Symbols you follow. Prices appear shortly after you add a new one." />
      <form onSubmit={submit} noValidate aria-label="Add to watchlist" className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem]">
          <label className="label" htmlFor="watch-symbol">Symbol</label>
          <input id="watch-symbol" className="input uppercase" placeholder="e.g. NVDA" autoComplete="off" spellCheck={false} value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add to watchlist'}</button>
      </form>
      {shownError && <p role="alert" className="mb-4 text-sm text-red-700 dark:text-red-300">{shownError}</p>}
      {body}
    </>
  );
}
