import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent, CalendarParams } from '@portfolio/shared';
import { errorMessage } from '../api/client';
import { useDownloadCalendarIcs, useCalendar } from '../api/calendarHooks';
import { useHoldings } from '../api/hooks';
import { useWatchlist } from '../api/management-hooks';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { PageHeader } from '../components/Layout';
import { LoadingRegion, Skeleton } from '../components/Skeleton';
import { CalendarKpis, CoverageNotes, IncomeChartCard } from '../features/calendar/CalendarOverview';
import { FilterBar, ViewToolbar } from '../features/calendar/CalendarControls';
import { DayDialog, EventDialog } from '../features/calendar/EventDialog';
import { EventList } from '../features/calendar/EventList';
import { MonthGrid } from '../features/calendar/MonthGrid';
import { filterEvents, monthIncome, requestRange, type CalendarUiState } from '../features/calendar/calendarModel';
import { useCalendarState } from '../features/calendar/useCalendarState';
import { downloadFile } from '../features/management/form';
import { usePortfolioScope } from '../features/portfolios/usePortfolioScope';
import { BASE_CURRENCY, formatMonthYear, formatMoney } from '../lib/format';

const ICS_MIME = 'text/calendar;charset=utf-8';

/** The filters as API parameters; lists that contain everything are left out. */
function icsParams(state: CalendarUiState, range: { from: string; to: string }): CalendarParams {
  return { ...range, types: state.types, status: state.statuses, scope: state.scope };
}

type Selection = { kind: 'event'; id: string } | { kind: 'day'; date: string } | null;

function Skeletons() {
  return (
    <LoadingRegion label="Loading calendar">
      <Skeleton className="h-96 w-full" />
    </LoadingRegion>
  );
}

interface MainProps {
  state: CalendarUiState;
  today: string;
  events: readonly CalendarEvent[];
  currency: string;
  loading: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
  onSelectDay: (date: string) => void;
}

function CalendarMain({ state, today, events, currency, loading, onSelectEvent, onSelectDay }: Readonly<MainProps>) {
  if (loading) return <Skeletons />;
  if (state.view === 'calendar') {
    return <MonthGrid month={state.month} today={today} events={events} baseCurrency={currency} onSelectEvent={onSelectEvent} onSelectDay={onSelectDay} />;
  }
  if (events.length === 0) {
    return <p className="muted py-8 text-center text-sm">No events in this period for the selected filters.</p>;
  }
  return <EventList events={events} baseCurrency={currency} onSelect={onSelectEvent} today={today} />;
}

export function CalendarPage() {
  const { scope, ready, scopeName, withScope } = usePortfolioScope();
  const { state, update, today } = useCalendarState();
  const [selection, setSelection] = useState<Selection>(null);
  const range = requestRange(state, today);
  const calendar = useCalendar(scope, range, { enabled: ready });
  const holdings = useHoldings(scope, { enabled: ready });
  const watchlist = useWatchlist();
  const download = useDownloadCalendarIcs(scope);
  const [saved, setSaved] = useState<string | null>(null);

  const { data } = calendar;
  const currency = data?.baseCurrency ?? BASE_CURRENCY;
  const events = useMemo(() => filterEvents(data?.events ?? [], state), [data, state]);
  const everything = data?.events ?? [];
  const selectedEvent = selection?.kind === 'event' ? (everything.find((e) => e.id === selection.id) ?? null) : null;
  const dayDate = selection?.kind === 'day' ? selection.date : null;

  const prefix = scopeName ? `${scopeName} · ` : '';
  const description = `${prefix}Ex-dividend and payment dates, earnings, splits and corporate actions of your holdings and watchlist. Amounts in ${currency}.`;

  if (holdings.data && watchlist.data && holdings.data.holdings.length === 0 && watchlist.data.items.length === 0) {
    return (
      <>
        <PageHeader title="Calendar" description={description} />
        <EmptyState
          title="Nothing to show in your calendar yet"
          description="Add a transaction or follow a symbol on your watchlist, and its dividend dates, earnings and splits will appear here."
          actions={
            <>
              <Link to={withScope('/transactions')} className="btn-primary">
                Add a transaction
              </Link>
              <Link to={withScope('/watchlist')} className="btn-secondary">
                Open watchlist
              </Link>
            </>
          }
        />
      </>
    );
  }

  const onDownload = () => {
    setSaved(null);
    download.mutate(icsParams(state, range), {
      onSuccess: ({ fileName, text }) => {
        downloadFile(fileName, text, ICS_MIME);
        setSaved(fileName);
      },
    });
  };

  const dayEvents = dayDate ? events.filter((e) => e.date === dayDate) : [];
  const monthTotal = monthIncome(everything, state.month);
  const showMonthTotal = state.range === 'month' && !!data;

  return (
    <>
      <PageHeader title="Calendar" description={description} />
      <div className="space-y-6">
        <section className="card space-y-4 p-4" aria-label="Calendar filters">
          <FilterBar state={state} onChange={update} onDownload={onDownload} downloading={download.isPending} downloadDisabled={state.types.length === 0 || state.statuses.length === 0} />
          <output className="block text-xs empty:hidden" aria-live="polite">
            {saved && <span className="muted">Saved {saved}. Import it into your calendar app; it is a one-time download, not a subscription.</span>}
          </output>
          {download.isError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              Could not download the calendar: {errorMessage(download.error)}
            </p>
          )}
        </section>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <CalendarKpis summary={data?.summary} currency={currency} loading={calendar.isPending} />
          <IncomeChartCard monthly={data?.monthly} summary={data?.summary} currency={currency} loading={calendar.isPending} />
        </div>

        <section className="card space-y-4 p-4" aria-label="Events">
          <ViewToolbar state={state} today={today} onChange={update} />
          {showMonthTotal && (
            <p className="text-sm">
              <span className="muted">Expected dividends in {formatMonthYear(state.month)}: </span>
              <strong className="tabular-nums">{formatMoney(monthTotal, currency)}</strong>
            </p>
          )}
          {calendar.isError && <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} title="Could not load the calendar" />}
          {!calendar.isError && (
            <CalendarMain
              state={state}
              today={today}
              events={events}
              currency={currency}
              loading={calendar.isPending}
              onSelectEvent={(e) => setSelection({ kind: 'event', id: e.id })}
              onSelectDay={(date) => setSelection({ kind: 'day', date })}
            />
          )}
        </section>

        <CoverageNotes earnings={data?.coverage.earnings} corporateActions={data?.coverage.corporateActions} />
      </div>

      <EventDialog event={selectedEvent} baseCurrency={currency} onClose={() => setSelection(null)} withScope={withScope} />
      <DayDialog date={dayDate} events={dayEvents} baseCurrency={currency} onClose={() => setSelection(null)} onSelect={(e) => setSelection({ kind: 'event', id: e.id })} />
    </>
  );
}
