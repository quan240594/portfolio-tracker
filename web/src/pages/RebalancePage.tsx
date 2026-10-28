import { useState } from 'react';
import type { RebalanceQuery } from '@portfolio/shared';
import { useRebalance } from '../api/management-hooks';
import { PageHeader } from '../components/Layout';
import { ErrorState } from '../components/ErrorState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { CardGrid, type CardDefinition } from '../features/layout/CardGrid';
import { RequirePortfolio } from '../features/management/RequirePortfolio';
import { CategoryEditor } from '../features/rebalance/CategoryEditor';
import { DriftTable } from '../features/rebalance/DriftTable';
import { RebalanceForm } from '../features/rebalance/RebalanceForm';
import { TradesPanel } from '../features/rebalance/TradesPanel';
import { formatMoney } from '../lib/format';

function PlanResult({ portfolioId, query }: Readonly<{ portfolioId: string; query: RebalanceQuery | null }>) {
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

  return result ?? <p className="muted card p-6 text-sm">Set an amount and calculate to see the drift and suggested trades.</p>;
}

/** The calculation request is shared: the form sets it, the result card shows the plan it produces. */
function RebalanceCards({ portfolioId }: Readonly<{ portfolioId: string }>) {
  const [query, setQuery] = useState<RebalanceQuery | null>(null);
  const cards: CardDefinition[] = [
    { id: 'category-editor', title: 'Categories & targets', defaultWidth: 'full', render: () => <CategoryEditor portfolioId={portfolioId} /> },
    { id: 'rebalance-form', title: 'Plan trades', defaultWidth: 'third', render: () => <RebalanceForm onSubmit={setQuery} /> },
    { id: 'rebalance-result', title: 'Drift and trades', defaultWidth: 'twothirds', render: () => <PlanResult portfolioId={portfolioId} query={query} /> },
  ];
  return <CardGrid pageId="rebalance" cards={cards} />;
}

export function RebalancePage() {
  return (
    <>
      <PageHeader title="Rebalance" description="Compare your allocation with category targets and plan the trades that close the gap." />
      <RequirePortfolio what="Categories and targets">
        {({ portfolioId }) => <RebalanceCards portfolioId={portfolioId} />}
      </RequirePortfolio>
    </>
  );
}
