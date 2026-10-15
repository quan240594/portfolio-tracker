import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GetDividendsResponse } from '@portfolio/shared';
import { useDividends } from '../../api/hooks';
import { SegmentedControl } from '../../components/SegmentedControl';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { ChartDataTable, ChartFrame, useDividendTheme } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import {
  GRANULARITIES,
  PERIODS,
  paymentsInPeriod,
  receivedByHolding,
  receivedSeries,
  type Granularity,
  type ReceivedPeriod,
} from './receivedSeries';

const todayIso = () => new Date().toISOString().slice(0, 10);

interface BarsProps {
  data: readonly { label: string; amount: number }[];
  currency: string;
  title: string;
  testId: string;
  caption: string;
  column: string;
}

function AmountBars({ data, currency, title, testId, caption, column }: Readonly<BarsProps>) {
  const c = useDividendTheme();
  const total = data.reduce((s, d) => s + d.amount, 0);
  const label = `${title}: ${data.length} bars, ${formatMoney(total, currency)} in total.`;
  return (
    <>
      <ChartFrame label={label} testId={testId} bars={data.length} height="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data as { label: string; amount: number }[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={c.tooltip} formatter={(v: unknown) => [formatMoney(Number(v), currency), 'Received']} />
            <Bar dataKey="amount" fill={c.received} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartDataTable caption={caption} columns={[column, 'Received']} rows={data.map((d) => [d.label, formatMoney(d.amount, currency)])} />
    </>
  );
}

const PERIOD_NAMES: Record<ReceivedPeriod, string> = { all: 'all time', '12m': 'the last 12 months', ytd: 'this year to date' };

function Total({ amount, currency, period }: Readonly<{ amount: number; currency: string; period: ReceivedPeriod }>) {
  return (
    <p className="mb-2 text-sm">
      <span className="text-lg font-semibold tabular-nums" data-testid="received-total">
        {formatMoney(amount, currency)}
      </span>{' '}
      <span className="muted">received {PERIOD_NAMES[period]}</span>
    </p>
  );
}

function OverTime({ data, period, granularity }: Readonly<{ data: GetDividendsResponse; period: ReceivedPeriod; granularity: Granularity }>) {
  const today = todayIso();
  const total = paymentsInPeriod(data.received, period, today).reduce((s, p) => s + p.amount, 0);
  if (data.received.length === 0) return <EmptyNote>No dividends received yet.</EmptyNote>;
  return (
    <>
      <Total amount={total} currency={data.baseCurrency} period={period} />
      <AmountBars
        data={receivedSeries(data.received, period, granularity, today)}
        currency={data.baseCurrency}
        title="Dividends received over time"
        testId="received-time-chart"
        caption="Dividends received per period"
        column="Period"
      />
    </>
  );
}

function ByHolding({ data, period }: Readonly<{ data: GetDividendsResponse; period: ReceivedPeriod }>) {
  const totals = receivedByHolding(data.received, period, todayIso());
  if (totals.length === 0) return <EmptyNote>No dividends received in this period.</EmptyNote>;
  return (
    <AmountBars
      data={totals.map((t) => ({ label: t.symbol, amount: t.amount }))}
      currency={data.baseCurrency}
      title="Dividends received by holding"
      testId="received-holding-chart"
      caption="Dividends received per holding"
      column="Holding"
    />
  );
}

/** "Dividends received" over time and by holding: one period selector drives both cards. */
export function ReceivedCards() {
  const { scope, ready } = usePortfolioScope();
  const query = useDividends(scope, { enabled: ready });
  const [period, setPeriod] = useState<ReceivedPeriod>('all');
  const [granularity, setGranularity] = useState<Granularity>('month');

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <QueryCard
        id="div-received-time"
        title="Dividends received"
        query={query}
        loadingLabel="Loading received dividends"
        errorTitle="Could not load dividends"
        controls={
          <>
            <SegmentedControl label="Period" options={PERIODS} value={period} onChange={setPeriod} />
            <SegmentedControl label="Granularity" options={GRANULARITIES} value={granularity} onChange={setGranularity} />
          </>
        }
        info={
          <>
            <p>Net dividends you received (after withholding tax, converted to EUR at the rate of the payment date), per month, quarter or year, for the selected period.</p>
            <p>Source: the DIVIDEND transactions in this portfolio scope. Announced but unpaid dividends are under Future payments.</p>
          </>
        }
      >
        {(data) => <OverTime data={data} period={period} granularity={granularity} />}
      </QueryCard>
      <QueryCard
        id="div-received-holding"
        title="Dividends received by holding"
        query={query}
        loadingLabel="Loading received dividends"
        errorTitle="Could not load dividends"
        info={<p>Net dividends received per holding in the period selected on the left, largest first. Holdings that were sold since still show the dividends they paid.</p>}
      >
        {(data) => <ByHolding data={data} period={period} />}
      </QueryCard>
    </div>
  );
}
