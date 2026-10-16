import { useState } from 'react';
import { DEFAULT_GROWTH_RANGE, type AnalyticsHoldingsPerformanceResponse, type GrowthRange, type HoldingPerformanceRow } from '@portfolio/shared';
import { useHoldingsPerformance } from '../../api/growthHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { LegendSwatch, NothingSelected, SelectableLegend, SelectableTable, selectRows, useSeriesSelection, type SelectableColumn } from '../../components/charts/selection';
import { useTheme } from '../../theme/ThemeProvider';
import { formatDate, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { PanelHeader } from '../analytics/TableShell';
import { HoldingsChart } from './HoldingsChart';
import { InfoNote } from './InfoNote';
import { RangeButtons } from './RangeButtons';
import { arrowOf } from './growthFormat';

type View = 'bars' | 'table';
const VIEWS = [
  { value: 'bars', label: 'Bars' },
  { value: 'table', label: 'Table' },
] as const;

const HOLDINGS_COLUMNS: SelectableColumn[] = [
  { key: 'name', label: 'Name', selectable: false },
  { key: 'returnPct', label: 'Return' },
  { key: 'gain', label: 'Return (€)', selectable: false },
  { key: 'from', label: 'Measured from', selectable: false },
];

/** Text alternative of the bars: best and worst of the holdings that are drawn. */
export function holdingsSummary(rows: readonly HoldingPerformanceRow[], hasHidden: boolean): string {
  const best = rows[0];
  const worst = rows.at(-1);
  if (!best || !worst) return 'No holdings selected.';
  const describe = (h: HoldingPerformanceRow) => `${h.symbol} ${arrowOf(h.returnPct)} ${formatPercent(h.returnPct, { signed: true })}`;
  const selection = hasHidden ? ', current selection' : '';
  return `Return per holding over the selected range, ${rows.length} holdings${selection}. Best ${describe(best)}, worst ${describe(worst)}.`;
}

function HoldingsBody({ data, view }: Readonly<{ data: AnalyticsHoldingsPerformanceResponse; view: View }>) {
  const { theme } = useTheme();
  const selection = useSeriesSelection(
    ['returnPct'],
    data.holdings.map((h) => h.symbol),
  );
  const shown = selectRows(data.holdings, (h) => h.symbol, selection);
  const rows = data.holdings.map((h) => ({
    id: h.symbol,
    header: h.symbol,
    cells: [
      <span key="name" className="muted">
        {h.name}
      </span>,
      <Change key="pct" pct={h.returnPct} />,
      <Change key="gain" amount={h.gain} currency={data.baseCurrency} />,
      <span key="from">
        {formatDate(h.from)}
        {h.sincePurchase && <span title="Bought inside this range"> *</span>}
      </span>,
    ],
  }));
  let content = <HoldingsChart rows={shown} summary={holdingsSummary(shown, selection.hasHidden)} />;
  if (view === 'table') content = <SelectableTable caption="Return per holding, best first" rowHeader="Symbol" columns={HOLDINGS_COLUMNS} rows={rows} selection={selection} />;
  else if (selection.nothingSelected) content = <NothingSelected onShowAll={selection.reset} />;
  return (
    <>
      <SelectableLegend
        entries={[{ key: 'returnPct', label: 'Return per holding', swatch: <LegendSwatch color={analyticsTheme(theme).gain} /> }]}
        selection={selection}
        label="Holdings performance series"
        testId="growth-holdings-legend"
      />
      {content}
    </>
  );
}

function HoldingsContent({ data, view }: Readonly<{ data: AnalyticsHoldingsPerformanceResponse; view: View }>) {
  if (data.holdings.length === 0) return <p className="muted py-8 text-center text-sm">No open positions with a return in this range yet.</p>;
  return <HoldingsBody data={data} view={view} />;
}

/** Card 5: return of each open holding over the chosen range, as bars or a table. */
export function HoldingsCard() {
  const [range, setRange] = useState<GrowthRange>(DEFAULT_GROWTH_RANGE);
  const [view, setView] = useState<View>('bars');
  const { scope, ready } = usePortfolioScope();
  const query = useHoldingsPerformance(scope, range, { enabled: ready });
  return (
    <section aria-labelledby="growth-holdings-title" className="card p-4">
      <PanelHeader
        id="growth-holdings-title"
        title="Holdings performance"
        controls={
          <>
            <SegmentedControl label="Holdings view" options={VIEWS} value={view} onChange={setView} />
            <RangeButtons label="Holdings range" value={range} onChange={setRange} />
          </>
        }
      />
      {query.data?.from && (
        <p className="muted mb-3 text-xs">
          {formatDate(query.data.from)} – {formatDate(query.data.to)} · open positions only
        </p>
      )}
      <QueryBoundary query={query} loadingLabel="Loading holdings performance" errorTitle="Could not load the holdings performance">
        {(data) => <HoldingsContent data={data} view={view} />}
      </QueryBoundary>
      <InfoNote summary="About these returns">
        <p>
          Each bar is the time-weighted return of one holding over the range, including dividends and without the effect of buying or selling more of it. A holding
          bought inside the range is measured from its first purchase (marked * in the table), not from the start of the range. Positions that are closed are not
          shown. Amounts are in euro at the daily ECB rate.
        </p>
      </InfoNote>
    </section>
  );
}
