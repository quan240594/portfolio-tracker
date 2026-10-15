import { useState } from 'react';
import type { CustomAssetWithValue } from '@portfolio/shared';
import { errorMessage } from '../api/client';
import { useAssetMutations, useAssets } from '../api/management-hooks';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { PageHeader } from '../components/Layout';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { AssetDialog, ASSET_CLASS_LABELS } from '../features/assets/AssetDialog';
import { SecuritiesSection } from '../features/assets/SecuritiesSection';
import { ValuationsDialog } from '../features/assets/ValuationsDialog';
import { RequirePortfolio } from '../features/management/RequirePortfolio';
import { formatDate, formatMoney, formatPercent } from '../lib/format';

type Dialogs = { kind: 'edit'; asset: CustomAssetWithValue | null } | { kind: 'valuations'; asset: CustomAssetWithValue } | { kind: 'delete'; asset: CustomAssetWithValue };

function AssetCard({ asset, onAction }: Readonly<{ asset: CustomAssetWithValue; onAction: (d: Dialogs) => void }>) {
  const latest = asset.valuations.at(-1);
  return (
    <li className="card flex flex-wrap items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold">{asset.name}</h3>
        <p className="muted text-xs">
          {ASSET_CLASS_LABELS[asset.assetClass]} · {asset.currency}
          {asset.growthRate !== undefined && ` · grows ${formatPercent(asset.growthRate, { digits: 1 })} a year`}
          {latest && ` · last valuation ${formatDate(latest.date)}`}
        </p>
      </div>
      <div className="text-right">
        <p className="font-semibold tabular-nums">{formatMoney(asset.currentValue, 'EUR')}</p>
        {asset.currency !== 'EUR' && <p className="muted text-xs tabular-nums">{formatMoney(asset.currentValueLocal, asset.currency)}</p>}
        <p className="muted text-xs">Invested {formatMoney(asset.costBasis, asset.currency)}</p>
      </div>
      <div className="flex gap-1">
        <button type="button" className="btn-secondary" aria-label={`Valuations of ${asset.name}`} onClick={() => onAction({ kind: 'valuations', asset })}>Valuations</button>
        <button type="button" className="btn-secondary" aria-label={`Edit ${asset.name}`} onClick={() => onAction({ kind: 'edit', asset })}>Edit</button>
        <button type="button" className="btn-secondary text-red-600 dark:text-red-400" aria-label={`Delete ${asset.name}`} onClick={() => onAction({ kind: 'delete', asset })}>Delete</button>
      </div>
    </li>
  );
}

function Assets({ portfolioId }: Readonly<{ portfolioId: string }>) {
  const { data, isPending, isError, error, refetch } = useAssets(portfolioId);
  const { remove } = useAssetMutations(portfolioId);
  const [dialog, setDialog] = useState<Dialogs | null>(null);

  const addButton = <button type="button" className="btn-primary" onClick={() => setDialog({ kind: 'edit', asset: null })}>Add asset</button>;
  const confirmDelete = () => {
    if (dialog?.kind === 'delete') remove.mutate(dialog.asset.assetId, { onSuccess: () => setDialog(null) });
  };

  let body;
  if (isError) body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load assets" />;
  else if (isPending) {
    body = (
      <LoadingRegion label="Loading assets">
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  } else if (data.assets.length === 0) {
    body = <EmptyState title="No custom assets yet" description="Track real estate, savings accounts, P2P loans or private equity with a manual value." actions={addButton} />;
  } else {
    body = <ul className="space-y-3">{data.assets.map((a) => <AssetCard key={a.assetId} asset={a} onAction={setDialog} />)}</ul>;
  }

  return (
    <>
      {data && data.assets.length > 0 && <div className="mb-4 flex justify-end">{addButton}</div>}
      {body}
      {dialog?.kind === 'edit' && <AssetDialog portfolioId={portfolioId} asset={dialog.asset} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'valuations' && <ValuationsDialog portfolioId={portfolioId} asset={dialog.asset} onClose={() => setDialog(null)} />}
      <Dialog
        open={dialog?.kind === 'delete'}
        onClose={() => setDialog(null)}
        role="alertdialog"
        size="sm"
        title="Delete asset?"
        description={dialog?.kind === 'delete' && `“${dialog.asset.name}” and its valuations are removed from your totals.`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDialog(null)} data-autofocus>Cancel</button>
            <button type="button" className="btn-danger" onClick={confirmDelete} disabled={remove.isPending}>{remove.isPending ? 'Deleting…' : 'Delete'}</button>
          </>
        }
      >
        {remove.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{errorMessage(remove.error)}</p>}
      </Dialog>
    </>
  );
}

export function AssetsPage() {
  return (
    <>
      <PageHeader title="Assets" description="The securities you hold, plus real estate, savings, P2P loans and private equity that you value by hand." />
      <SecuritiesSection />
      <section aria-labelledby="custom-assets-title">
        <h2 id="custom-assets-title" className="mb-1 text-lg font-semibold">
          Custom assets
        </h2>
        <p className="muted mb-4 text-sm">Manual values, included in your totals and allocation.</p>
        <RequirePortfolio what="Custom assets">{({ portfolioId }) => <Assets portfolioId={portfolioId} />}</RequirePortfolio>
      </section>
    </>
  );
}
