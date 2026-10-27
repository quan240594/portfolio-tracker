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

interface PeriodCardsProps {
  period: DashboardPeriod;
  currency: string;
  loading: boolean;
  failed: boolean;
  figures: Figures | undefined;
  pp: PeriodPerformance | undefined;
}

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

/** Total return, dividends received and realized P&L: they follow the selected period. */
function PeriodCards({ period, currency, loading, failed, figures, pp }: Readonly<PeriodCardsProps>) {
  const hints = hintsOf({ failed, figures, coverage: pp && coverageLabel(period, pp), currency });
  const shown = failed ? undefined : figures;
  const dash = failed ? '—' : undefined;
  return (
    <>
      <KpiCard
        loading={loading}
        label="Total return"
        value={dash ?? (shown && formatMoney(shown.totalReturn, currency, { signed: true }))}
        change={shown && <Change pct={shown.totalReturnPct} value={shown.totalReturn} />}
        hint={hints.totalReturn}
      />
      <KpiCard
        loading={loading}
        label="Dividends received"
        value={dash ?? (shown && formatMoney(shown.dividends, currency))}
        change={<ProjectedRestOfYear />}
        hint={hints.dividends}
      />
      <KpiCard loading={loading} label="Realized P&L" value={dash ?? (shown && formatMoney(shown.realizedPnl, currency, { signed: true }))} hint={hints.realized} />
    </>
  );
}

/** The first seven stat cards (grid cells, rendered inside the dashboard's single stat grid). */
export function PortfolioKpis({ period }: Readonly<{ period: DashboardPeriod }>) {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = usePortfolio(scope, { enabled: ready });
  const windowed = period !== 'all';
  const summary = useAnalyticsSummary(scope, { enabled: ready && windowed, period: queryPeriod(period) });
  if (isError) {
    return (
      <div className="sm:col-span-2 lg:col-span-3">
        <ErrorState error={error} onRetry={() => void refetch()} title="Could not load portfolio summary" />
      </div>
    );
  }
  const ccy = data?.baseCurrency ?? BASE_CURRENCY;
  const pp = windowed ? summary.data?.periodPerformance : undefined;
  const hasFigures = data !== undefined && (!windowed || pp !== undefined);
  return (
    <>
      <KpiCard
        loading={isPending}
        label="Total value"
        note={SNAPSHOT_NOTE}
        value={data && formatMoney(data.totalValue, ccy)}
        hint={data && `${data.holdingsCount} holdings · cost ${formatMoney(data.totalCost, ccy)}`}
      />
      <KpiCard
        loading={isPending}
        label="Day change"
        note={SNAPSHOT_NOTE}
        value={data && formatMoney(data.dayChange, ccy, { signed: true })}
        change={data && <Change pct={data.dayChangePct} value={data.dayChange} />}
      />
      <KpiCard
        loading={isPending}
        label="Unrealized P&L"
        note={SNAPSHOT_NOTE}
        value={data && formatMoney(data.unrealizedPnl, ccy, { signed: true })}
        change={data && <Change pct={data.unrealizedPnlPct} value={data.unrealizedPnl} />}
        hint={data && `Incl. ${formatMoney(data.currencyEffect, ccy, { signed: true })} currency effect`}
      />
      <KpiCard
        loading={isPending}
        label="Currency effect"
        note={SNAPSHOT_NOTE}
        value={data && <Change amount={data.currencyEffect} currency={ccy} />}
        hint={`Part of the unrealized P&L caused by exchange-rate moves since purchase — e.g. a weaker US dollar lowers the ${ccy} value of US shares. Already included in Unrealized P&L.`}
      />
      <PeriodCards
        period={period}
        currency={ccy}
        loading={isPending || (windowed && summary.isPending)}
        failed={windowed && summary.isError}
        figures={data && hasFigures ? figuresOf(data, pp) : undefined}
        pp={pp}
      />
    </>
  );
}
