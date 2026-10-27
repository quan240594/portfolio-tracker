import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ALL_PORTFOLIOS, HISTORY_RANGES, isMarketSymbol, type AllocationDimension, type DashboardPeriod, type GetPortfolioResponse, type HistoryRange } from '@portfolio/shared';
import { useAllocation, useHistory, useHoldings, usePortfolio } from '../api/hooks';
import { KpiCard } from '../components/KpiCard';
import { Change } from '../components/Change';
import { CompanyLogo } from '../components/CompanyLogo';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { SegmentedControl } from '../components/SegmentedControl';
import { PageHeader } from '../components/Layout';
import { ValueChart } from '../components/charts/ValueChart';
import { ValuedAtCostNote } from '../components/charts/ValuedAtCostNote';
import { AllocationDonut } from '../components/charts/AllocationDonut';
import { StaleBadge } from '../features/holdings/HoldingsTable';
import { WatchlistWidget } from '../features/watchlist/WatchlistWidget';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';
import { PassiveIncomeKpi, ReturnKpis } from '../features/analytics/AnalyticsKpis';
import { TrailingDividendKpis } from '../features/dividends/TrailingKpis';
import { InsightsSection } from '../features/analytics/InsightsSection';
import { MoversSection } from '../features/analytics/MoversSection';
import { DashboardCalendarCard } from '../features/dashboard/DashboardCalendarCard';
import { PERIOD_OPTIONS, useDashboardPeriod } from '../features/dashboard/dashboardPeriod';
import { PortfolioKpis } from '../features/dashboard/PortfolioKpis';
import { BASE_CURRENCY, formatDateTime, formatMoney, formatPercent, formatWeight } from '../lib/format';

type AllocationTab = Exclude<AllocationDimension, 'symbol'> | 'category';

const ALLOCATION_TABS: { value: AllocationTab; label: string }[] = [
  { value: 'assetClass', label: 'Asset class' },
  { value: 'sector', label: 'Sector' },
  { value: 'country', label: 'Country' },
  { value: 'currency', label: 'Currency' },
  { value: 'category', label: 'Category' },
];

const RANGE_OPTIONS = HISTORY_RANGES.map((r) => ({ value: r, label: r }));


/** Cash and custom assets, only for portfolios that hold them: after the twelve standard cards, so those keep their rows. */
function HoldingsBreakdownKpis() {
  const { scope, ready } = usePortfolioScope();
  const { data } = usePortfolio(scope, { enabled: ready });
  const ccy = data?.baseCurrency ?? BASE_CURRENCY;
  return (
    <>
      {data?.cashValue !== undefined && (
        <KpiCard label="Cash" value={formatMoney(data.cashValue, ccy)} hint={`Included in total value. Interest and fees: ${formatMoney(data.cashIncome ?? 0, ccy, { signed: true })}`} />
      )}
      {data?.customAssetsValue !== undefined && (
        <KpiCard label="Custom assets" value={formatMoney(data.customAssetsValue, ccy)} hint="Real estate, savings and other manually valued assets. Included in total value." />
      )}
    </>
  );
}

/** One grid of twelve stat cards: three per row on desktop, two on tablets, one on phones. */
function KpiGrid({ period }: Readonly<{ period: DashboardPeriod }>) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="kpi-grid">
      <PortfolioKpis period={period} />
      <ReturnKpis period={period} />
      <TrailingDividendKpis />
      <PassiveIncomeKpi />
      <HoldingsBreakdownKpis />
    </div>
  );
}

function PerformanceCard() {
  const [range, setRange] = useState<HistoryRange>('1Y');
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch, isPlaceholderData } = useHistory(scope, range, { enabled: ready });
  const first = data?.points[0];
  const last = data?.points.at(-1);
  const delta = first && last ? last.value - last.invested - (first.value - first.invested) : 0;

  let body: ReactNode;
  if (isError) {
    body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load history" />;
  } else if (isPending) {
    body = (
      <LoadingRegion label="Loading chart">
        <Skeleton className="h-72 w-full" />
      </LoadingRegion>
    );
  } else if (data.points.length === 0) {
    body = <p className="muted flex h-72 items-center justify-center text-sm">No history for this period yet.</p>;
  } else {
    body = (
      <div className={isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        <ValueChart points={data.points} currency={data.baseCurrency} />
      </div>
    );
  }

  return (
    <section className="card p-4 lg:col-span-2" aria-labelledby="perf-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="perf-title" className="font-semibold">
            Value vs invested
          </h2>
          {data && first && last && (
            <p className="muted text-xs">
              P&amp;L change over period: <Change amount={delta} currency={data.baseCurrency} />
            </p>
          )}
          {data?.valuedAtCost && <ValuedAtCostNote valuedAtCost={data.valuedAtCost} />}
        </div>
        <SegmentedControl label="Chart range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
      </div>
      {body}
    </section>
  );
}

