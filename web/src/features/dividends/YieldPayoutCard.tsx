import { useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis, ResponsiveContainer } from 'recharts';
import type { DividendsOverviewResponse } from '@portfolio/shared';
import { useCategories } from '../../api/management-hooks';
import { SegmentedControl } from '../../components/SegmentedControl';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import {
  LegendSwatch,
  NothingSelected,
  SelectableDataTable,
  SelectableLegend,
  focusOpacity,
  selectRows,
  useSeriesSelection,
  type LegendEntry,
  type SelectableColumn,
  type SeriesSelection,
} from '../../components/charts/selection';
import { ChartFrame, useDividendTheme } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { yieldBars, type YieldBar, type YieldGroup, type YieldMetric } from './slices';
import { useScopedDividendsOverview } from './useDividendsOverview';

const METRICS = [
  { value: 'yield', label: 'Yield (%)' },
  { value: 'amount', label: 'Amount (EUR)' },
] as const;
const GROUPS = [
  { value: 'holding', label: 'Holdings' },
  { value: 'category', label: 'Categories' },
] as const;

const seriesName = (name: unknown, isYield: boolean): string => {
  if (name === 'onCostPct') return 'Yield on cost';
  return isYield ? 'Yield on value' : 'Amount per year';
};

/** Series of the chart: the bars (yield or amount, per the selected metric) and, for the yield, the dots of the yield on cost. */
const YIELD_SERIES = ['yield', 'onCost'];
const AMOUNT_SERIES = ['amount'];

interface ChartProps {
  bars: readonly YieldBar[];
  metric: YieldMetric;
  currency: string;
  selection: SeriesSelection;
}

function YieldPayoutChart({ bars, metric, currency, selection }: Readonly<ChartProps>) {
  const c = useDividendTheme();
  const isYield = metric === 'yield';
  const barKey = isYield ? 'yield' : 'amount';
  const showBar = selection.isSeriesVisible(barKey);
  const showDots = isYield && selection.isSeriesVisible('onCost');
  const barOpacity = focusOpacity(selection.focusKey, barKey);
  const dotOpacity = focusOpacity(selection.focusKey, 'onCost');
  const shown = selectRows(bars, (b) => b.key, selection);
  const fmt = (v: number) => (isYield ? formatPercent(v) : formatMoney(v, currency));
  const summary = shown.map((b) => `${b.label} ${fmt(isYield ? b.yieldPct : b.amount)}`).join(', ');
  const label = `${isYield ? 'Dividend yield' : 'Forward annual dividend amount'} per ${shown.length} bars, highest first: ${summary}.`;
  const entries: LegendEntry[] = [{ key: barKey, label: seriesName('bar', isYield), swatch: <LegendSwatch color={c.value} /> }];
  if (isYield) entries.push({ key: 'onCost', label: seriesName('onCostPct', isYield), swatch: <LegendSwatch shape="dot" color={c.benchmark} /> });
  const columns: SelectableColumn[] = [
    { key: 'yield', label: 'Yield', selectable: isYield },
    { key: 'onCost', label: 'Yield on cost', selectable: isYield },
    { key: 'amount', label: 'Per year', selectable: !isYield },
  ];
  return (
    <>
      <SelectableLegend entries={entries} selection={selection} testId="yield-payout-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <ChartFrame label={label} testId="yield-payout-chart" bars={shown.length}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={shown as YieldBar[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
              <YAxis
                tickFormatter={isYield ? (v: number) => formatPercent(v, { digits: 1 }) : compactMoneyTick(currency)}
                stroke={c.axis}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={56}
              />
              <Tooltip
                cursor={{ fill: c.grid, opacity: 0.5 }}
                contentStyle={c.tooltip}
                labelFormatter={(_l, payload) => payload[0]?.payload.name ?? ''}
                formatter={(v: unknown, name: unknown) => [fmt(Number(v)), seriesName(name, isYield)]}
              />
              {showBar && <Bar dataKey={isYield ? 'yieldPct' : 'amount'} fill={c.value} fillOpacity={barOpacity} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
              {showDots && <Line dataKey="onCostPct" stroke="none" dot={{ r: 4.5, fill: c.benchmark, stroke: c.tooltipBg, strokeWidth: 1.5, fillOpacity: dotOpacity, strokeOpacity: dotOpacity }} activeDot={{ r: 5 }} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
      <SelectableDataTable
        caption="Dividend yield and forward annual amount"
        rowHeader="Name"
        columns={columns}
        selection={selection}
        rows={bars.map((b) => ({ id: b.key, header: b.name, cells: [formatPercent(b.yieldPct), formatPercent(b.onCostPct), formatMoney(b.amount, currency)] }))}
      />
    </>
  );
}

function YieldPayoutBody({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const { current } = usePortfolioScope();
  const [metric, setMetric] = useState<YieldMetric>('yield');
  const [group, setGroup] = useState<YieldGroup>('holding');
  const categories = useCategories(current?.portfolioId);
  const hasCategories = (categories.data?.categories.length ?? 0) > 0;
  const bars = yieldBars(data.holdings, metric, hasCategories ? group : 'holding', categories.data);
  const selection = useSeriesSelection(
    metric === 'yield' ? YIELD_SERIES : AMOUNT_SERIES,
    bars.map((b) => b.key),
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <SegmentedControl label="Show" options={METRICS} value={metric} onChange={setMetric} />
        {hasCategories && <SegmentedControl label="Group by" options={GROUPS} value={group} onChange={setGroup} />}
      </div>
      {bars.length === 0 ? <EmptyNote>No dividend-paying holdings yet.</EmptyNote> : <YieldPayoutChart bars={bars} metric={metric} currency={data.baseCurrency} selection={selection} />}
    </div>
  );
}

export function YieldPayoutCard() {
  const query = useScopedDividendsOverview();
  return (
    <QueryCard
      id="div-yield-payout"
      title="Yield / payout"
      className="h-full"
      query={query}
      loadingLabel="Loading yield and payout"
      errorTitle="Could not load yield and payout"
      skeletonClassName="h-80 w-full"
      info={
        <>
          <p>Bars show each holding&apos;s forward dividend yield (expected net income over the next 12 months ÷ market value); the dots show the yield on your cost. Switch to Amount for the expected income per year in EUR.</p>
          <p>Click an entry in the legend, or a column or row header in the data table, to leave a series or a holding out of the chart.</p>
          <p>Group by Categories uses your portfolio categories (single portfolio only) and counts only dividend-paying holdings. Forward income = declared + estimated from payment frequency.</p>
        </>
      }
    >
      {(data) => <YieldPayoutBody data={data} />}
    </QueryCard>
  );
}
