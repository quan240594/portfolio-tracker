import type { DividendPayment } from '@portfolio/shared';
import { useDividends } from '../api/hooks';
import { PageHeader } from '../components/Layout';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { BASE_CURRENCY, formatDate, formatMoney } from '../lib/format';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';
import { ConsistencyCard } from '../features/dividends/ConsistencyCard';
import { DiversificationCard } from '../features/dividends/DiversificationCard';
import { DividendGrowthCard } from '../features/dividends/DividendGrowthCard';
import { AverageGrowthCard, FuturePaymentsCard } from '../features/dividends/GrowthAndFuture';
import { ReceivedCards } from '../features/dividends/ReceivedCards';
import { DividendsKpi, YieldKpi } from '../features/dividends/YieldKpis';
import { YieldPayoutCard } from '../features/dividends/YieldPayoutCard';

function PaymentsTable({ payments, currency, caption }: Readonly<{ payments: DividendPayment[]; currency: string; caption: string }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
            <th scope="col" className="py-2 pr-3 font-medium">Date</th>
            <th scope="col" className="py-2 pr-3 font-medium">Symbol</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Per share</th>
            <th scope="col" className="py-2 text-right font-medium">Amount ({currency})</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p, i) => (
            <tr key={`${p.symbol}-${p.date}-${i}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
              <td className="py-2 pr-3 whitespace-nowrap">{formatDate(p.date)}</td>
              <td className="py-2 pr-3 font-medium">{p.symbol}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(p.perShareLocal, p.currency, { maxDigits: 4 })}</td>
              <td className="py-2 text-right font-medium tabular-nums">{formatMoney(p.amount, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `upcoming` is undefined while the dividends are still loading. */
function UpcomingList({ upcoming, currency }: Readonly<{ upcoming?: DividendPayment[]; currency: string }>) {
  if (!upcoming) return <Skeleton className="h-40 w-full" />;
  if (upcoming.length === 0) return <p className="muted text-sm">No announced dividends for your current holdings.</p>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {upcoming.map((p, i) => (
        <li key={`${p.symbol}-${p.date}-${i}`} className="flex items-center gap-3 py-2.5 text-sm">
          <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
            <span className="text-[10px] leading-none uppercase">{formatDate(p.date, { month: 'short' })}</span>
            <span className="font-semibold leading-tight">{formatDate(p.date, { day: 'numeric' })}</span>
          </div>
          <div className="flex-1">
            <div className="font-medium">{p.symbol}</div>
            <div className="muted text-xs">
              {formatMoney(p.perShareLocal, p.currency, { maxDigits: 4 })} per share · pays {formatDate(p.date)}
            </div>
          </div>
          <div className="font-medium tabular-nums">{formatMoney(p.amount, currency)}</div>
        </li>
      ))}
    </ul>
  );
}

/** `received` is undefined while the dividends are still loading. */
function ReceivedList({ received, currency }: Readonly<{ received?: DividendPayment[]; currency: string }>) {
  if (!received) return <Skeleton className="h-40 w-full" />;
  if (received.length === 0) return <p className="muted text-sm">No dividends received yet.</p>;
  return (
    <div className="max-h-96 overflow-y-auto">
      <PaymentsTable payments={[...received].reverse()} currency={currency} caption="Received dividends, newest first" />
    </div>
  );
}

/** Received and upcoming payments in a collapsible section at the bottom of the page. */
function PaymentHistory({ query }: Readonly<{ query: ReturnType<typeof useDividends> }>) {
  const { data, isError, error, refetch } = query;
  return (
    <details className="card group p-4" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg [&::-webkit-details-marker]:hidden">
        <h2 id="div-history" className="font-semibold">
          Payment history
        </h2>
        <span aria-hidden="true" className="muted text-xs group-open:hidden">Show</span>
        <span aria-hidden="true" className="muted hidden text-xs group-open:inline">Hide</span>
      </summary>
      <div className="mt-4">
        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} title="Could not load dividends" />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section aria-labelledby="div-upcoming">
              <h3 id="div-upcoming" className="mb-3 text-sm font-semibold">Upcoming</h3>
              <UpcomingList upcoming={data?.upcoming} currency={data?.baseCurrency ?? BASE_CURRENCY} />
            </section>
            <section aria-labelledby="div-received">
              <h3 id="div-received" className="mb-3 text-sm font-semibold">Received</h3>
              <ReceivedList received={data?.received} currency={data?.baseCurrency ?? BASE_CURRENCY} />
            </section>
          </div>
        )}
      </div>
    </details>
  );
}

export function DividendsPage() {
  const { scope, ready, scopeName, current } = usePortfolioScope();
  const query = useDividends(scope, { enabled: ready });
  const { data } = query;
  const ccy = data?.baseCurrency ?? BASE_CURRENCY;
  const amountsIn = scopeName ? `${scopeName} · amounts in ${ccy}` : `Amounts in ${ccy}`;
  const empty = data?.received.length === 0 && data.upcoming.length === 0;

  return (
    <>
      <PageHeader title="Dividends" description={`${amountsIn} (per-share amounts in the paying currency). Received amounts are net of withholding tax; forward income is declared plus estimated.`} />
      {empty ? (
        <EmptyState title={current ? `No dividends in ${current.name} yet` : 'No dividends yet'} description="Dividend transactions and announced payouts for your holdings will show up here." />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="flex flex-col gap-4 lg:col-span-1">
              <YieldKpi />
              <DividendsKpi />
            </div>
            <div className="lg:col-span-2">
              <YieldPayoutCard />
            </div>
          </div>
          <DiversificationCard />
          <ConsistencyCard />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AverageGrowthCard />
            <FuturePaymentsCard />
          </div>
          <ReceivedCards />
          <DividendGrowthCard />
          <PaymentHistory query={query} />
        </div>
      )}
    </>
  );
}

