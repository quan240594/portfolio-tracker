import { useState } from 'react';
import { formatPercent } from '../../lib/format';
import type { Category } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useHoldings } from '../../api/hooks';
import { useCategories, useCategoryMutations } from '../../api/management-hooks';
import { Dialog } from '../../components/Dialog';
import { ErrorState } from '../../components/ErrorState';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { CategoryDialog } from './CategoryDialog';

/** Categories of a portfolio with their target weights, assigned holdings and edit/delete actions. */
export function CategoryEditor({ portfolioId }: Readonly<{ portfolioId: string }>) {
  const cats = useCategories(portfolioId);
  const holdings = useHoldings(portfolioId);
  const { remove } = useCategoryMutations(portfolioId);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<Category | null>(null);

  if (cats.isError) return <ErrorState error={cats.error} onRetry={() => void cats.refetch()} title="Could not load categories" />;
  if (cats.isPending) {
    return (
      <LoadingRegion label="Loading categories">
        <Skeleton className="h-32 w-full" />
      </LoadingRegion>
    );
  }
  const { categories, assignments, totalTarget, unallocated } = cats.data;

  const confirmDelete = () => {
    if (toDelete) remove.mutate(toDelete.categoryId, { onSuccess: () => setToDelete(null) });
  };

  return (
    <section className="card p-4" aria-labelledby="categories-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="categories-title" className="font-semibold">Categories &amp; targets</h2>
          <p className="muted text-xs">
            Targets total {formatPercent(totalTarget, { digits: 0 })} · {formatPercent(unallocated, { digits: 0 })} left unallocated
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => setEditing('new')}>Add category</button>
      </div>

      {categories.length === 0 ? (
        <p className="muted text-sm">No categories yet. Add one and give it a target weight to start rebalancing.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {categories.map((c) => {
            const symbols = assignments.filter((a) => a.categoryId === c.categoryId).map((a) => a.symbol);
            return (
              <li key={c.categoryId} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="font-medium">{c.name}</span>
                <span className="tabular-nums">{formatPercent(c.targetWeight, { digits: 1 })}</span>
                <span className="muted min-w-0 flex-1 truncate text-xs">{symbols.length > 0 ? symbols.join(', ') : 'No holdings assigned'}</span>
                <button type="button" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                  Edit
                </button>
                <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" aria-label={`Delete ${c.name}`} onClick={() => setToDelete(c)}>
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && (
        <CategoryDialog
          portfolioId={portfolioId}
          category={editing === 'new' ? null : editing}
          categories={categories}
          assignments={assignments}
          holdings={holdings.data?.holdings ?? []}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        role="alertdialog"
        size="sm"
        title="Delete category?"
        description={toDelete && `“${toDelete.name}” is removed; its holdings become uncategorized.`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setToDelete(null)} data-autofocus>Cancel</button>
            <button type="button" className="btn-danger" onClick={confirmDelete} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        {remove.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{errorMessage(remove.error)}</p>}
      </Dialog>
    </section>
  );
}
