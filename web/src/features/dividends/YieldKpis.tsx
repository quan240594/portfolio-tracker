import type { ReactNode } from 'react';
import type { DividendsOverviewResponse } from '@portfolio/shared';
import { Skeleton } from '../../components/Skeleton';
import { ErrorState } from '../../components/ErrorState';
import { formatMoney, formatPercent } from '../../lib/format';
import { InfoTip } from './DividendCard';
import { useScopedDividendsOverview } from './useDividendsOverview';

interface BlockProps {
  id: string;
  label: string;
  info: ReactNode;
  children: (data: DividendsOverviewResponse) => ReactNode;
}

/** KPI card whose figures come from the overview; same look as KpiCard plus an info tip. */
function KpiBlock({ id, label, info, children }: Readonly<BlockProps>) {
  const { data, isPending, isError, error, refetch } = useScopedDividendsOverview();
  let body: ReactNode;
  if (isError) body = <ErrorState error={error} onRetry={() => void refetch()} title={`Could not load ${label.toLowerCase()}`} />;
  else if (isPending || !data) {
    body = (
      <>
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-28" />
      </>
    );
  } else body = children(data);
  return (
    <section className="card relative flex flex-1 flex-col gap-1.5 p-4" aria-labelledby={id} aria-busy={isPending || undefined}>
      <div className="flex items-center gap-2">
        <h2 id={id} className="muted text-xs font-medium tracking-wide uppercase">
          {label}
        </h2>
        <InfoTip label={label}>{info}</InfoTip>
      </div>
      {body}
    </section>
  );
}

export function YieldKpi() {
  return (
    <KpiBlock
      id="div-kpi-yield"
      label="Yield"
      info={
        <>
          <p>Forward yield: the dividends you are expected to receive over the next 12 months (net of withholding tax), divided by the current market value of your holdings.</p>
          <p>Yield on cost divides the same income by what you paid for those holdings. Both use the same forward income as the Dividends KPI.</p>
        </>
      }
    >
      {({ summary, holdings }) => {
        const payers = holdings.filter((h) => h.forward12m > 0).length;
        return (
          <>
            <p className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="kpi-yield">
              {formatPercent(summary.yieldOnValuePct)}
            </p>
            <p className="muted text-sm">
              Yield on cost <span className="font-medium text-slate-900 tabular-nums dark:text-slate-100">{formatPercent(summary.yieldOnCostPct)}</span>
            </p>
            <p className="muted mt-auto pt-2 text-xs">
              Forward 12-month income ÷ market value, from {payers} dividend-paying holding{payers === 1 ? '' : 's'}
            </p>
          </>
        );
      }}
    </KpiBlock>
  );
}

function growthLine(growth: number | null, last12m: number, currency: string): ReactNode {
  if (growth === null) return <span className="muted">No dividends received in the previous 12 months to compare with</span>;
  return (
    <span className="muted">
      <span className={`font-medium tabular-nums ${growth >= 0 ? 'gain-text' : 'loss-text'}`}>{formatPercent(growth, { signed: true, digits: 1 })}</span> vs the previous 12 months ({formatMoney(last12m, currency)} received)
    </span>
  );
}

export function DividendsKpi() {
  return (
    <KpiBlock
      id="div-kpi-income"
      label="Dividends"
      info={
        <>
          <p>Forward 12-month income: declared dividends (announced, with an ex-date in the next 12 months) plus an estimate for the payments your payment history implies but that are not announced yet.</p>
          <p>Amounts are net of the withholding tax you paid in the last 12 months. The growth compares this forward income with what you received in the previous 12 months, so a recently bought holding inflates it.</p>
        </>
      }
    >
      {({ summary, baseCurrency }) => (
        <>
          <p className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="kpi-income">
            {formatMoney(summary.forward12m, baseCurrency)}
          </p>
          <p className="muted text-sm">
            <span className="font-medium text-slate-900 tabular-nums dark:text-slate-100">{formatMoney(summary.monthlyAverage, baseCurrency)}</span> per month on average
          </p>
          <p className="text-xs">{growthLine(summary.growthVsLast12mPct, summary.last12m, baseCurrency)}</p>
        </>
      )}
    </KpiBlock>
  );
}
