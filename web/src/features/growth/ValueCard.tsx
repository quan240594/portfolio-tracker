import { useMemo, useState } from 'react';
import { DEFAULT_GROWTH_RANGE, downsampleEvenly, type AnalyticsGrowthResponse, type GrowthPeriod, type GrowthRange } from '@portfolio/shared';
import { useGrowth } from '../../api/growthHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useTheme, type Theme } from '../../theme/ThemeProvider';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { formatDate, formatMoney } from '../../lib/format';
import { SelectableTable, useSeriesSelection } from '../../components/charts/selection';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { PanelHeader } from '../analytics/TableShell';
import { GrowthChart } from './GrowthChart';
import { SelectableChartOrTable } from './ChartOrTable';
import { InfoNote } from './InfoNote';
import { RangeButtons } from './RangeButtons';
import { TABLE_ROWS, availableBenchmarks, benchmarkColors, firstBenchmarkValue, growthRows, headlineText, lastBenchmarkValue, valueKey } from './growthFormat';
import { legendEntries, selectionSummary, seriesKeys, shownLabels, useVisibleBenchmarks, type LineSeries } from './growthSelection';

export const NO_TRANSACTIONS_TEXT = 'Add transactions to see how your portfolio grows.';

function Headline({ data }: Readonly<{ data: AnalyticsGrowthResponse }>) {
  let text = 'No benchmark comparison is available for this period.';
  if (data.headline) text = headlineText(data.headline, data.baseCurrency);
  else if (data.benchmarks.length === 0) text = 'Select a benchmark above to compare your portfolio with.';
  return <p className="mb-3 text-base font-medium">{text}</p>;
}

function PeriodLine({ period, currency }: Readonly<{ period: GrowthPeriod; currency: string }>) {
  return (
    <p className="muted mb-3 text-xs">
      {formatDate(period.from)} – {formatDate(period.to)} · Gain <Change amount={period.gain} pct={period.returnPct} currency={currency} className="text-xs" />
    </p>
  );
}

/** Series of the value chart: portfolio, invested and one per benchmark (colour by the benchmark's index, so it never shifts). */
export function valueSeries(data: AnalyticsGrowthResponse, period: GrowthPeriod, theme: Theme): LineSeries[] {
  const c = data.baseCurrency;
  const colors = benchmarkColors(theme);
  const t = analyticsTheme(theme);
  return [
    { key: 'portfolio', color: t.value, label: 'Portfolio', detail: `${formatMoney(period.startValue, c)} → ${formatMoney(period.endValue, c)}` },
    { key: 'invested', color: t.invested, label: 'Invested', detail: formatMoney(period.invested, c), dashed: true },
    ...availableBenchmarks(data).map(({ symbol, index }) => {
      const b = data.benchmarks[index]!;
      const detail = `${formatMoney(firstBenchmarkValue(b, 'value') ?? 0, c)} → ${formatMoney(lastBenchmarkValue(b, 'value') ?? 0, c)}`;
      return { key: symbol, color: colors[index % colors.length]!, label: symbol, detail };
    }),
  ];
}

function ValueChartBlock({ data, period }: Readonly<{ data: AnalyticsGrowthResponse; period: GrowthPeriod }>) {
  const { theme } = useTheme();
  const c = data.baseCurrency;
  const rows = useMemo(() => growthRows(data), [data]);
  const bench = useMemo(() => availableBenchmarks(data), [data]);
  const series = valueSeries(data, period, theme);
  const selection = useSeriesSelection(seriesKeys(series));
  const shown = useVisibleBenchmarks(bench, selection);
  const span = `from ${formatDate(period.from)} to ${formatDate(period.to)}`;
  const compared = bench.length > 0 ? `, compared with ${bench.map((b) => b.symbol).join(', ')} replayed with the same cash flows` : '';
  const whole = `Portfolio value ${span}: ${formatMoney(period.startValue, c)} to ${formatMoney(period.endValue, c)}, invested ${formatMoney(period.invested, c)}${compared}.`;
  const summary = selection.hasHidden ? selectionSummary('Portfolio value', span, shownLabels(series, selection)) : whole;
  const columns = series.map(({ key, label }) => ({ key, label }));
  const tableRows = useMemo(
    () =>
      downsampleEvenly(rows, TABLE_ROWS).map((r) => ({
        id: String(r.date),
        header: formatDate(String(r.date)),
        selectable: false,
        cells: [formatMoney(Number(r.value), c), formatMoney(Number(r.invested), c), ...bench.map((b) => formatMoney(Number(r[valueKey(b.index)]), c))],
      })),
    [rows, bench, c],
  );
  return (
    <SelectableChartOrTable
      id="growth-value-body"
      entries={legendEntries(series)}
      selection={selection}
      legendTestId="growth-value-legend"
      legendLabel="Portfolio value series"
      chart={
        <GrowthChart
          rows={rows}
          benchmarks={shown}
          showPortfolio={selection.isSeriesVisible('portfolio')}
          showInvested={selection.isSeriesVisible('invested')}
          focusKey={selection.focusKey}
          kind="value"
          currency={c}
          summary={summary}
          testId="growth-value-chart"
        />
      }
      table={<SelectableTable caption="Portfolio value over time" rowHeader="Date" columns={columns} rows={tableRows} selection={selection} />}
    />
  );
}

function ValueContent({ data }: Readonly<{ data: AnalyticsGrowthResponse }>) {
  const { period } = data;
  if (!period) return <p className="muted py-8 text-center text-sm">{NO_TRANSACTIONS_TEXT}</p>;
  return (
    <div>
      <Headline data={data} />
      <PeriodLine period={period} currency={data.baseCurrency} />
      <ValueChartBlock data={data} period={period} />
      <InfoNote>
        <p>
          Portfolio is the market value of your current and past holdings plus the dividends received since the start of the period. Invested is the value at the
          start plus what you bought minus what you sold since (your own deposits and withdrawals are not part of this).
        </p>
        <p>
          Each benchmark is replayed with identical cash flows: the starting value goes into the benchmark on day one, and every later purchase or sale buys or
          sells the benchmark on the same day. The benchmark shows its price only (no dividends). Foreign-currency holdings are converted at the daily ECB
          rate; transactions at the rate of the transaction.
        </p>
      </InfoNote>
    </div>
  );
}

/** Card 2: portfolio value with the cost basis and the benchmarks replayed with the same cash flows. */
export function ValueCard({ benchmarks }: Readonly<{ benchmarks: readonly string[] }>) {
  const [range, setRange] = useState<GrowthRange>(DEFAULT_GROWTH_RANGE);
  const { scope, ready } = usePortfolioScope();
  const query = useGrowth(scope, range, benchmarks, { enabled: ready });
  return (
    <section aria-labelledby="growth-value-title" className="card p-4">
      <PanelHeader id="growth-value-title" title="Portfolio value" controls={<RangeButtons label="Portfolio value range" value={range} onChange={setRange} />} />
      <QueryBoundary query={query} loadingLabel="Loading portfolio value" errorTitle="Could not load the portfolio value">
        {(data) => <ValueContent data={data} />}
      </QueryBoundary>
    </section>
  );
}
