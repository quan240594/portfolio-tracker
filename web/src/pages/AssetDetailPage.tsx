import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAssetDetail, useAssetPositions } from '../api/assetHooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { SegmentedControl } from '../components/SegmentedControl';
import { AssetHeader } from '../features/asset-detail/AssetHeader';
import { DividendsTab } from '../features/asset-detail/DividendsTab';
import { OverviewTab } from '../features/asset-detail/OverviewTab';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';

export const ASSET_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'dividends', label: 'Dividends' },
] as const;
export type AssetTab = (typeof ASSET_TABS)[number]['value'];

export const TAB_PARAM = 'tab';
const PANEL_ID = 'asset-panel';
const ID_PREFIX = 'asset-tab';

export const isAssetTab = (v: string | null): v is AssetTab => ASSET_TABS.some((t) => t.value === v);

function AssetNotFound({ symbol }: Readonly<{ symbol: string }>) {
  const { withScope } = usePortfolioScope();
  return (
    <EmptyState
      title={`We have no data for ${symbol}`}
      description="The symbol is not tracked yet, or it does not exist. Add it to your watchlist or to a transaction and its prices show up after the next update."
      actions={
        <Link to={withScope('/assets')} className="btn-primary">
          Back to assets
        </Link>
      }
    />
  );
}

/** Detail of one security: header, Overview and Dividends tabs. Public data first, the user's own data follows the portfolio scope. */
export default function AssetDetailPage() {
  const symbol = (useParams().symbol ?? '').toUpperCase();
  const [params, setParams] = useSearchParams();
  const { scope, ready } = usePortfolioScope();
  const detail = useAssetDetail(symbol);
  const positions = useAssetPositions(scope, symbol, { enabled: ready });
  const requested = params.get(TAB_PARAM);
  const tab: AssetTab = isAssetTab(requested) ? requested : 'overview';

  const select = (next: AssetTab) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set(TAB_PARAM, next);
        return n;
      },
      { replace: true },
    );

  if (detail.isError) {
    return detail.error instanceof ApiError && detail.error.status === 404 ? <AssetNotFound symbol={symbol} /> : <ErrorState error={detail.error} onRetry={() => void detail.refetch()} title="Could not load this security" />;
  }
  if (detail.isPending) {
    return (
      <LoadingRegion label="Loading security">
        <Skeleton className="mb-5 h-40 w-full" />
        <Skeleton className="h-80 w-full" />
      </LoadingRegion>
    );
  }
  return (
    <>
      <AssetHeader detail={detail.data} />
      <div className="space-y-5">
        <div className="overflow-x-auto">
          <SegmentedControl variant="tabs" size="md" label="Security sections" options={ASSET_TABS} value={tab} onChange={select} panelId={PANEL_ID} idPrefix={ID_PREFIX} />
        </div>
        <div id={PANEL_ID} role="tabpanel" aria-labelledby={`${ID_PREFIX}-${tab}`}>
          {tab === 'overview' ? <OverviewTab detail={detail.data} positions={positions} /> : <DividendsTab detail={detail.data} positions={positions} />}
        </div>
      </div>
    </>
  );
}
