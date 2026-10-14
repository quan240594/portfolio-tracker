import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ALL_PORTFOLIOS, type Portfolio, type Transaction } from '@portfolio/shared';
import { useDeleteTransaction, useTransactions } from '../api/hooks';
import { errorMessage, type Scope } from '../api/client';
import { PageHeader } from '../components/Layout';
import { Dialog } from '../components/Dialog';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { TransactionForm } from '../features/transactions/TransactionForm';
import { CsvImport } from '../features/transactions/CsvImport';
import { portfolioName, usePortfolioScope } from '../features/portfolios/usePortfolioScope';
import { BASE_CURRENCY, formatDate, formatFxRate, formatMoney, formatQuantity } from '../lib/format';

type Action = 'add' | 'import' | null;

const TYPE_STYLE: Record<Transaction['type'], string> = {
  BUY: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  SELL: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200',
  DIVIDEND: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200',
};

const total = (t: Transaction) =>
  t.type === 'BUY' ? t.quantity * t.price + t.fee : t.quantity * t.price - t.fee;

interface TableProps {
  transactions: Transaction[];
  /** Set (in the combined view) to show a Portfolio column. */
  portfolios?: readonly Portfolio[];
  onDelete: (t: Transaction) => void;
}

function TransactionsTable({ transactions, portfolios, onDelete }: Readonly<TableProps>) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Transactions, newest first</caption>
        <thead>
          <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
            <th scope="col" className="px-3 py-2.5 font-medium">Date</th>
            {portfolios && <th scope="col" className="px-3 py-2.5 font-medium">Portfolio</th>}
            <th scope="col" className="px-3 py-2.5 font-medium">Type</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Symbol</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Quantity</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Price</th>
            <th scope="col" className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Fee</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Total</th>
            <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Note</th>
            <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <tr key={t.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
              <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(t.date)}</td>
              {portfolios && <td className="px-3 py-2.5 whitespace-nowrap">{portfolioName(portfolios, t.portfolioId)}</td>}
              <td className="px-3 py-2.5">
                <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${TYPE_STYLE[t.type]}`}>{t.type}</span>
              </td>
              <td className="px-3 py-2.5 font-medium">{t.symbol}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatQuantity(t.quantity)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(t.price, t.currency, { maxDigits: t.price < 1 ? 6 : 2 })}</td>
              <td className="hidden px-3 py-2.5 text-right tabular-nums sm:table-cell">{formatMoney(t.fee, t.currency)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                <span className="block font-medium">{formatMoney(total(t), t.currency)}</span>
                {t.fxRate !== undefined && t.currency !== BASE_CURRENCY && (
                  <span className="muted block text-xs whitespace-nowrap" title={`Broker FX rate: ${formatFxRate(t.fxRate)} ${t.currency} per 1 ${BASE_CURRENCY}`}>
                    ≈ {formatMoney(total(t) / t.fxRate, BASE_CURRENCY)} · FX {formatFxRate(t.fxRate)}
                  </span>
                )}
              </td>
              <td className="muted hidden max-w-[14rem] truncate px-3 py-2.5 lg:table-cell" title={t.note}>
                {t.note ?? (t.importId ? 'Imported' : '')}
              </td>
              <td className="px-3 py-2.5 text-right">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                  aria-label={`Delete ${t.type.toLowerCase()} ${t.symbol} on ${formatDate(t.date)}`}
                  onClick={() => onDelete(t)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mentions the target portfolio when the new transaction is not visible in the current scope. */
function addedNotice(t: Transaction, scope: Scope, portfolios: readonly Portfolio[] | undefined): string {
  const added = `Added ${t.type.toLowerCase()} of ${formatQuantity(t.quantity)} ${t.symbol}`;
  if (scope === ALL_PORTFOLIOS || scope === t.portfolioId) return `${added}.`;
  return `${added} to ${portfolioName(portfolios, t.portfolioId)} (switch portfolio to see it).`;
}

export function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const action = (['add', 'import'] as const).find((a) => a === params.get('action')) ?? null;
  const setAction = (a: Action) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (a) next.set('action', a);
        else next.delete('action');
        return next;
      },
      { replace: true },
    );

  const { scope, ready, scopeName, current, portfolios } = usePortfolioScope();
  const showPortfolio = scope === ALL_PORTFOLIOS;
  const { data, isPending, isError, error, refetch } = useTransactions(scope, { enabled: ready });
  const del = useDeleteTransaction();
  const [toDelete, setToDelete] = useState<Transaction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const confirmDelete = () => {
    if (!toDelete) return;
    del.mutate(toDelete, {
      onSuccess: () => {
        setNotice(`Deleted ${toDelete.type.toLowerCase()} of ${toDelete.symbol} on ${formatDate(toDelete.date)}.`);
        setToDelete(null);
      },
    });
  };

  const actions = (
    <>
      <button type="button" className="btn-secondary" onClick={() => setAction('import')}>
        Import CSV
      </button>
      <button type="button" className="btn-primary" onClick={() => setAction('add')}>
        Add transaction
      </button>
    </>
  );

  let body: ReactNode;
  if (isError) {
    body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load transactions" />;
  } else if (isPending) {
    body = (
      <LoadingRegion label="Loading transactions">
        <div className="card space-y-3 p-4">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      </LoadingRegion>
    );
  } else if (data.transactions.length === 0) {
    body = (
      <EmptyState
        title={current ? `No transactions in ${current.name} yet` : 'No transactions yet'}
        description="Record your first trade manually or import a CSV file exported from your broker."
        actions={actions}
      />
    );
  } else {
    body = (
      <TransactionsTable
        transactions={data.transactions}
        portfolios={showPortfolio ? (portfolios ?? []) : undefined}
        onDelete={(t) => {
          del.reset();
          setToDelete(t);
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Transactions"
        description={`${scopeName ? scopeName + ' · buys' : 'Buys'}, sells and dividends — the source for every number in the app.`}
        actions={actions}
      />

      <div role="status" aria-live="polite" className="empty:hidden">
        {notice && (
          <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100">
            {notice}
          </p>
        )}
      </div>

      {body}

      <Dialog open={action === 'add'} onClose={() => setAction(null)} title="Add transaction" size="lg">
        <TransactionForm
          onCancel={() => setAction(null)}
          onSuccess={(t) => {
            setNotice(addedNotice(t, scope, portfolios));
            setAction(null);
          }}
        />
      </Dialog>

      <Dialog open={action === 'import'} onClose={() => setAction(null)} title="Import transactions from CSV" size="lg">
        <CsvImport onDone={() => setAction(null)} />
      </Dialog>

      <Dialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        role="alertdialog"
        size="sm"
        title="Delete transaction?"
        description={
          toDelete &&
          `This removes the ${toDelete.type.toLowerCase()} of ${formatQuantity(toDelete.quantity)} ${toDelete.symbol} on ${formatDate(toDelete.date)}. Holdings and returns will be recalculated.`
        }
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setToDelete(null)} data-autofocus>
              Cancel
            </button>
            <button type="button" className="btn-danger" onClick={confirmDelete} disabled={del.isPending}>
              {del.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        {del.isError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {errorMessage(del.error)}
          </p>
        )}
      </Dialog>
    </>
  );
}
