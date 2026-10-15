import type { Mover } from '@portfolio/shared';
import { useAnalyticsSummary } from '../../api/analyticsHooks';
import { Change } from '../../components/Change';
import { ErrorState } from '../../components/ErrorState';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

function MoverList({ title, movers, empty, currency }: Readonly<{ title: string; movers: readonly Mover[]; empty: string; currency: string }>) {
  const id = `movers-${title.replaceAll(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className="card min-w-0 p-4" aria-labelledby={id}>
      <h2 id={id} className="mb-3 font-semibold">
        {title}
      </h2>
      {movers.length === 0 ? (
        <p className="muted text-sm">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {movers.map((m) => (
            <li key={m.symbol} className="flex items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{m.symbol}</div>
                <div className="muted truncate text-xs">{m.name}</div>
              </div>
              <div className="text-right">
                <Change pct={m.dayChangePct} />
                <div className="muted text-xs tabular-nums">{formatMoney(m.dayChange, currency, { signed: true })}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Best and worst holdings of the day (at most five each). */
export function MoversSection() {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useAnalyticsSummary(scope, { enabled: ready });
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load top movers" />;
  if (isPending) {
    return (
      <LoadingRegion label="Loading top movers">
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </LoadingRegion>
    );
  }
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <MoverList title="Top day gainers" movers={data.gainers} empty="No holding is up today." currency={data.baseCurrency} />
      <MoverList title="Top day losers" movers={data.losers} empty="No holding is down today." currency={data.baseCurrency} />
    </div>
  );
}
