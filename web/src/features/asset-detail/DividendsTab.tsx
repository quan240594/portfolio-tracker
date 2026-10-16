import { useMemo, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AssetDetailResponse, AssetDividendYear, AssetPositionsResponse } from '@portfolio/shared';
import { QueryBoundary } from '../../components/QueryBoundary';
import { formatDate, formatMoney, formatPercent, formatQuantity } from '../../lib/format';
import { TableShell, numCell, rowClass } from '../analytics/TableShell';
import { ChartOrTable } from '../growth/ChartOrTable';
import { InfoNote } from '../growth/InfoNote';
import { useTheme } from '../../theme/ThemeProvider';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { LegendSwatch, NothingSelected, SelectableLegend, SelectableTable, useSeriesSelection } from '../../components/charts/selection';
import { DividendYearChart, dividendYearLabel, selectYears, yearId, yearKind, yearSeriesKeys, type YearKind } from './DividendYearChart';
import { uniqueKeys } from './assetFormat';
import { Figure } from './StatsSidebar';

function Kpi({ label, children }: Readonly<{ label: string; children: ReactNode | null }>) {
  return (
    <div className="card min-w-0 p-4">
      <dt className="muted text-xs">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">
        <Figure>{children}</Figure>
      </dd>
    </div>
  );
}

function Kpis({ detail, received }: Readonly<{ detail: AssetDetailResponse; received: AssetPositionsResponse | undefined }>) {
  const { stats, dividends, profile } = detail;
  const currency = dividends.currency ?? profile.currency;
  const total = received?.positions.reduce((sum, p) => sum + p.dividendsReceived, 0);
  return (
    <dl aria-label="Dividend figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="Dividend yield">{stats.dividendYieldPct === null ? null : formatPercent(stats.dividendYieldPct)}</Kpi>
      <Kpi label="Annual payout per share">{stats.annualDividend === null ? null : formatMoney(stats.annualDividend, currency, { maxDigits: 4 })}</Kpi>
      <Kpi label="Next ex-dividend date">{stats.nextExDate === null ? null : formatDate(stats.nextExDate)}</Kpi>
      <Kpi label="Received by you">{total === undefined ? null : formatMoney(total, received?.baseCurrency ?? 'EUR')}</Kpi>
    </dl>
  );
}

const YEAR_LABELS: Record<YearKind, string> = { complete: 'Full year', partial: 'Partial year' };

function YearChartBlock({ byYear, currency, symbol }: Readonly<{ byYear: readonly AssetDividendYear[]; currency: string; symbol: string }>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const kinds = yearSeriesKeys(byYear);
  const selection = useSeriesSelection(kinds, byYear.map(yearId));
  const { isRowVisible, isSeriesVisible } = selection;
  // memoised on the include/exclude state only, so a hover preview does not rebuild the chart data
  const shown = useMemo(() => selectYears(byYear, { isRowVisible, isSeriesVisible }), [byYear, isRowVisible, isSeriesVisible]);
  const swatches: Record<YearKind, string> = { complete: c.received, partial: c.upcoming };
  const entries = kinds.map((kind) => ({ key: kind, label: YEAR_LABELS[kind], swatch: <LegendSwatch color={swatches[kind]} /> }));
  const columns = [...kinds.map((kind) => ({ key: kind, label: YEAR_LABELS[kind] })), { key: 'payments', label: 'Payments', selectable: false }];
  const rows = byYear.map((y) => {
    const amount = formatMoney(y.perShare, currency, { maxDigits: 4 });
    return { id: yearId(y), header: String(y.year), cells: [...kinds.map((kind) => (yearKind(y) === kind ? amount : '—')), String(y.payments)] };
  });
  return (
    <>
      <SelectableLegend entries={entries} selection={selection} label="Dividend per year series" testId="asset-dividend-legend" />
      <ChartOrTable
        id="asset-div-year-body"
        chart={
          shown.length === 0 || selection.nothingSelected ? (
            <NothingSelected onShowAll={selection.reset} />
          ) : (
            <DividendYearChart
              byYear={shown}
              currency={currency}
              showComplete={selection.isSeriesVisible('complete')}
              showPartial={selection.isSeriesVisible('partial')}
              label={dividendYearLabel(shown, currency, symbol, selection.hasHidden)}
              focusKey={selection.focusKey}
            />
          )
        }
        table={<SelectableTable caption={`Dividend per share of ${symbol} per year`} rowHeader="Year" columns={columns} rows={rows} selection={selection} />}
      />
    </>
  );
}

