import type { AnalyticsSummaryResponse } from '@portfolio/shared';
import { useAnalyticsSummary } from '../../api/analyticsHooks';
import { Change } from '../../components/Change';
import { ErrorState } from '../../components/ErrorState';
import { KpiCard } from '../../components/KpiCard';
import { formatDate, formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

type Performance = AnalyticsSummaryResponse['performance'];

function irrHint(p: Performance): string {
  if (p.irrPct === null || p.since === null) return 'Not enough history yet';
  return p.irrAnnualised ? `Per year, since ${formatDate(p.since)}` : `Since ${formatDate(p.since)} · under a year, so not annualised`;
}

function twrHint(p: Performance): string {
  if (p.twrPct === null || p.since === null) return 'Not enough history yet';
  if (p.twrAnnualisedPct === null) return `Since ${formatDate(p.since)} · excludes deposits and withdrawals`;
  return `${formatPercent(p.twrAnnualisedPct, { signed: true })} per year, since ${formatDate(p.since)}`;
}

const ReturnValue = ({ pct }: Readonly<{ pct: number | null }>) => (pct === null ? '—' : <Change pct={pct} />);

/** Money-weighted and time-weighted return plus the forward passive income, from GET /analytics/summary. */
export function AnalyticsKpis() {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useAnalyticsSummary(scope, { enabled: ready });
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load return analytics" />;
  const ccy = data?.baseCurrency ?? 'EUR';
  const income = data?.passiveIncome;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy={isPending || undefined}>
      <KpiCard
        loading={isPending}
        label="Money-weighted return (IRR)"
        value={data && <ReturnValue pct={data.performance.irrPct} />}
        hint={data && irrHint(data.performance)}
      />
      <KpiCard
        loading={isPending}
        label="Time-weighted return (TWR)"
        value={data && <ReturnValue pct={data.performance.twrPct} />}
        hint={data && twrHint(data.performance)}
      />
      <KpiCard
        loading={isPending}
        label="Passive income (next 12 months)"
        value={income && formatMoney(income.forward12m, ccy)}
        hint={
          income &&
          `${formatPercent(income.yieldOnValuePct)} yield on value · ${formatPercent(income.yieldOnCostPct)} on cost · ${formatMoney(income.declared, ccy)} declared`
        }
      />
    </div>
  );
}
