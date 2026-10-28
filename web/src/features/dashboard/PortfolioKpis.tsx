import type { DashboardPeriod, GetPortfolioResponse, PeriodPerformance } from '@portfolio/shared';
import { useAnalyticsSummary } from '../../api/analyticsHooks';
import { usePortfolio } from '../../api/hooks';
import { Change } from '../../components/Change';
import { ErrorState } from '../../components/ErrorState';
import { KpiCard } from '../../components/KpiCard';
import { BASE_CURRENCY, formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { SNAPSHOT_NOTE, coverageLabel, queryPeriod } from './dashboardPeriod';
import { ProjectedRestOfYear } from './ProjectedRestOfYear';

interface Figures {
  totalReturn: number;
  totalReturnPct: number;
  dividends: number;
  realizedPnl: number;
}

/** The three period-dependent figures: the window's own numbers, or the all-time ones of GET /portfolio. */
function figuresOf(data: GetPortfolioResponse, pp: PeriodPerformance | undefined): Figures {
  if (pp) return { totalReturn: pp.totalReturn, totalReturnPct: pp.totalReturnPct, dividends: pp.dividends, realizedPnl: pp.realizedPnl };
  return { totalReturn: data.totalReturn, totalReturnPct: data.totalReturnPct, dividends: data.dividendsReceived, realizedPnl: data.realizedPnl };
}

const joinHint = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(' · ');

const PERIOD_FAILED = 'Could not load this period';

const REALIZED_HINT = 'Gains and losses on positions you sold, after fees. Not included in Unrealized P&L.';

interface Hints {
  totalReturn?: string;
  dividends?: string;
  realized: string;
}

function hintsOf({ failed, figures, coverage, currency }: Readonly<{ failed: boolean; figures: Figures | undefined; coverage: string | undefined; currency: string }>): Hints {
  if (failed) return { totalReturn: PERIOD_FAILED, dividends: PERIOD_FAILED, realized: PERIOD_FAILED };
  if (!figures) return { realized: REALIZED_HINT };
  const parts = `Incl. ${formatMoney(figures.realizedPnl, currency, { signed: true })} realized, ${formatMoney(figures.dividends, currency)} dividends`;
  return {
    totalReturn: joinHint(parts, coverage),
    dividends: coverage ? joinHint('Net of withholding tax', coverage) : 'Net of withholding tax, all time',
    realized: REALIZED_HINT,
  };
}

function usePortfolioSummary() {
  const { scope, ready } = usePortfolioScope();
  const query = usePortfolio(scope, { enabled: ready });
  return { query, data: query.data, ccy: query.data?.baseCurrency ?? BASE_CURRENCY };
}

type SummaryQuery = ReturnType<typeof usePortfolioSummary>['query'];

/** The summary failed: Total value reports it once (the other cards that need it step aside and take no room). */
const SummaryFailure = ({ query }: Readonly<{ query: SummaryQuery }>) => (
  <ErrorState error={query.error} onRetry={() => void query.refetch()} title="Could not load portfolio summary" />
);

/** Total value card; it also reports a failed portfolio summary for the cards of this group. */
export function TotalValueKpi() {
  const { query, data, ccy } = usePortfolioSummary();
  if (query.isError) return <SummaryFailure query={query} />;
  return (
    <KpiCard
      loading={query.isPending}
      label="Total value"
      note={SNAPSHOT_NOTE}
      value={data && formatMoney(data.totalValue, ccy)}
      hint={data && `${data.holdingsCount} holdings · cost ${formatMoney(data.totalCost, ccy)}`}
    />
  );
}

export function DayChangeKpi() {
  const { query, data, ccy } = usePortfolioSummary();
  if (query.isError) return null;
  return (
    <KpiCard
      loading={query.isPending}
      label="Day change"
      note={SNAPSHOT_NOTE}
      value={data && formatMoney(data.dayChange, ccy, { signed: true })}
      change={data && <Change pct={data.dayChangePct} value={data.dayChange} />}
    />
  );
}

export function UnrealizedKpi() {
  const { query, data, ccy } = usePortfolioSummary();
  if (query.isError) return null;
  return (
    <KpiCard
      loading={query.isPending}
      label="Unrealized P&L"
      note={SNAPSHOT_NOTE}
      value={data && formatMoney(data.unrealizedPnl, ccy, { signed: true })}
      change={data && <Change pct={data.unrealizedPnlPct} value={data.unrealizedPnl} />}
      hint={data && `Incl. ${formatMoney(data.currencyEffect, ccy, { signed: true })} currency effect`}
    />
  );
}

export function CurrencyEffectKpi() {
  const { query, data, ccy } = usePortfolioSummary();
  if (query.isError) return null;
  return (
    <KpiCard
      loading={query.isPending}
      label="Currency effect"
      note={SNAPSHOT_NOTE}
      value={data && <Change amount={data.currencyEffect} currency={ccy} />}
      hint={`Part of the unrealized P&L caused by exchange-rate moves since purchase — e.g. a weaker US dollar lowers the ${ccy} value of US shares. Already included in Unrealized P&L.`}
    />
  );
}

/** The figures that follow the selected period, with the loading and failure state of the two requests behind them. */
function usePeriodFigures(period: DashboardPeriod) {
  const { scope, ready } = usePortfolioScope();
  const { query, data, ccy } = usePortfolioSummary();
  const windowed = period !== 'all';
  const summary = useAnalyticsSummary(scope, { enabled: ready && windowed, period: queryPeriod(period) });
  const pp = windowed ? summary.data?.periodPerformance : undefined;
  const failed = windowed && summary.isError;
  const figures = data && (!windowed || pp !== undefined) ? figuresOf(data, pp) : undefined;
  return {
    query,
    ccy,
    loading: query.isPending || (windowed && summary.isPending),
    failed,
    shown: failed ? undefined : figures,
    dash: failed ? '—' : undefined,
    hints: hintsOf({ failed, figures, coverage: pp && coverageLabel(period, pp), currency: ccy }),
  };
}

export function TotalReturnKpi({ period }: Readonly<{ period: DashboardPeriod }>) {
  const { query, ccy, loading, shown, dash, hints } = usePeriodFigures(period);
  if (query.isError) return null;
  return (
    <KpiCard
      loading={loading}
      label="Total return"
      value={dash ?? (shown && formatMoney(shown.totalReturn, ccy, { signed: true }))}
      change={shown && <Change pct={shown.totalReturnPct} value={shown.totalReturn} />}
      hint={hints.totalReturn}
    />
  );
}

export function DividendsReceivedKpi({ period }: Readonly<{ period: DashboardPeriod }>) {
  const { query, ccy, loading, shown, dash, hints } = usePeriodFigures(period);
  if (query.isError) return null;
  return (
    <KpiCard
      loading={loading}
      label="Dividends received"
      value={dash ?? (shown && formatMoney(shown.dividends, ccy))}
      change={<ProjectedRestOfYear />}
      hint={hints.dividends}
    />
  );
}

export function RealizedPnlKpi({ period }: Readonly<{ period: DashboardPeriod }>) {
  const { query, ccy, loading, shown, dash, hints } = usePeriodFigures(period);
  if (query.isError) return null;
  return <KpiCard loading={loading} label="Realized P&L" value={dash ?? (shown && formatMoney(shown.realizedPnl, ccy, { signed: true }))} hint={hints.realized} />;
}
