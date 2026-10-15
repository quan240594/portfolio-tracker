import type { DividendsOverviewResponse } from '@portfolio/shared';
import { SERIES_COLORS } from '../../components/charts/palette';
import { formatMoney, formatWeight } from '../../lib/format';
import { ChartDataTable, Donut } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { incomeSlices, topSlices } from './slices';
import { useScopedDividendsOverview } from './useDividendsOverview';

const OTHER_COLOR = '#94a3b8';

function Diversification({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const all = incomeSlices(data.holdings);
  if (all.length === 0) return <EmptyNote>No expected dividend income to divide yet.</EmptyNote>;
  const total = all.reduce((s, x) => s + x.value, 0);
  const slices = topSlices(all).map((s, i) => ({ ...s, color: s.key === '__other' ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length]!, share: s.value / total }));
  const label = `Share of forward annual dividend income by holding: ${slices.map((s) => `${s.label} ${formatWeight(s.share)}`).join(', ')}.`;
  return (
    <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <Donut slices={slices} label={label} testId="income-donut" />
      <div className="min-w-0">
        <ol className="space-y-3" aria-label="Holdings ranked by expected annual income">
          {slices.map((s) => (
            <li key={s.key} className="text-sm">
              <div className="flex items-baseline gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 self-center rounded-sm" style={{ background: s.color }} />
                <span className="truncate font-medium">{s.label}</span>
                {s.detail && <span className="muted text-xs">{s.detail}</span>}
                <span className="ml-auto w-14 text-right font-medium tabular-nums">{formatWeight(s.share)}</span>
                <span className="muted w-24 text-right tabular-nums">{formatMoney(s.value, data.baseCurrency)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${Math.max(s.share * 100, 1)}%`, background: s.color }} />
              </div>
            </li>
          ))}
        </ol>
        <ChartDataTable
          caption="Forward annual dividend income by holding"
          columns={['Holding', 'Share', 'Per year']}
          rows={slices.map((s) => [s.label, formatWeight(s.share), formatMoney(s.value, data.baseCurrency)])}
        />
      </div>
    </div>
  );
}

export function DiversificationCard() {
  const query = useScopedDividendsOverview();
  return (
    <QueryCard
      id="div-diversification"
      title="Passive income diversification"
      query={query}
      loadingLabel="Loading income diversification"
      errorTitle="Could not load income diversification"
      skeletonClassName="h-56 w-full"
      info={
        <>
          <p>How your expected dividend income over the next 12 months is spread over your holdings: the eight largest, the rest as &quot;Other&quot;.</p>
          <p>Income is net of withholding tax and consists of declared dividends plus estimates based on each holding&apos;s payment frequency.</p>
        </>
      }
    >
      {(data) => <Diversification data={data} />}
    </QueryCard>
  );
}
