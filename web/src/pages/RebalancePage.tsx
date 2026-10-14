import { useState } from 'react';
import type { RebalanceQuery } from '@portfolio/shared';
import { useRebalance } from '../api/management-hooks';
import { PageHeader } from '../components/Layout';
import { ErrorState } from '../components/ErrorState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { RequirePortfolio } from '../features/management/RequirePortfolio';
import { CategoryEditor } from '../features/rebalance/CategoryEditor';
import { DriftTable } from '../features/rebalance/DriftTable';
import { RebalanceForm } from '../features/rebalance/RebalanceForm';
import { TradesPanel } from '../features/rebalance/TradesPanel';
import { formatMoney } from '../lib/format';

function Plan({ portfolioId }: Readonly<{ portfolioId: string }>) {
  const [query, setQuery] = useState<RebalanceQuery | null>(null);
  const { data, isFetching, isError, error, refetch } = useRebalance(portfolioId, query);

  let result = null;
  if (isError) result = <ErrorState error={error} onRetry={() => void refetch()} title="Could not calculate trades" />;
  else if (query && !data) {
    result = (
      <LoadingRegion label="Calculating trades">
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  } else if (data) {
    result = (
      <div className="space-y-4" aria-busy={isFetching || undefined}>
        <p className="muted text-sm">
          Portfolio value {formatMoney(data.totalBefore, 'EUR')}
          {data.amount > 0 && ` + ${formatMoney(data.amount, 'EUR')} new money = ${formatMoney(data.basis, 'EUR')}`}
        </p>
        <DriftTable result={data} />
        <TradesPanel result={data} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-1">
        <RebalanceForm onSubmit={setQuery} />
      </div>
      <div className="lg:col-span-2">
        {result ?? <p className="muted card p-6 text-sm">Set an amount and calculate to see the drift and suggested trades.</p>}
      </div>
    </div>
  );
}

export function RebalancePage() {
  return (
    <>
      <PageHeader title="Rebalance" description="Compare your allocation with category targets and plan the trades that close the gap." />
      <RequirePortfolio what="Categories and targets">
        {({ portfolioId }) => (
          <div className="space-y-6">
            <CategoryEditor portfolioId={portfolioId} />
            <Plan portfolioId={portfolioId} />
          </div>
        )}
      </RequirePortfolio>
    </>
  );
}
