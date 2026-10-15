import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DividendsOverviewResponse, GetDividendsResponse } from '@portfolio/shared';
import { useDividends } from '../../api/hooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { compactMoneyTick } from '../../components/charts/chartFormatters';
import { formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { ChartDataTable, ChartFrame, useDividendTheme } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { receivedFutureTimeline } from './receivedFuture';
import { ReceivedTimeline } from './ReceivedTimeline';
import { useScopedDividendsOverview } from './useDividendsOverview';
import {
  GRANULARITIES,
  PERIODS,
  paymentsInPeriod,
  receivedByHolding,
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

interface TotalProps {
  amount: number;
  currency: string;
  period: ReceivedPeriod;
  /** Net income expected in the next 12 months; shown next to the received total when the future is part of the chart. */
  upcoming?: number;
}

/** Headline: what was received in the period (never mixed with the future) and, next to it, the upcoming 12 months. */
function Total({ amount, currency, period, upcoming }: Readonly<TotalProps>) {
  return (
    <p className="mb-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
      <span>
        <span className="text-lg font-semibold tabular-nums" data-testid="received-total">
          {formatMoney(amount, currency)}
        </span>{' '}
        <span className="muted">received {PERIOD_NAMES[period]}</span>
      </span>
      {upcoming !== undefined && (
        <span>
          <span className="muted">Upcoming 12 months</span>{' '}
          <span className="text-lg font-semibold tabular-nums" data-testid="received-upcoming-total">
            {formatMoney(upcoming, currency)}
          </span>
        </span>
      )}
    </p>
  );
}

interface TimelineViewProps {
  data: GetDividendsResponse;
  period: ReceivedPeriod;
  granularity: Granularity;
  /** The overview whose future months are appended; undefined = received history only. */
  overview?: DividendsOverviewResponse;
}

function TimelineView({ data, period, granularity, overview }: Readonly<TimelineViewProps>) {
  const today = todayIso();
  const total = paymentsInPeriod(data.received, period, today).reduce((s, p) => s + p.amount, 0);
  const future = overview && { months: overview.futureMonths, byHolding: overview.futureByHolding };
  const periods = receivedFutureTimeline(data.received, period, granularity, today, future);
  const summary = overview?.summary;
  return (
    <>
      <Total amount={total} currency={data.baseCurrency} period={period} upcoming={summary?.forward12m} />
      <ReceivedTimeline periods={periods} currency={data.baseCurrency} granularity={granularity} upcoming={summary && { total: summary.forward12m, declared: summary.declared, estimated: summary.estimated }} />
    </>
  );
}

interface OverTimeProps {
  data: GetDividendsResponse;
  period: ReceivedPeriod;
  granularity: Granularity;
  includeFuture: boolean;
  overviewQuery: ReturnType<typeof useScopedDividendsOverview>;
}

function OverTime({ data, period, granularity, includeFuture, overviewQuery }: Readonly<OverTimeProps>) {
  if (data.received.length === 0) return <EmptyNote>No dividends received yet.</EmptyNote>;
  if (!includeFuture) return <TimelineView data={data} period={period} granularity={granularity} />;
  return (
    <QueryBoundary query={overviewQuery} loadingLabel="Loading upcoming payments" errorTitle="Could not load upcoming payments" skeletonClassName="h-72 w-full">
      {(overview) => <TimelineView data={data} period={period} granularity={granularity} overview={overview} />}
    </QueryBoundary>
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
  const [includeFuture, setIncludeFuture] = useState(true);
  const overviewQuery = useScopedDividendsOverview();

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
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={includeFuture} onChange={(e) => setIncludeFuture(e.target.checked)} />
              <span>Include future payments</span>
            </label>
          </>
        }
        info={
          <>
            <p>Net dividends you received (after withholding tax, converted to EUR at the rate of the payment date), per month, quarter or year, for the selected period. The headline counts only what was received.</p>
            <p>With &quot;Include future payments&quot; the next 12 months follow on the same axis: declared (announced) and estimated (implied by your payment history, not announced) income, net, at the latest exchange rate, the same figures as the Future payments card. The period that contains today stacks what you received so far with what is still expected, so its bar shows the full expected total. Amounts above the bars are rounded; the table has the exact figures.</p>
            <p>The dashed &quot;avg&quot; line is the average received per completed month, quarter or year in the view (the period in progress and the upcoming ones are not counted).</p>
            <p>Source: the DIVIDEND transactions in this portfolio scope and the dividend events behind Future payments.</p>
          </>
        }
      >
        {(data) => <OverTime data={data} period={period} granularity={granularity} includeFuture={includeFuture} overviewQuery={overviewQuery} />}
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
