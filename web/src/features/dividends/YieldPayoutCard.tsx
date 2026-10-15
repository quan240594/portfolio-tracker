import { useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis, ResponsiveContainer } from 'recharts';
import type { DividendsOverviewResponse } from '@portfolio/shared';
import { useCategories } from '../../api/management-hooks';
import { SegmentedControl } from '../../components/SegmentedControl';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { ChartDataTable, ChartFrame, useDividendTheme } from './chartParts';
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

function YieldPayoutChart({ bars, metric, currency }: Readonly<{ bars: readonly YieldBar[]; metric: YieldMetric; currency: string }>) {
  const c = useDividendTheme();
  const isYield = metric === 'yield';
  const fmt = (v: number) => (isYield ? formatPercent(v) : formatMoney(v, currency));
  const summary = bars.map((b) => `${b.label} ${fmt(isYield ? b.yieldPct : b.amount)}`).join(', ');
  const label = `${isYield ? 'Dividend yield' : 'Forward annual dividend amount'} per ${bars.length} bars, highest first: ${summary}.`;
  return (
    <>
      <ChartFrame label={label} testId="yield-payout-chart" bars={bars.length}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={bars as YieldBar[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            <Bar dataKey={isYield ? 'yieldPct' : 'amount'} fill={c.value} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            {isYield && <Line dataKey="onCostPct" stroke="none" dot={{ r: 4.5, fill: c.benchmark, stroke: c.tooltipBg, strokeWidth: 1.5 }} activeDot={{ r: 5 }} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ul className="mt-1 flex flex-wrap justify-center gap-x-4 text-xs" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: c.value }} />
          {seriesName('bar', isYield)}
        </li>
        {isYield && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: c.benchmark }} />
            {seriesName('onCostPct', isYield)}
          </li>
        )}
      </ul>
      <ChartDataTable
        caption="Dividend yield and forward annual amount"
        columns={['Name', 'Yield', 'Yield on cost', 'Per year']}
        rows={bars.map((b) => [b.name, formatPercent(b.yieldPct), formatPercent(b.onCostPct), formatMoney(b.amount, currency)])}
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

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <SegmentedControl label="Show" options={METRICS} value={metric} onChange={setMetric} />
        {hasCategories && <SegmentedControl label="Group by" options={GROUPS} value={group} onChange={setGroup} />}
      </div>
      {bars.length === 0 ? <EmptyNote>No dividend-paying holdings yet.</EmptyNote> : <YieldPayoutChart bars={bars} metric={metric} currency={data.baseCurrency} />}
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
          <p>Group by Categories uses your portfolio categories (single portfolio only) and counts only dividend-paying holdings. Forward income = declared + estimated from payment frequency.</p>
        </>
      }
    >
      {(data) => <YieldPayoutBody data={data} />}
    </QueryCard>
  );
}
