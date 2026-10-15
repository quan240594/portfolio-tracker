import { useState } from 'react';
import { DEFAULT_GROWTH_RANGE, type AnalyticsHoldingsPerformanceResponse, type GrowthRange } from '@portfolio/shared';
import { useHoldingsPerformance } from '../../api/growthHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { formatDate, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { PanelHeader, TableShell, numCell, rowClass } from '../analytics/TableShell';
import { HoldingsChart } from './HoldingsChart';
import { InfoNote } from './InfoNote';
import { RangeButtons } from './RangeButtons';
import { arrowOf } from './growthFormat';

type View = 'bars' | 'table';
const VIEWS = [
  { value: 'bars', label: 'Bars' },
  { value: 'table', label: 'Table' },
] as const;

const HOLDINGS_COLUMNS = [{ label: 'Symbol' }, { label: 'Name' }, { label: 'Return', align: 'right' as const }, { label: 'Return (€)', align: 'right' as const }, { label: 'Measured from', align: 'right' as const }];

function HoldingsTable({ data }: Readonly<{ data: AnalyticsHoldingsPerformanceResponse }>) {
  return (
    <TableShell caption="Return per holding, best first" columns={HOLDINGS_COLUMNS}>
      {data.holdings.map((h) => (
        <tr key={h.symbol} className={rowClass}>
          <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">
            {h.symbol}
          </th>
          <td className="muted max-w-48 truncate py-2 pr-3">{h.name}</td>
          <td className={numCell}>
            <Change pct={h.returnPct} />
          </td>
          <td className={numCell}>
            <Change amount={h.gain} currency={data.baseCurrency} />
          </td>
          <td className={numCell}>
            {formatDate(h.from)}
            {h.sincePurchase && <span title="Bought inside this range"> *</span>}
          </td>
        </tr>
      ))}
    </TableShell>
  );
}

function HoldingsContent({ data, view }: Readonly<{ data: AnalyticsHoldingsPerformanceResponse; view: View }>) {
  if (data.holdings.length === 0) return <p className="muted py-8 text-center text-sm">No open positions with a return in this range yet.</p>;
  const best = data.holdings[0]!;
  const worst = data.holdings.at(-1)!;
  const summary = `Return per holding over the selected range, ${data.holdings.length} holdings. Best ${best.symbol} ${arrowOf(best.returnPct)} ${formatPercent(best.returnPct, { signed: true })}, worst ${worst.symbol} ${arrowOf(worst.returnPct)} ${formatPercent(worst.returnPct, { signed: true })}.`;
  return view === 'bars' ? <HoldingsChart rows={data.holdings} summary={summary} /> : <HoldingsTable data={data} />;
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
