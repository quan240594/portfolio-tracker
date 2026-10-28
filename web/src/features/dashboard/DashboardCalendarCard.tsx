import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { calendarMonthOf } from '@portfolio/shared';
import { useCalendar } from '../../api/calendarHooks';
import { ErrorState } from '../../components/ErrorState';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { BASE_CURRENCY, formatMoney, formatMonthYear } from '../../lib/format';
import { ColourKey, MonthNavigator } from '../calendar/CalendarControls';
import { CompactMonthGrid } from '../calendar/CompactMonthGrid';
import { localToday, monthIncome, requestRange } from '../calendar/calendarModel';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

/** Compact month calendar of the holdings' dividend dates and earnings, on the same data and colours as the Calendar page. */
export function DashboardCalendarCard() {
  const { scope, ready, withScope } = usePortfolioScope();
  const today = useMemo(() => localToday(), []);
  const [month, setMonth] = useState(() => calendarMonthOf(today));
  const params = useMemo(() => ({ ...requestRange({ range: 'month', view: 'calendar', month }, today), scope: 'holdings' }), [month, today]);
  const { data, isPending, isError, error, refetch, isPlaceholderData } = useCalendar(scope, params, { enabled: ready });
  const currency = data?.baseCurrency ?? BASE_CURRENCY;

  let body;
  if (isError) {
    body = <ErrorState error={error} onRetry={() => void refetch()} title="Could not load the calendar" />;
  } else if (isPending || !data) {
    body = (
      <LoadingRegion label="Loading calendar">
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  } else {
    body = (
      <div className={isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        <CompactMonthGrid month={month} today={today} events={data.events} baseCurrency={currency} />
        <p className="mt-3 text-sm">
          <span className="muted">Expected dividends in {formatMonthYear(month)}: </span>
          <strong className="tabular-nums">{formatMoney(monthIncome(data.events, month), currency)}</strong>
        </p>
      </div>
    );
  }

  return (
    <section className="card space-y-3 p-4" aria-labelledby="dash-calendar-title" data-testid="dashboard-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="dash-calendar-title" className="font-semibold">
          Calendar
        </h2>
        <Link to={withScope(`/calendar?month=${month}&scope=holdings`)} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
          Open full calendar →
        </Link>
      </div>
      <MonthNavigator month={month} today={today} range="month" onMonth={setMonth} />
      {body}
      <ColourKey />
    </section>
  );
}
