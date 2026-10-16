import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ALL_PORTFOLIOS, HISTORY_RANGES, type AllocationDimension, type GetPortfolioResponse, type HistoryRange } from '@portfolio/shared';
import { useAllocation, useHistory, useHoldings, usePortfolio } from '../api/hooks';
import { KpiCard } from '../components/KpiCard';
import { Change } from '../components/Change';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { SegmentedControl } from '../components/SegmentedControl';
import { PageHeader } from '../components/Layout';
import { ValueChart } from '../components/charts/ValueChart';
import { AllocationDonut } from '../components/charts/AllocationDonut';
import { StaleBadge } from '../features/holdings/HoldingsTable';
import { WatchlistWidget } from '../features/watchlist/WatchlistWidget';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';
import { AnalyticsKpis } from '../features/analytics/AnalyticsKpis';
import { InsightsSection } from '../features/analytics/InsightsSection';
import { MoversSection } from '../features/analytics/MoversSection';
import { BASE_CURRENCY, formatDate, formatMoney, formatPercent, formatWeight } from '../lib/format';

type AllocationTab = Exclude<AllocationDimension, 'symbol'> | 'category';

const ALLOCATION_TABS: { value: AllocationTab; label: string }[] = [
  { value: 'assetClass', label: 'Asset class' },
  { value: 'sector', label: 'Sector' },
  { value: 'country', label: 'Country' },
  { value: 'currency', label: 'Currency' },
  { value: 'category', label: 'Category' },
];

const RANGE_OPTIONS = HISTORY_RANGES.map((r) => ({ value: r, label: r }));


function KpiGrid() {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending, isError, error, refetch } = usePortfolio(scope, { enabled: ready });
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load portfolio summary" />;
  const ccy = data?.baseCurrency ?? BASE_CURRENCY;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy={isPending || undefined}>
      <KpiCard
        loading={isPending}
        label="Total value"
        value={data && formatMoney(data.totalValue, ccy)}
        hint={data && `${data.holdingsCount} holdings · cost ${formatMoney(data.totalCost, ccy)}`}
      />
      <KpiCard
        loading={isPending}
        label="Day change"
        value={data && formatMoney(data.dayChange, ccy, { signed: true })}
        change={data && <Change pct={data.dayChangePct} value={data.dayChange} />}
      />
      <KpiCard
        loading={isPending}
        label="Unrealized P&L"
        value={data && formatMoney(data.unrealizedPnl, ccy, { signed: true })}
        change={data && <Change pct={data.unrealizedPnlPct} value={data.unrealizedPnl} />}
        hint={data && `Incl. ${formatMoney(data.currencyEffect, ccy, { signed: true })} currency effect`}
      />
      <KpiCard
        loading={isPending}
        label="Currency effect"
        value={data && <Change amount={data.currencyEffect} currency={ccy} />}
        hint={`Part of the unrealized P&L caused by exchange-rate moves since purchase — e.g. a weaker US dollar lowers the ${ccy} value of US shares. Already included in Unrealized P&L.`}
      />
      <KpiCard
        loading={isPending}
        label="Total return"
        value={data && formatMoney(data.totalReturn, ccy, { signed: true })}
        change={data && <Change pct={data.totalReturnPct} value={data.totalReturn} />}
        hint={data && `Incl. ${formatMoney(data.realizedPnl, ccy, { signed: true })} realized, ${formatMoney(data.dividendsReceived, ccy)} dividends`}
      />
      {data?.cashValue !== undefined && (
        <KpiCard label="Cash" value={formatMoney(data.cashValue, ccy)} hint={`Included in total value. Interest and fees: ${formatMoney(data.cashIncome ?? 0, ccy, { signed: true })}`} />
      )}
      {data?.customAssetsValue !== undefined && (
        <KpiCard label="Custom assets" value={formatMoney(data.customAssetsValue, ccy)} hint="Real estate, savings and other manually valued assets. Included in total value." />
      )}
      <KpiCard
        loading={isPending}
        label="Dividends received"
        value={data && formatMoney(data.dividendsReceived, ccy)}
        hint="Net of withholding tax, all time"
      />
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
  const asOf = formatDate(data.asOf, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${prefix} in ${data.baseCurrency} · as of ${asOf}`;
}

export function DashboardPage() {
  const { scope, ready, scopeName, withScope, current } = usePortfolioScope();
  const portfolio = usePortfolio(scope, { enabled: ready });
  const isEmpty = portfolio.data?.holdingsCount === 0 && portfolio.data.totalReturn === 0;

  return (
    <>
      <PageHeader title="Dashboard" description={dashboardDescription(portfolio.data, scopeName)} />
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
          <KpiGrid />
          <AnalyticsKpis />
          <InsightsSection />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <PerformanceCard />
            <AllocationCard />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TopHoldingsCard />
            <WatchlistWidget />
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
