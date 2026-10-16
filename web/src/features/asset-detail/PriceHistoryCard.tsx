import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AssetHistoryResponse, AssetMarker, GrowthRange } from '@portfolio/shared';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { formatDate, formatMoney, formatPercent, formatQuantity } from '../../lib/format';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { SelectableTable, useSeriesSelection } from '../../components/charts/selection';
import { PanelHeader, TableShell, numCell, rowClass } from '../analytics/TableShell';
import { SelectableChartOrTable } from '../growth/ChartOrTable';
import { InfoNote } from '../growth/InfoNote';
import { RangeButtons } from '../growth/RangeButtons';
import { benchmarkColors } from '../growth/growthFormat';
import { legendEntries, seriesKeys, shownLabels, visibleBenchmarks, type LineSeries } from '../growth/growthSelection';
import { PriceChart } from './PriceChart';
import { PRICE_KEY, availableBenchmarks, chartRows, chartSelectionSummary, chartSummary, plottedMarkers, selectableChartTable, type ChartMode } from './assetChartData';
import { MARKER_LABELS, uniqueKeys } from './assetFormat';

const MODE_OPTIONS = [
  { value: 'performance', label: 'Performance %' },
  { value: 'price', label: 'Price' },
] as const;

const TABLE_ROWS = 24;

function MarkerLegend() {
  return (
    <ul aria-label="Trade markers" className="muted mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      <li><span aria-hidden="true" className="gain-text">▲</span> Buy</li>
      <li><span aria-hidden="true" className="loss-text">▼</span> Sell</li>
      <li><span aria-hidden="true" className="text-amber-600 dark:text-amber-400">◆</span> Dividend received</li>
    </ul>
  );
}

function TradesTable({ markers, currency, baseCurrency }: Readonly<{ markers: readonly AssetMarker[]; currency: string; baseCurrency: string }>) {
  const keys = uniqueKeys(markers, (m) => [m.date, m.type, m.portfolioId, m.quantity, m.price].join('-'));
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer font-medium select-none">Your transactions in this period ({markers.length})</summary>
      <div className="mt-2">
        <TableShell
          caption="Your transactions of this security in the selected period"
          columns={[{ label: 'Date' }, { label: 'Type' }, { label: 'Quantity', align: 'right' }, { label: `Price (${currency})`, align: 'right' }, { label: `Amount (${baseCurrency})`, align: 'right' }]}
        >
          {markers.map((m, i) => (
            <tr key={keys[i]} className={rowClass}>
              <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">{formatDate(m.date)}</th>
              <td className="py-2 pr-3">{MARKER_LABELS[m.type]}</td>
              <td className={numCell}>{formatQuantity(m.quantity)}</td>
              <td className={numCell}>{formatMoney(m.price, currency, { maxDigits: 4 })}</td>
              <td className={numCell}>{formatMoney(m.amountBase, baseCurrency)}</td>
            </tr>
          ))}
        </TableShell>
      </div>
    </details>
  );
}

/** Series of the chart: the security itself and, in the performance view, one line per benchmark (colour by the benchmark's index). */
export function priceSeries(data: AssetHistoryResponse, mode: ChartMode, theme: Theme): LineSeries[] {
  const last = data.points.at(-1);
  const colors = benchmarkColors(theme);
  const bench = mode === 'performance' ? availableBenchmarks(data) : [];
  return [
    { key: PRICE_KEY, color: analyticsTheme(theme).value, label: data.symbol, detail: last ? formatPercent(last.pct, { signed: true }) : undefined },
    ...bench.map(({ symbol, index }) => ({
      key: symbol,
      color: colors[index % colors.length]!,
      label: symbol,
      detail: formatPercent(data.benchmarks[index]!.points.at(-1)?.returnPct ?? 0, { signed: true }),
    })),
  ];
}

