import { useState } from 'react';
import type { BrokerStatusResponse, BrokerSyncStatus, Portfolio } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { Dialog } from '../../components/Dialog';
import { formatDateTime } from '../../lib/format';
import { portfolioName } from '../portfolios/usePortfolioScope';
import { useDisconnectBroker, useSyncBroker } from './useBroker';

const STATUS_LABEL: Record<BrokerSyncStatus, string> = {
  CONNECTED: 'Connected, not synced yet',
  RUNNING: 'Syncing…',
  SUCCEEDED: 'Up to date',
  FAILED: 'Last sync failed',
};

const STATUS_CLASS: Record<BrokerSyncStatus, string> = {
  CONNECTED: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  RUNNING: 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100',
  SUCCEEDED: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100',
  FAILED: 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-100',
};

const SKIP_REASONS: Record<string, string> = {
  NO_PATTERN: 'Unknown ticker format',
  AMBIGUOUS_LISTING: 'Exchange could not be determined',
  CURRENCY_MISMATCH: 'Currency does not fit the exchange',
  INVALID_SYMBOL: 'Invalid symbol',
  NO_FX_RATE: 'No exchange rate for the dividend',
};
const UNSUPPORTED_FILL = 'UNSUPPORTED_FILL_';
const reasonLabel = (reason: string) =>
  SKIP_REASONS[reason] ??
  (reason.startsWith(UNSUPPORTED_FILL) ? `Corporate action not imported (${reason.slice(UNSUPPORTED_FILL.length).toLowerCase().replaceAll('_', ' ')})` : reason);

const time = (iso: string) => formatDateTime(iso);

function Stat({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div>
      <dt className="muted text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function StatusCard({ status, portfolios }: Readonly<{ status: BrokerStatusResponse; portfolios: readonly Portfolio[] }>) {
  const sync = useSyncBroker();
  const disconnect = useDisconnectBroker();
  const [confirming, setConfirming] = useState(false);
  const state = status.status ?? 'CONNECTED';
  const running = state === 'RUNNING' || sync.isPending;
  const { counts } = status;

  return (
    <section aria-label="Trading 212 status" className="card space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Trading 212 {status.environment === 'demo' ? '(demo)' : ''}</h2>
          <p className="muted text-sm">
            Importing into <strong>{portfolioName(portfolios, status.portfolioId)}</strong>
            {status.accountCurrency ? ` · account currency ${status.accountCurrency}` : ''}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_CLASS[state]}`} data-testid="sync-status">
          {STATUS_LABEL[state]}
        </span>
      </div>

      <p className="text-sm" data-testid="last-sync">
        {status.lastSyncAt ? `Last sync: ${time(status.lastSyncAt)}` : 'Not synced yet.'}
        {status.lastSuccessAt && status.lastSuccessAt !== status.lastSyncAt ? ` · last success ${time(status.lastSuccessAt)}` : ''}
      </p>

      {status.lastError && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
          {status.lastError}
        </p>
      )}

      {counts && (
        <div>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4" aria-label="Last sync">
            <Stat label="Orders read" value={counts.orders} />
            <Stat label="Dividends read" value={counts.dividends} />
            <Stat label="Transactions written" value={counts.written} />
            <Stat label="Skipped" value={counts.skipped} />
          </dl>
          <p className="muted mt-2 text-xs">
            Deposits, withdrawals and interest are not imported ({counts.cashMovements.deposits} deposits, {counts.cashMovements.withdrawals} withdrawals,{' '}
            {counts.cashMovements.interest} interest payments seen). Counts cover the data read in the last run.
          </p>
        </div>
      )}

      {!!status.unmapped?.length && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Not imported</h3>
          <p className="muted text-xs">These instruments could not be matched to a market symbol (or are corporate actions the tracker cannot represent). Nothing was guessed.</p>
          <div className="max-h-56 overflow-auto rounded-md border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Instruments that were not imported</caption>
              <thead>
                <tr>
                  <th scope="col" className="px-2 py-1.5">Instrument</th>
                  <th scope="col" className="px-2 py-1.5">Reason</th>
                  <th scope="col" className="px-2 py-1.5 text-right">Records</th>
                </tr>
              </thead>
              <tbody>
                {status.unmapped.map((u) => (
                  <tr key={`${u.ticker}-${u.reason}`} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1.5">
                      <span className="font-mono">{u.ticker}</span>
                      {u.name ? <span className="muted"> · {u.name}</span> : null}
                    </td>
                    <td className="px-2 py-1.5">{reasonLabel(u.reason)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{u.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {status.warnings?.map((w) => (
        <p key={w} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          {w}
        </p>
      ))}

      {sync.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {errorMessage(sync.error)}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={running} onClick={() => sync.mutate(status.portfolioId)}>
          {running ? 'Syncing…' : 'Sync now'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>
          Disconnect
        </button>
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        size="sm"
        title="Disconnect Trading 212?"
        description="The stored API key is deleted and the daily sync stops. Transactions that were already imported stay in your portfolio."
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} data-autofocus>
              Cancel
            </button>
            <button type="button" className="btn-danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        }
      >
        {disconnect.isError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {errorMessage(disconnect.error)}
          </p>
        )}
      </Dialog>
    </section>
  );
}