function AllocationCard() {
  const [selectedBy, setSelectedBy] = useState<AllocationTab>('assetClass');
  const { scope, ready } = usePortfolioScope();
  // Categories belong to one portfolio, so that tab only exists outside the combined view.
  const tabs = scope === ALL_PORTFOLIOS ? ALLOCATION_TABS.filter((t) => t.value !== 'category') : ALLOCATION_TABS;
  const by = tabs.some((t) => t.value === selectedBy) ? selectedBy : 'assetClass';
  const { data, isPending, isError, error, refetch } = useAllocation(scope, by, { enabled: ready });
  const panelId = 'allocation-panel';

  let body: ReactNode;
  if (isError) {
    body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load allocation" />;
  } else if (isPending) {
    body = (
      <LoadingRegion label="Loading allocation">
        <Skeleton className="mx-auto h-48 w-48 rounded-full" />
      </LoadingRegion>
    );
  } else if (data.slices.length === 0) {
    body = <p className="muted text-sm">Nothing to allocate yet.</p>;
  } else {
    body = <AllocationDonut key={by} slices={data.slices} currency={data.baseCurrency} dimension={tabs.find((t) => t.value === by)?.label} />;
  }
  return (
    <section className="card p-4" aria-labelledby="alloc-title">
      <h2 id="alloc-title" className="mb-3 font-semibold">
        Allocation
      </h2>
      <SegmentedControl variant="tabs" label="Allocation by" options={tabs} value={by} onChange={setSelectedBy} panelId={panelId} idPrefix="alloc-tab" />
      <div id={panelId} role="tabpanel" aria-labelledby={`alloc-tab-${by}`} className="mt-4">
        {body}
      </div>
    </section>
  );
}

function TopHoldingsCard() {
  const { scope, ready, withScope } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = useHoldings(scope, { enabled: ready });

  let body: ReactNode;
  if (isError) {
    body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load holdings" />;
  } else if (isPending) {
    body = (
      <LoadingRegion label="Loading holdings">
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      </LoadingRegion>
    );
  } else {
    body = (
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {data.holdings.slice(0, 5).map((h) => (
          <li key={h.symbol} className="flex items-center gap-3 py-2.5 text-sm">
            {isMarketSymbol(h.symbol) && <CompanyLogo symbol={h.symbol} name={h.name} size={28} decorative />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-semibold">
                {h.symbol} {h.priceStale && <StaleBadge />}
              </div>
              <div className="muted text-xs break-words">{h.name}</div>
            </div>
            <div className="text-right">
              <div className="font-medium tabular-nums">{formatMoney(h.marketValue, data.baseCurrency)}</div>
              <Change pct={h.unrealizedPnlPct} value={h.unrealizedPnl} className="text-xs" />
            </div>
            <div className="muted w-12 text-right text-xs tabular-nums">{formatWeight(h.weight)}</div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="card p-4" aria-labelledby="top-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="top-title" className="font-semibold">
          Top holdings
        </h2>
        <Link to={withScope('/holdings')} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
          View all →
        </Link>
      </div>
      {body}
    </section>
  );
}

/** "<scope> · values in EUR · as of …" once the summary has loaded; just the scope name before that. */
function dashboardDescription(data: GetPortfolioResponse | undefined, scopeName: string): string | undefined {
  if (!data) return scopeName || undefined;
  const prefix = scopeName ? `${scopeName} · values` : 'Values';
  const asOf = formatDateTime(data.asOf);
  return `${prefix} in ${data.baseCurrency} · as of ${asOf}`;
}

export function DashboardPage() {
  const { scope, ready, scopeName, withScope, current } = usePortfolioScope();
  const portfolio = usePortfolio(scope, { enabled: ready });
  const isEmpty = portfolio.data?.holdingsCount === 0 && portfolio.data.totalReturn === 0;
  const [period, setPeriod] = useDashboardPeriod();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={dashboardDescription(portfolio.data, scopeName)}
        actions={isEmpty ? undefined : <SegmentedControl label="Period" options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />}
      />
      {isEmpty ? (
        <EmptyState
          title={current ? `No transactions in ${current.name} yet` : 'No transactions yet'}
          description={
            current
              ? 'Add a buy to this portfolio or import a CSV export from your broker to see it come to life.'
              : 'Add your first buy or import a CSV export from your broker to see your portfolio come to life.'
          }
          actions={
            <>
              <Link to={withScope('/transactions?action=add')} className="btn-primary">Add transaction</Link>
              <Link to={withScope('/transactions?action=import')} className="btn-secondary">Import CSV</Link>
            </>
          }
        />
      ) : (
        <div className="space-y-6">
          <KpiGrid period={period} />
          <InsightsSection />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <PerformanceCard />
            <AllocationCard />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TopHoldingsCard />
            <DashboardCalendarCard />
            <div className="empty:hidden lg:col-span-2">
              <WatchlistWidget />
            </div>
          </div>
          <MoversSection />
          {portfolio.data && (
            <p className="muted text-xs">
              Total return {formatPercent(portfolio.data.totalReturnPct, { signed: true })} on amount invested, including realized gains and dividends.
            </p>
          )}
        </div>
      )}
    </>
  );
}
