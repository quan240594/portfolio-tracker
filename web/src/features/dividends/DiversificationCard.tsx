import type { DividendsOverviewResponse } from '@portfolio/shared';
import { LegendSwatch, NothingSelected, SelectableDataTable, SelectableLegend, useSliceSelection, visibleSliceTotal, visibleSlices } from '../../components/charts/selection';
import { SERIES_COLORS } from '../../components/charts/palette';
import { formatMoney, formatWeight } from '../../lib/format';
import { Donut } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { incomeSlices, topSlices, type Slice } from './slices';
import { useScopedDividendsOverview } from './useDividendsOverview';

const OTHER_COLOR = '#94a3b8';
const OTHER_KEY = '__other';

type IncomeSlice = Slice & { color: string };

/** Legend text: the ticker keeps the entries short. */
const legendLabel = (s: IncomeSlice): string => (s.key === OTHER_KEY ? s.label : (s.detail ?? s.label));

/** An excluded slice has no share. */
const formatShare = (share: number | undefined): string => (share === undefined ? '—' : formatWeight(share));

/** The share and amount columns describe the slice, they are not series of their own: only the rows (slices) toggle. */
const TABLE_COLUMNS = [
  { key: 'share', label: 'Share', selectable: false },
  { key: 'amount', label: 'Per year', selectable: false },
];

/** Donut, ranked list, legend and table of one set of slices. A slice is a legend entry AND a table row; the shares are recomputed over the slices that are not excluded. */
function IncomeBody({ slices, currency }: Readonly<{ slices: readonly IncomeSlice[]; currency: string }>) {
  const selection = useSliceSelection(slices.map((s) => s.key));
  const shown = visibleSlices(slices, selection);
  const shownTotal = visibleSliceTotal(slices, selection);
  const shareOf = new Map(shown.map((s) => [s.key, s.share]));
  const summary = shown.map((s) => `${s.label} ${formatWeight(s.share)}`).join(', ');
  const label = `Share of forward annual dividend income by holding: ${summary}.`;
  const centre = (
    <>
      <span className="font-semibold tabular-nums">{formatMoney(shownTotal, currency)}</span>
      <span className="muted">per year</span>
    </>
  );
  return (
    <>
      <SelectableLegend
        label="Holdings"
        testId="income-legend"
        selection={selection}
        entries={slices.map((s) => ({ key: s.key, label: legendLabel(s), swatch: <LegendSwatch color={s.color} /> }))}
      />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
          <Donut slices={shown} label={label} testId="income-donut" centre={centre} />
          <ol className="min-w-0 space-y-3" aria-label="Holdings ranked by expected annual income">
            {shown.map((s) => (
              <li key={s.key} className="text-sm">
                <div className="flex items-baseline gap-2">
                  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 self-center rounded-sm" style={{ background: s.color }} />
                  <span className="truncate font-medium">{s.label}</span>
                  {s.detail && <span className="muted text-xs">{s.detail}</span>}
                  <span className="ml-auto w-14 text-right font-medium tabular-nums">{formatWeight(s.share)}</span>
                  <span className="muted w-24 text-right tabular-nums">{formatMoney(s.value, currency)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(s.share * 100, 1)}%`, background: s.color }} />
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      <SelectableDataTable
        caption="Forward annual dividend income by holding"
        rowHeader="Holding"
        columns={TABLE_COLUMNS}
        selection={selection}
        rows={slices.map((s) => ({
          id: s.key,
          header: s.label,
          cells: [formatShare(shareOf.get(s.key)), formatMoney(s.value, currency)],
        }))}
      />
    </>
  );
}

function Diversification({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const all = incomeSlices(data.holdings);
  if (all.length === 0) return <EmptyNote>No expected dividend income to divide yet.</EmptyNote>;
  const slices = topSlices(all).map((s, i) => ({ ...s, color: s.key === OTHER_KEY ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length]! }));
  return <IncomeBody slices={slices} currency={data.baseCurrency} />;
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
          <p>Click a holding in the legend (or its name in the data table) to leave it out: the shares and the total in the middle are then recalculated over the holdings that remain.</p>
        </>
      }
    >
      {(data) => <Diversification data={data} />}
    </QueryCard>
  );
}
