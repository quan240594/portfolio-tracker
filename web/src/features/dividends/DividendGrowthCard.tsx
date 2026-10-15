import { useMemo, useState } from 'react';
import { buildGrowthTimeline, type AnalyticsDividendGrowthResponse } from '@portfolio/shared';
import { useAnalyticsDividendGrowth } from '../../api/analyticsHooks';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { EmptyNote, QueryCard } from './DividendCard';
import { GrowthStats } from './GrowthStats';
import { TimelineChart, YearChart } from './GrowthCharts';
import { GrowthControls } from './GrowthForecastParts';
import type { GrowthView } from './growthForecast';
import { useScopedDividendsOverview } from './useDividendsOverview';

const todayIso = () => new Date().toISOString().slice(0, 10);

type OverviewQuery = ReturnType<typeof useScopedDividendsOverview>;

interface BodyProps {
  data: AnalyticsDividendGrowthResponse;
  overview: OverviewQuery;
  view: GrowthView;
  showForecast: boolean;
}

function ForecastStatus({ overview }: Readonly<{ overview: OverviewQuery }>) {
  if (overview.isError) {
    return (
      <p className="muted mb-2 text-xs" data-testid="forecast-status">
        Forecast unavailable.{' '}
        <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-400" onClick={() => void overview.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  return overview.isPending ? (
    <p className="muted mb-2 text-xs" data-testid="forecast-status">
      Loading forecast…
    </p>
  ) : null;
}

function GrowthBody({ data, overview, view, showForecast }: Readonly<BodyProps>) {
  const future = overview.data?.futureMonths;
  const today = overview.data?.asOf ?? data.growthStats?.asOf ?? todayIso();
  const timeline = useMemo(() => buildGrowthTimeline(data.byMonth, future ?? [], today), [data.byMonth, future, today]);
  if (data.byMonth.length === 0) return <EmptyNote>No dividends received yet. Add dividend transactions to compare years.</EmptyNote>;
  const { summary } = overview.data ?? {};
  const forecast = summary ? { declared: summary.declared, estimated: summary.estimated, total: summary.forward12m } : null;
  const props = { data, timeline, showForecast, forecast };
  const stats = data.growthStats && <GrowthStats stats={data.growthStats} currency={data.baseCurrency} />;
  return (
    <>
      <ForecastStatus overview={overview} />
      {view === 'year' ? <YearChart {...props}>{stats}</YearChart> : <TimelineChart {...props}>{stats}</TimelineChart>}
    </>
  );
}

export function DividendGrowthCard() {
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsDividendGrowth(scope, { enabled: ready });
  const overview = useScopedDividendsOverview();
  const [view, setView] = useState<GrowthView>('year');
  const [showForecast, setShowForecast] = useState(true);
  return (
    <QueryCard
      id="div-year-compare"
      title="Dividend growth"
      query={query}
      loadingLabel="Loading dividend growth"
      errorTitle="Could not load dividend growth"
      skeletonClassName="h-72 w-full"
      controls={<GrowthControls view={view} onView={setView} showForecast={showForecast} onShowForecast={setShowForecast} forecastAvailable={overview.data !== undefined} />}
      info={
        <>
          <p>Net dividends received in each calendar month, with the last three years side by side (years without payments are left out), so you can see how each month grows.</p>
          <p>Source: your DIVIDEND transactions, converted to EUR at the rate of the payment date. The current year is incomplete.</p>
          <p>The forecast bars are the declared and estimated payments of the next 12 months (the Future payments card): the rest of this year in the matching year, the months after it in a &quot;forecast&quot; year. The Timeline view puts all months in one row and adds the 12-month average and a trend line. Both are estimates, not a promise.</p>
          <p>Below the chart: quarter over quarter, year over year and the all-time compound growth of the dividends you received. Only complete periods count; see each figure for how it is calculated.</p>
        </>
      }
    >
      {(data) => <GrowthBody data={data} overview={overview} view={view} showForecast={showForecast} />}
    </QueryCard>
  );
}
