import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GetHoldingsResponse } from '@portfolio/shared';
import { useHoldings } from '../api/hooks';
import { PageHeader } from '../components/Layout';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { CardGrid } from '../features/layout/CardGrid';
import { HoldingsTable } from '../features/holdings/HoldingsTable';
import { formatMoney } from '../lib/format';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';

/** "<scope> · N positions · total · all amounts in EUR" once loaded; just the scope name before that. */
function holdingsDescription(data: GetHoldingsResponse | undefined, scopeName: string): string | undefined {
  if (!data) return scopeName || undefined;
  const total = data.holdings.reduce((s, h) => s + h.marketValue, 0);
  const prefix = scopeName ? `${scopeName} · ` : '';
  return `${prefix}${data.holdings.length} positions · ${formatMoney(total, data.baseCurrency)} · all amounts in ${data.baseCurrency}`;
}

export function HoldingsPage() {
  const { scope, ready, scopeName, withScope, current } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useHoldings(scope, { enabled: ready });

  let body: ReactNode;
  if (isError) {
    body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load holdings" />;
  } else if (isPending) {
    body = (
      <LoadingRegion label="Loading holdings">
        <div className="card space-y-3 p-4">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      </LoadingRegion>
    );
  } else if (data.holdings.length === 0) {
    body = (
      <EmptyState
        title={current ? `No open positions in ${current.name}` : 'No open positions'}
        description="Positions appear here once you record buy transactions."
        actions={<Link to={withScope('/transactions?action=add')} className="btn-primary">Add transaction</Link>}
      />
    );
  } else {
    body = <HoldingsTable holdings={data.holdings} currency={data.baseCurrency} />;
  }

  return (
    <>
      <PageHeader title="Holdings" description={holdingsDescription(data, scopeName)} />
      <CardGrid pageId="holdings" cards={[{ id: 'holdings-table', title: 'Holdings', defaultWidth: 'full', render: () => body }]} />
    </>
  );
}
