import type { AnalyticsSummaryResponse, DashboardPeriod } from '@portfolio/shared';
import { useAnalyticsSummary } from '../../api/analyticsHooks';
import { Change } from '../../components/Change';
import { ErrorState } from '../../components/ErrorState';
import { KpiCard } from '../../components/KpiCard';
import { formatDate, formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { SNAPSHOT_NOTE, coverageLabel, queryPeriod } from '../dashboard/dashboardPeriod';

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

/** The figures of the selected window when the response carries them, else the all-time ones. */
function performanceFor(data: AnalyticsSummaryResponse): { perf: Performance; truncatedNote: string | undefined } {
  const pp = data.periodPerformance;
  if (!pp) return { perf: data.performance, truncatedNote: undefined };
  const { period, from, days, irrPct, irrAnnualised, twrPct, twrAnnualisedPct } = pp;
  return { perf: { since: from, days, irrPct, irrAnnualised, twrPct, twrAnnualisedPct }, truncatedNote: pp.truncated ? coverageLabel(period, pp) : undefined };
}

const withNote = (hint: string, note: string | undefined): string => (note ? `${hint} · ${note}` : hint);

/** Money-weighted and time-weighted return cards (grid cells), from GET /analytics/summary (of the selected period when one is given). */
export function ReturnKpis({ period = 'all' }: Readonly<{ period?: DashboardPeriod }>) {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useAnalyticsSummary(scope, { enabled: ready, period: queryPeriod(period) });
  if (isError) {
    return (
      <div className="sm:col-span-2 lg:col-span-2">
        <ErrorState error={error} onRetry={() => void refetch()} title="Could not load return analytics" className="h-full" />
      </div>
    );
  }
  const shown = data && performanceFor(data);
  return (
    <>
      <KpiCard
        loading={isPending}
        label="Money-weighted return (IRR)"
        value={shown && <ReturnValue pct={shown.perf.irrPct} />}
        hint={shown && withNote(irrHint(shown.perf), shown.truncatedNote)}
      />
      <KpiCard
        loading={isPending}
        label="Time-weighted return (TWR)"
        value={shown && <ReturnValue pct={shown.perf.twrPct} />}
        hint={shown && withNote(twrHint(shown.perf), shown.truncatedNote)}
      />
    </>
  );
}

/** Forward passive income card (a grid cell), from GET /analytics/summary. */
export function PassiveIncomeKpi() {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useAnalyticsSummary(scope, { enabled: ready });
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load passive income" className="h-full" />;
  const ccy = data?.baseCurrency ?? 'EUR';
  const income = data?.passiveIncome;
  return (
    <KpiCard
      loading={isPending}
      label="Passive income (next 12 months)"
      note={SNAPSHOT_NOTE}
      value={income && formatMoney(income.forward12m, ccy)}
      hint={
        income &&
        `${formatPercent(income.yieldOnValuePct)} yield on value · ${formatPercent(income.yieldOnCostPct)} on cost · ${formatMoney(income.declared, ccy)} declared`
      }
      info={
        <>
          <p>Forward income: declared dividends (announced, with an ex-date in the next 12 months) plus an estimate for the payments your history implies but that are not announced yet, net of withholding tax.</p>
          <p>It looks ahead. The Dividend yield (TTM) card looks back at what you actually received in the last 12 months.</p>
        </>
      }
    />
  );
}
