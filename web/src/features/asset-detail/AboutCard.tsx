import { useState } from 'react';
import type { AssetDetailResponse } from '@portfolio/shared';
import { ASSET_CLASS_LABELS } from '../assets/AssetDialog';
import { EditClassificationDialog } from '../classification/EditClassificationDialog';
import { useAssetClassification } from '../classification/useAssetClassification';
import { Figure } from './StatsSidebar';

function Fact({ label, children }: Readonly<{ label: string; children: string | null }>) {
  return (
    <div className="min-w-0">
      <dt className="muted text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">
        <Figure>{children}</Figure>
      </dd>
    </div>
  );
}

/** "About the company": identifiers, class, country, sector and the description when a provider supplied one; the classification can be edited. */
export function AboutCard({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { profile, instrument, edited, ready } = useAssetClassification(detail.profile);
  const [editing, setEditing] = useState(false);
  return (
    <section aria-labelledby="asset-about-title" className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="asset-about-title" className="text-lg font-semibold">
          About {profile.name}
        </h2>
        {ready && (
          <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
            Edit classification
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <Fact label="Ticker">{profile.symbol}</Fact>
        <Fact label="ISIN">{profile.isin}</Fact>
        <Fact label="Exchange">{profile.exchange}</Fact>
        <Fact label="Asset class">{ASSET_CLASS_LABELS[profile.assetClass]}</Fact>
        <Fact label="Country">{profile.country}</Fact>
        <Fact label="Sector">{profile.sector}</Fact>
        <Fact label="Currency">{profile.currency}</Fact>
      </dl>
      {edited && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700 dark:bg-brand-600/20 dark:text-brand-100">Edited by you</span>
          <span className="muted">Name, class, sector or country above are your own values, not the provider&apos;s.</span>
        </p>
      )}
      <p className="mt-4 max-w-prose text-sm leading-relaxed">
        {profile.description ?? 'No description is available for this security from our data sources.'}
      </p>
      {editing && <EditClassificationDialog instrument={instrument} onClose={() => setEditing(false)} />}
    </section>
  );
}
