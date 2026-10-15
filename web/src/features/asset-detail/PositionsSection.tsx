import type { ReactNode } from 'react';
import type { AssetPosition, AssetPositionsResponse } from '@portfolio/shared';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import type { UseQueryResult } from '@tanstack/react-query';
import { formatDate, formatMoney, formatQuantity, formatWeight } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

function Item({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="muted text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: Readonly<{ status: AssetPosition['status'] }>) {
  const open = status === 'open';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${open ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>
      {open ? 'Open' : 'Sold out'}
    </span>
  );
}

function PerShare({ position, currency, localCurrency }: Readonly<{ position: AssetPosition; currency: string; localCurrency: string | null }>) {
  return (
    <>
      <span className="block">{formatMoney(position.averageCostBase, currency, { maxDigits: 4 })}</span>
      {localCurrency && localCurrency !== currency && <span className="muted block text-xs">{formatMoney(position.averageCostLocal, localCurrency, { maxDigits: 4 })}</span>}
    </>
  );
}

function PositionCard({ position, data }: Readonly<{ position: AssetPosition; data: AssetPositionsResponse }>) {
  const { baseCurrency: currency } = data;
  const open = position.status === 'open';
  return (
    <li className="card min-w-0 p-4" aria-label={`${position.portfolioName} position`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 font-semibold break-words">{position.portfolioName}</h3>
        <StatusBadge status={position.status} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {open && <Item label="Shares">{formatQuantity(position.quantity)}</Item>}
        {open && (
          <Item label="Cost per share">
            <PerShare position={position} currency={currency} localCurrency={data.currency} />
          </Item>
        )}
        {open && <Item label="Value">{formatMoney(position.marketValue, currency)}</Item>}
        <Item label={open ? 'Profit' : 'Realised profit'}>
          <Change amount={position.profit} pct={position.profitPct} currency={currency} />
        </Item>
        <Item label="Capital gain">
          <Change amount={position.capitalGain} currency={currency} />
        </Item>
        <Item label="Dividends received">{formatMoney(position.dividendsReceived, currency)}</Item>
        {open && position.weight !== null && <Item label="Share of portfolio">{formatWeight(position.weight)}</Item>}
        {position.firstTradeDate && <Item label={open ? 'First bought' : 'Held from'}>{formatDate(position.firstTradeDate)}</Item>}
        {!open && position.lastTradeDate && <Item label="Sold out">{formatDate(position.lastTradeDate)}</Item>}
      </dl>
    </li>
  );
}

function Totals({ data }: Readonly<{ data: AssetPositionsResponse }>) {
  const t = data.totals;
  if (!t) return null;
  return (
    <section aria-label="Total across portfolios" className="card border-brand-500/40 p-4">
      <h3 className="font-semibold">Total across portfolios</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Item label="Shares">{formatQuantity(t.quantity)}</Item>
        <Item label="Value">{formatMoney(t.marketValue, data.baseCurrency)}</Item>
        <Item label="Profit">
          <Change amount={t.profit} pct={t.profitPct} currency={data.baseCurrency} />
        </Item>
        <Item label="Dividends received">{formatMoney(t.dividendsReceived, data.baseCurrency)}</Item>
      </dl>
    </section>
  );
}

function PositionsContent({ data, symbol, scopeName }: Readonly<{ data: AssetPositionsResponse; symbol: string; scopeName: string }>) {
  if (data.positions.length === 0) {
    return <p className="muted text-sm">You have no position in {symbol}{scopeName ? ` in ${scopeName}` : ''}. Add a transaction on the Transactions page to track it here.</p>;
  }
  return (
    <div className="space-y-3">
      <ul className="grid gap-3 lg:grid-cols-2">
        {data.positions.map((p) => (
          <PositionCard key={p.portfolioId} position={p} data={data} />
        ))}
      </ul>
      <Totals data={data} />
    </div>
  );
}

/** "My positions": one card per portfolio that holds (or held) the security, and a total when there are several. */
export function PositionsSection({ query, symbol }: Readonly<{ query: UseQueryResult<AssetPositionsResponse>; symbol: string }>) {
  const { scopeName } = usePortfolioScope();
  return (
    <section aria-labelledby="asset-positions-title">
      <h2 id="asset-positions-title" className="mb-3 text-lg font-semibold">
        My positions
      </h2>
      <QueryBoundary query={query} loadingLabel="Loading your positions" errorTitle="Could not load your positions" skeletonClassName="h-32 w-full">
        {(data) => <PositionsContent data={data} symbol={symbol} scopeName={scopeName} />}
      </QueryBoundary>
    </section>
  );
}
