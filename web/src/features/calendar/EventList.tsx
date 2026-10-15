import type { CalendarEvent } from '@portfolio/shared';
import { formatDate } from '../../lib/format';
import { EVENT_META, STATUS_LABELS, eventAriaLabel, groupByDate, isEstimated } from './calendarModel';
import { EventMarker } from './EventMarker';
import { eventDetailLine, expectedLabel } from './eventText';

const DASHED_ROW = 'border border-l-4 border-dashed [border-left-style:solid]';

const STATUS_BADGE: Record<CalendarEvent['status'], string> = {
  CONFIRMED: 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300',
  ESTIMATED: 'border-dashed border-slate-400 text-slate-600 dark:border-slate-500 dark:text-slate-300',
  PAID: 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-200',
};

interface RowProps {
  event: CalendarEvent;
  baseCurrency: string;
  onSelect: (event: CalendarEvent) => void;
}

export function EventRow({ event, baseCurrency, onSelect }: Readonly<RowProps>) {
  const amount = expectedLabel(event, baseCurrency);
  const label = event.status === 'PAID' ? 'Received' : 'Expected';
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(event)}
        aria-label={eventAriaLabel(event, amount)}
        className={`flex w-full items-center gap-3 rounded-lg border-l-4 px-3 py-2 text-left text-sm hover:brightness-95 ${EVENT_META[event.type].accent} ${isEstimated(event) ? DASHED_ROW : ''}`}
      >
        <EventMarker type={event.type} className="h-5 w-5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <span className="font-semibold">{event.symbol}</span> <span className="opacity-75">{event.name === event.symbol ? '' : event.name}</span>
          </span>
          <span className="block truncate text-xs opacity-80">{eventDetailLine(event)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {amount && (
            <span className="font-medium tabular-nums">
              <span className="sr-only">{label} </span>
              {amount}
            </span>
          )}
          <span className={`rounded-full border px-2 py-px text-[11px] font-medium ${STATUS_BADGE[event.status]}`}>{STATUS_LABELS[event.status]}</span>
        </span>
      </button>
    </li>
  );
}

interface ListProps {
  events: readonly CalendarEvent[];
  baseCurrency: string;
  onSelect: (event: CalendarEvent) => void;
  today: string;
}

/** Chronological list grouped by date (the default view on small screens). */
export function EventList({ events, baseCurrency, onSelect, today }: Readonly<ListProps>) {
  const groups = groupByDate(events);
  return (
    <div className="space-y-5">
      {groups.map(({ date, events: day }) => (
        <section key={date} aria-labelledby={`day-${date}`}>
          <h3 id={`day-${date}`} className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            {formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            {date === today && <span className="rounded-full bg-brand-600 px-2 py-px text-[11px] font-medium text-white">Today</span>}
          </h3>
          <ul className="space-y-1.5">
            {day.map((e) => (
              <EventRow key={e.id} event={e} baseCurrency={baseCurrency} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