function PerYear({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { dividends, profile } = detail;
  const currency = dividends.currency ?? profile.currency;
  return (
    <section aria-labelledby="asset-div-year-title" className="card p-4">
      <h2 id="asset-div-year-title" className="mb-3 font-semibold">
        Dividend per share per year
      </h2>
      {dividends.byYear.length === 0 ? (
        <p className="muted py-6 text-center text-sm">No dividends are stored for {profile.symbol}.</p>
      ) : (
        <>
          <YearChartBlock byYear={dividends.byYear} currency={currency} symbol={profile.symbol} />
          <InfoNote>
            <p>
              A year counts as partial while it is running, and for the first year we have stored when it holds fewer payments than the year after it
              (the stored history starts mid-year). Growth figures only use full years.
            </p>
          </InfoNote>
        </>
      )}
    </section>
  );
}

function History({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { dividends, profile } = detail;
  const currency = dividends.currency ?? profile.currency;
  return (
    <section aria-labelledby="asset-div-history-title" className="card min-w-0 p-4">
      <h2 id="asset-div-history-title" className="mb-3 font-semibold">
        Dividend history
      </h2>
      {dividends.events.length === 0 ? (
        <p className="muted text-sm">No dividend events are stored for {profile.symbol}. Accumulating funds, crypto and most growth stocks pay none.</p>
      ) : (
        <TableShell caption={`Dividend events of ${profile.symbol}, newest first`} columns={[{ label: 'Ex-dividend date' }, { label: 'Payment date' }, { label: 'Per share', align: 'right' }]}>
          {dividends.events.map((e) => (
            <tr key={e.exDate} className={rowClass}>
              <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">{formatDate(e.exDate)}</th>
              <td className="py-2 pr-3">{e.payDate ? formatDate(e.payDate) : '—'}</td>
              <td className={numCell}>{formatMoney(e.amount, currency, { maxDigits: 4 })}</td>
            </tr>
          ))}
        </TableShell>
      )}
    </section>
  );
}

function ReceivedTable({ data }: Readonly<{ data: AssetPositionsResponse }>) {
  const keys = uniqueKeys(data.received, (r) => [r.date, r.portfolioId, r.quantity, r.perShareLocal].join('-'));
  return (
    <TableShell
      caption="Dividends you received, newest first"
      columns={[{ label: 'Date' }, { label: 'Shares', align: 'right' }, { label: 'Per share', align: 'right' }, { label: `Net (${data.baseCurrency})`, align: 'right' }]}
    >
      {data.received.map((r, i) => (
        <tr key={keys[i]} className={rowClass}>
          <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">{formatDate(r.date)}</th>
          <td className={numCell}>{formatQuantity(r.quantity)}</td>
          <td className={numCell}>{formatMoney(r.perShareLocal, r.currency, { maxDigits: 4 })}</td>
          <td className={numCell}>{formatMoney(r.amount, data.baseCurrency)}</td>
        </tr>
      ))}
    </TableShell>
  );
}

function Received({ query }: Readonly<{ query: UseQueryResult<AssetPositionsResponse> }>) {
  return (
    <section aria-labelledby="asset-div-received-title" className="card min-w-0 p-4">
      <h2 id="asset-div-received-title" className="mb-3 font-semibold">
        Dividends you received
      </h2>
      <QueryBoundary query={query} loadingLabel="Loading your dividends" errorTitle="Could not load your dividends" skeletonClassName="h-24 w-full">
        {(data) => (data.received.length === 0 ? <p className="muted text-sm">No dividends received for this security in the selected portfolios.</p> : <ReceivedTable data={data} />)}
      </QueryBoundary>
    </section>
  );
}

/** Dividends tab: yield and payout, per-year chart, the stored dividend events and what the user received. */
export function DividendsTab({ detail, positions }: Readonly<{ detail: AssetDetailResponse; positions: UseQueryResult<AssetPositionsResponse> }>) {
  return (
    <div className="space-y-5">
      <Kpis detail={detail} received={positions.data} />
      <PerYear detail={detail} />
      <div className="grid gap-5 lg:grid-cols-2">
        <History detail={detail} />
        <Received query={positions} />
      </div>
    </div>
  );
}
