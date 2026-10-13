import type { DividendPayment } from '@portfolio/shared';
import { useDividends } from '../api/hooks';
import { PageHeader } from '../components/Layout';
import { KpiCard } from '../components/KpiCard';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { DividendBarChart } from '../components/charts/DividendBarChart';
import { formatDate, formatMoney } from '../lib/format';

function PaymentsTable({ payments, currency, caption }: { payments: DividendPayment[]; currency: string; caption: string }) {
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

export function DividendsPage() {
  const { data, isPending, isError, error, refetch } = useDividends();
  const ccy = data?.baseCurrency ?? 'EUR';

  if (isError) {
    return (
      <>
        <PageHeader title="Dividends" />
        <ErrorState error={error} onRetry={() => void refetch()} title="Could not load dividends" />
      </>
    );
  }

  const empty = data && data.received.length === 0 && data.upcoming.length === 0;

  return (
    <>
      <PageHeader title="Dividends" description="Received amounts are net of withholding tax; upcoming amounts are gross estimates." />
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard loading={isPending} label="Total received" value={data && formatMoney(data.totalReceived, ccy)} hint="All time" />
          <KpiCard loading={isPending} label="Last 12 months" value={data && formatMoney(data.last12Months, ccy)} />
          <KpiCard
            loading={isPending}
            label="Projected next 12 months"
            value={data && formatMoney(data.projectedNext12Months, ccy)}
            hint={data && `≈ ${formatMoney(data.projectedNext12Months / 12, ccy)} per month`}
          />
        </div>

        {empty ? (
          <EmptyState title="No dividends yet" description="Dividend transactions and announced payouts for your holdings will show up here." />
        ) : (
          <>
            <section className="card p-4" aria-labelledby="div-monthly">
              <h2 id="div-monthly" className="mb-3 font-semibold">Monthly dividends</h2>
              {isPending ? (
                <LoadingRegion label="Loading chart"><Skeleton className="h-72 w-full" /></LoadingRegion>
              ) : (
                <DividendBarChart monthly={data.monthly} currency={ccy} />
              )}
            </section>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section className="card p-4" aria-labelledby="div-upcoming">
                <h2 id="div-upcoming" className="mb-3 font-semibold">Upcoming</h2>
                {isPending ? (
                  <Skeleton className="h-40 w-full" />
                ) : data.upcoming.length === 0 ? (
                  <p className="muted text-sm">No announced dividends for your current holdings.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.upcoming.map((p, i) => (
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
                        <div className="font-medium tabular-nums">{formatMoney(p.amount, ccy)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card p-4" aria-labelledby="div-received">
                <h2 id="div-received" className="mb-3 font-semibold">Received</h2>
                {isPending ? (
                  <Skeleton className="h-40 w-full" />
                ) : data.received.length === 0 ? (
                  <p className="muted text-sm">No dividends received yet.</p>
                ) : (
                  <div className="max-h-96 overflow-y-auto">
                    <PaymentsTable payments={[...data.received].reverse()} currency={ccy} caption="Received dividends, newest first" />
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
