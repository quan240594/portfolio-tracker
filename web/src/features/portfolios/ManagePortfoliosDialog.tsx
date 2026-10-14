import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ALL_PORTFOLIOS, MAX_PORTFOLIOS, createPortfolioSchema, type Portfolio } from '@portfolio/shared';
import { Dialog } from '../../components/Dialog';
import { ErrorState } from '../../components/ErrorState';
import { ApiError, errorMessage } from '../../api/client';
import { useCreatePortfolio, useDeletePortfolio, usePortfolios, useRenamePortfolio, useTransactions } from '../../api/hooks';

type View =
  | { kind: 'list' }
  | { kind: 'confirm'; portfolio: Portfolio }
  | { kind: 'force'; portfolio: Portfolio; count?: number };

interface Notice {
  tone: 'success' | 'error';
  text: string;
}

/** Validates a portfolio name with the shared schema; returns a friendly message or the trimmed name. */
export function validatePortfolioName(raw: string): { name?: string; error?: string } {
  const res = createPortfolioSchema.safeParse({ name: raw });
  if (res.success) return { name: res.data.name };
  const issue = res.error.issues[0];
  return { error: issue?.code === 'too_big' ? 'Name is too long (max 60 characters)' : 'Name is required' };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `details.transactionCount` if the API provides it, otherwise the count we computed client-side. */
function notEmptyCount(err: ApiError, fallback?: number): number | undefined {
  const d = err.details as { transactionCount?: unknown } | undefined;
  return typeof d?.transactionCount === 'number' ? d.transactionCount : fallback;
}

export function ManagePortfoliosDialog({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [focusSelector, setFocusSelector] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const portfolios = usePortfolios();
  const transactions = useTransactions(ALL_PORTFOLIOS, { enabled: open });
  const counts = useMemo(() => {
    if (!transactions.data) return undefined;
    const m = new Map<string, number>();
    for (const t of transactions.data.transactions) m.set(t.portfolioId, (m.get(t.portfolioId) ?? 0) + 1);
    return m;
  }, [transactions.data]);

  const del = useDeletePortfolio();

  // Move focus deliberately whenever the view changes (the Dialog only handles the initial focus).
  useEffect(() => {
    if (!focusSelector) return;
    bodyRef.current?.querySelector<HTMLElement>(focusSelector)?.focus();
    setFocusSelector(null);
  }, [focusSelector, view]);

  const go = (next: View, focus: string) => {
    setView(next);
    setFocusSelector(focus);
  };

  const close = () => {
    setView({ kind: 'list' });
    setNotice(null);
    del.reset();
    onClose();
  };

  const backToList = (p: Portfolio, n: Notice | null) => {
    del.reset();
    setNotice(n);
    go({ kind: 'list' }, n?.tone === 'success' ? '#new-portfolio-name' : `[data-delete="${p.portfolioId}"]`);
  };

  const remove = (p: Portfolio, force: boolean) => {
    del.mutate(
      { id: p.portfolioId, force },
      {
        onSuccess: () => backToList(p, { tone: 'success', text: `Deleted “${p.name}”.` }),
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'PORTFOLIO_NOT_EMPTY' && !force) {
            del.reset();
            go({ kind: 'force', portfolio: p, count: notEmptyCount(err, counts?.get(p.portfolioId)) }, '[data-autofocus]');
          } else if (err instanceof ApiError && err.code === 'LAST_PORTFOLIO') {
            backToList(p, {
              tone: 'error',
              text: `“${p.name}” is your only portfolio — you always need at least one. Create another portfolio first if you want to delete this one.`,
            });
          }
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Manage portfolios"
      description="Group transactions per broker or account. Every view can show one portfolio or all of them combined."
      size="lg"
    >
      <div ref={bodyRef}>
        {view.kind === 'list' && (
          <ListView
            portfolios={portfolios}
            counts={counts}
            notice={notice}
            onNotice={setNotice}
            onDelete={(p) => {
              setNotice(null);
              del.reset();
              go({ kind: 'confirm', portfolio: p }, '[data-autofocus]');
            }}
          />
        )}

        {view.kind === 'confirm' && (
          <section aria-labelledby="confirm-delete-title" className="space-y-3 text-sm">
            <h3 id="confirm-delete-title" className="text-base font-semibold">
              Delete “{view.portfolio.name}”?
            </h3>
            <p className="muted">The portfolio is removed permanently. Other portfolios are not affected.</p>
            {del.isError && (
              <p role="alert" className="text-red-700 dark:text-red-300">
                {errorMessage(del.error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" data-autofocus onClick={() => backToList(view.portfolio, null)}>
                Cancel
              </button>
              <button type="button" className="btn-danger" disabled={del.isPending} onClick={() => remove(view.portfolio, false)}>
                {del.isPending ? 'Deleting…' : 'Delete portfolio'}
              </button>
            </div>
          </section>
        )}

        {view.kind === 'force' && (
          <ForceDeleteView
            portfolio={view.portfolio}
            count={view.count}
            pending={del.isPending}
            error={del.isError ? errorMessage(del.error) : null}
            onCancel={() => backToList(view.portfolio, null)}
            onConfirm={() => remove(view.portfolio, true)}
          />
        )}
      </div>
    </Dialog>
  );
}

function ListView({
  portfolios,
  counts,
  notice,
  onNotice,
  onDelete,
}: Readonly<{
  portfolios: ReturnType<typeof usePortfolios>;
  counts: Map<string, number> | undefined;
  notice: Notice | null;
  onNotice: (n: Notice | null) => void;
  onDelete: (p: Portfolio) => void;
}>) {
  const [editing, setEditing] = useState<string | null>(null);
  const [returnFocus, setReturnFocus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // After an inline rename closes, put focus back on its Rename button.
  useEffect(() => {
    if (editing || !returnFocus) return;
    listRef.current?.querySelector<HTMLElement>(`[data-rename="${returnFocus}"]`)?.focus();
    setReturnFocus(null);
  }, [editing, returnFocus]);

  let list: ReactNode;
  if (portfolios.isError) {
    list = <ErrorState error={portfolios.error} onRetry={() => void portfolios.refetch()} title="Could not load portfolios" />;
  } else if (portfolios.isPending) {
    list = <p className="muted">Loading portfolios…</p>;
  } else {
    list = (
      <ul aria-label="Portfolios" className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {portfolios.data.portfolios.map((p) =>
          editing === p.portfolioId ? (
            <li key={p.portfolioId} className="px-3 py-2.5">
              <RenameForm
                portfolio={p}
                onDone={(name) => {
                  setEditing(null);
                  setReturnFocus(p.portfolioId);
                  if (name) onNotice({ tone: 'success', text: `Renamed to “${name}”.` });
                }}
              />
            </li>
          ) : (
            <li key={p.portfolioId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                {counts && <div className="muted text-xs">{plural(counts.get(p.portfolioId) ?? 0, 'transaction')}</div>}
              </div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-600/20"
                aria-label={`Rename ${p.name}`}
                data-rename={p.portfolioId}
                onClick={() => {
                  onNotice(null);
                  setEditing(p.portfolioId);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                aria-label={`Delete ${p.name}`}
                data-delete={p.portfolioId}
                onClick={() => onDelete(p)}
              >
                Delete
              </button>
            </li>
          ),
        )}
      </ul>
    );
  }

  return (
    <div ref={listRef} className="space-y-5 text-sm">
      <div role="status" aria-live="polite" className="empty:hidden">
        {notice?.tone === 'success' && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100">
            {notice.text}
          </p>
        )}
      </div>
      {notice?.tone === 'error' && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          {notice.text}
        </p>
      )}

      {list}

      <CreateForm onCreated={(p) => onNotice({ tone: 'success', text: `Created “${p.name}”.` })} />
    </div>
  );
}

function CreateForm({ onCreated }: Readonly<{ onCreated: (p: Portfolio) => void }>) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePortfolio();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = validatePortfolioName(name);
    if (!v.name) {
      setError(v.error!);
      return;
    }
    setError(null);
    create.mutate(v.name, {
      onSuccess: (p) => {
        setName('');
        onCreated(p);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Create portfolio" className="space-y-1">
      <label htmlFor="new-portfolio-name" className="label">
        New portfolio name
      </label>
      <div className="flex gap-2">
        <input
          id="new-portfolio-name"
          data-autofocus
          className="input"
          value={name}
          maxLength={80}
          autoComplete="off"
          placeholder="e.g. Trading 212"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'new-portfolio-error new-portfolio-help' : 'new-portfolio-help'}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
        <button type="submit" className="btn-primary shrink-0" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create portfolio'}
        </button>
      </div>
      {error && (
        <p id="new-portfolio-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <p id="new-portfolio-help" className="muted text-xs">
        Names must be unique. Up to {MAX_PORTFOLIOS} portfolios.
      </p>
    </form>
  );
}

function RenameForm({ portfolio, onDone }: Readonly<{ portfolio: Portfolio; onDone: (newName?: string) => void }>) {
  const [name, setName] = useState(portfolio.name);
  const [error, setError] = useState<string | null>(null);
  const rename = useRenamePortfolio();
  const inputId = `rename-${portfolio.portfolioId}`;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = validatePortfolioName(name);
    if (!v.name) {
      setError(v.error!);
      return;
    }
    if (v.name === portfolio.name) {
      onDone();
      return;
    }
    rename.mutate(
      { id: portfolio.portfolioId, name: v.name },
      { onSuccess: (p) => onDone(p.name), onError: (err) => setError(errorMessage(err)) },
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Cancel the rename only; keep the dialog open.
      e.nativeEvent.stopPropagation();
      onDone();
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate aria-label={`Rename ${portfolio.name}`} className="space-y-1">
      <label htmlFor={inputId} className="sr-only">
        New name for {portfolio.name}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          className="input min-w-0 flex-1"
          value={name}
          maxLength={80}
          autoComplete="off"
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
        <button type="submit" className="btn-primary" disabled={rename.isPending}>
          {rename.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

function ForceDeleteView({
  portfolio,
  count,
  pending,
  error,
  onCancel,
  onConfirm,
}: Readonly<{
  portfolio: Portfolio;
  count?: number;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === portfolio.name;
  const what = count === undefined ? 'all its transactions' : `its ${plural(count, 'transaction')}`;

  return (
    <form
      aria-labelledby="force-delete-title"
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (matches) onConfirm();
      }}
    >
      <h3 id="force-delete-title" className="text-base font-semibold">
        “{portfolio.name}” still has transactions
      </h3>
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
        Deleting this portfolio also permanently deletes {what}. Holdings, returns and dividends are recalculated. This cannot
        be undone.
      </p>
      <div>
        <label htmlFor="force-delete-confirm" className="label">
          Type <strong>{portfolio.name}</strong> to confirm
        </label>
        <input
          id="force-delete-confirm"
          className="input"
          autoComplete="off"
          data-autofocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-danger" disabled={!matches || pending}>
          {pending ? 'Deleting…' : `Delete portfolio and ${what}`}
        </button>
      </div>
    </form>
  );
}