function HistoryNotes({ data, mode }: Readonly<{ data: AssetHistoryResponse; mode: ChartMode }>) {
  const missing = mode === 'performance' ? data.benchmarks.filter((b) => !b.available).map((b) => b.symbol) : [];
  return (
    <>
      {data.coverage.limited && data.coverage.from && (
        <p className="muted mb-3 text-xs">Prices are stored from {formatDate(data.coverage.from)}, so this period is shorter than selected.</p>
      )}
      {missing.length > 0 && <p className="muted mt-2 text-xs">No prices are tracked for {missing.join(', ')}, so {missing.length === 1 ? 'it is' : 'they are'} left out.</p>}
      {mode === 'price' && data.benchmarks.length > 0 && <p className="muted mt-2 text-xs">Benchmarks are shown in the Performance % view, where all lines share one scale.</p>}
    </>
  );
}

function HistoryBody({ data, mode }: Readonly<{ data: AssetHistoryResponse; mode: ChartMode }>) {
  const { theme } = useTheme();
  const rows = chartRows(data, mode);
  const bench = mode === 'performance' ? availableBenchmarks(data) : [];
  const series = priceSeries(data, mode, theme);
  const selection = useSeriesSelection(seriesKeys(series));
  const showPrice = selection.isSeriesVisible(PRICE_KEY);
  const table = selectableChartTable(data, mode, TABLE_ROWS);
  const what = mode === 'price' ? 'closing prices' : 'price change';
  const summary = selection.hasHidden ? chartSelectionSummary(data, mode, shownLabels(series, selection)) : chartSummary(data, mode);
  const hasMarkers = data.markers.length > 0;
  return (
    <>
      <SelectableChartOrTable
        id="asset-price-body"
        entries={legendEntries(series)}
        selection={selection}
        legendTestId="asset-price-legend"
        legendLabel="Price history series"
        chart={
          <PriceChart
            rows={rows}
            mode={mode}
            benchmarks={visibleBenchmarks(bench, selection)}
            showPrice={showPrice}
            markers={plottedMarkers(data, rows)}
            currency={data.currency}
            summary={summary}
            symbol={data.symbol}
          />
        }
        table={<SelectableTable caption={`${data.symbol} ${what} over time`} rowHeader="Date" columns={table.columns} rows={table.rows} selection={selection} />}
      />
      <HistoryNotes data={data} mode={mode} />
      {hasMarkers && showPrice && <MarkerLegend />}
      {hasMarkers && <TradesTable markers={data.markers} currency={data.currency} baseCurrency={data.baseCurrency} />}
      <InfoNote>
        <p>
          Prices are end-of-day closes in {data.currency}, the currency the security trades in. Performance % is the price change since the first day of the
          period, rebased to 0%; dividends are not included. Benchmarks are rebased the same way, so the lines are comparable even when they trade in
          different currencies.
        </p>
        <p>The markers show your own buys, sells and dividends of this security in the selected portfolio scope.</p>
      </InfoNote>
    </>
  );
}

function HistoryContent({ data, mode }: Readonly<{ data: AssetHistoryResponse; mode: ChartMode }>) {
  if (data.points.length === 0) return <p className="muted py-8 text-center text-sm">No price history is stored for {data.symbol} in this period.</p>;
  return (
    <div>
      <HistoryBody data={data} mode={mode} />
    </div>
  );
}

interface Props {
  query: UseQueryResult<AssetHistoryResponse>;
  range: GrowthRange;
  onRangeChange: (range: GrowthRange) => void;
}

/** "Price history": range buttons, performance/price toggle, the chart with benchmarks and the user's trades. */
export function PriceHistoryCard({ query, range, onRangeChange }: Readonly<Props>) {
  const [mode, setMode] = useState<ChartMode>('performance');
  return (
    <section aria-labelledby="asset-history-title" className="card min-w-0 p-4">
      <PanelHeader
        id="asset-history-title"
        title="Price history"
        controls={
          <>
            <SegmentedControl label="Chart type" options={MODE_OPTIONS} value={mode} onChange={setMode} />
            <RangeButtons label="Price history range" value={range} onChange={onRangeChange} />
          </>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading price history" errorTitle="Could not load the price history">
        {(data) => <HistoryContent data={data} mode={mode} />}
      </QueryBoundary>
    </section>
  );
}
