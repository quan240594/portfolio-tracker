import { addIsoDays, calendarMonthOf, type CalendarEvent } from '@portfolio/shared';
import { formatDate, formatDayOfMonth, formatMonthYear, formatWeekdayDate, formatWeekdayLong, formatWeekdayShort } from '../../lib/format';
import { EVENT_META, eventAriaLabel, isDividend, isEstimated, monthGrid } from './calendarModel';
import { chipClasses } from './calendarColours';
import { EventMarker } from './EventMarker';
import { expectedLabel } from './eventText';

/** Chips shown per day before the rest collapses into "+N more". */
export const MAX_CHIPS_PER_DAY = 3;

const MONDAY = '2024-01-01';
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => addIsoDays(MONDAY, i));

interface ChipProps {
  event: CalendarEvent;
  baseCurrency: string;
  onSelect: (event: CalendarEvent) => void;
}

function EventChip({ event, baseCurrency, onSelect }: Readonly<ChipProps>) {
  const amount = isDividend(event) ? expectedLabel(event, baseCurrency) : undefined;
  const italic = isEstimated(event) ? 'italic' : '';
  const title = [event.symbol, EVENT_META[event.type].label, amount].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      aria-label={eventAriaLabel(event, amount)}
      title={title}
      className={`flex w-full min-w-0 items-center gap-1 rounded border-l-4 px-1 py-1.5 text-left sm:py-0.5 text-xs leading-tight hover:brightness-95 ${chipClasses(event.status)} ${italic}`}
      data-status={event.status}
    >
      <EventMarker type={event.type} className="h-3.5 w-3.5" />
      <span className="truncate font-semibold">{event.symbol}</span>
      {amount && <span className="ml-auto shrink-0 tabular-nums">{amount}</span>}
    </button>
  );
}

interface CellProps {
  date: string;
  month: string;
  today: string;
  events: readonly CalendarEvent[];
  baseCurrency: string;
  onSelectEvent: (event: CalendarEvent) => void;
  onSelectDay: (date: string) => void;
}

function DayCell({ date, month, today, events, baseCurrency, onSelectEvent, onSelectDay }: Readonly<CellProps>) {
  const inMonth = calendarMonthOf(date) === month;
  const isToday = date === today;
  const visible = events.slice(0, MAX_CHIPS_PER_DAY);
  const hidden = events.length - visible.length;
  const background = inMonth ? 'bg-white dark:bg-slate-900' : 'bg-slate-50 dark:bg-slate-950/60';
  const dayNumber = isToday ? 'bg-brand-600 text-white' : 'text-slate-700 dark:text-slate-300';

  return (
    <td className={`h-32 min-w-0 sm:h-28 border border-slate-200 p-1 align-top dark:border-slate-800 ${background} ${inMonth ? '' : 'opacity-70'}`} data-date={date}>
      <div className="mb-1 flex justify-end">
        <span aria-current={isToday ? 'date' : undefined} className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold ${dayNumber}`}>
          <span aria-hidden="true">{formatDayOfMonth(date)}</span>
          <span className="sr-only">{formatWeekdayDate(date)}</span>
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {visible.map((e) => (
          <EventChip key={e.id} event={e} baseCurrency={baseCurrency} onSelect={onSelectEvent} />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => onSelectDay(date)}
            aria-label={`${hidden} more on ${formatDate(date)}`}
            className="rounded px-1 py-1.5 text-left text-xs font-medium text-brand-700 sm:py-0.5 hover:bg-slate-100 dark:text-brand-400 dark:hover:bg-slate-800"
          >
            +{hidden} more
          </button>
        )}
      </div>
    </td>
  );
}

interface GridProps {
  month: string;
  today: string;
  events: readonly CalendarEvent[];
  baseCurrency: string;
  onSelectEvent: (event: CalendarEvent) => void;
  onSelectDay: (date: string) => void;
}

/** Month grid, Monday to Sunday: a real table whose cells hold one button per event. */
export function MonthGrid({ month, today, events, baseCurrency, onSelectEvent, onSelectDay }: Readonly<GridProps>) {
  const grid = monthGrid(month);
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const monthLabel = formatMonthYear(month);

  return (
    // `relative` makes the wrapper the containing block of the sr-only (absolute) texts, so they are clipped with the table instead of widening the page.
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[49rem] table-fixed border-collapse">
        <caption className="sr-only">{`Calendar events in ${monthLabel}, Monday to Sunday`}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} scope="col" abbr={formatWeekdayLong(d)} className="muted border border-slate-200 bg-slate-50 py-1.5 text-xs font-medium uppercase dark:border-slate-800 dark:bg-slate-900/60">
                {formatWeekdayShort(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((date) => (
                <DayCell key={date} date={date} month={month} today={today} events={byDate.get(date) ?? []} baseCurrency={baseCurrency} onSelectEvent={onSelectEvent} onSelectDay={onSelectDay} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
