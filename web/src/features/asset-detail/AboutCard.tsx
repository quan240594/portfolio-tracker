import type { AssetDetailResponse } from '@portfolio/shared';
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

/** "About the company": identifiers, country, sector and the description when a provider supplied one. */
export function AboutCard({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { profile } = detail;
  return (
    <section aria-labelledby="asset-about-title" className="card p-4 sm:p-5">
      <h2 id="asset-about-title" className="mb-3 text-lg font-semibold">
        About {profile.name}
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Ticker">{profile.symbol}</Fact>
        <Fact label="ISIN">{profile.isin}</Fact>
        <Fact label="Exchange">{profile.exchange}</Fact>
        <Fact label="Country">{profile.country}</Fact>
        <Fact label="Sector">{profile.sector}</Fact>
        <Fact label="Currency">{profile.currency}</Fact>
      </dl>
      <p className="mt-4 max-w-prose text-sm leading-relaxed">
        {profile.description ?? 'No description is available for this security from our data sources.'}
      </p>
    </section>
  );
}
