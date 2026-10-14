import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useHoldings } from '../api/hooks';
import { PageHeader } from '../components/Layout';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { HoldingsTable } from '../features/holdings/HoldingsTable';
import { formatMoney } from '../lib/format';

export function HoldingsPage() {
  const { data, isPending, isError, error, refetch } = useHoldings();
  const total = data?.holdings.reduce((s, h) => s + h.marketValue, 0) ?? 0;

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
        title="No open positions"
        description="Positions appear here once you record buy transactions."
        actions={<Link to="/transactions?action=add" className="btn-primary">Add transaction</Link>}
      />
    );
  } else {
    body = <HoldingsTable holdings={data.holdings} currency={data.baseCurrency} />;
  }

  return (
    <>
      <PageHeader
        title="Holdings"
        description={
          data
            ? `${data.holdings.length} positions · ${formatMoney(total, data.baseCurrency)} · all amounts in ${data.baseCurrency}`
            : undefined
        }
      />
      {body}
    </>
  );
}
