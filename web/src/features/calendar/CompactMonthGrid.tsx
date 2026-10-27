import { addIsoDays, calendarMonthOf, type CalendarEvent } from '@portfolio/shared';
import { formatDate, formatDayOfMonth, formatMonthYear, formatWeekdayLong, formatWeekdayShort } from '../../lib/format';
import { eventAriaLabel, isDividend, isEstimated, monthGrid } from './calendarModel';
import { KEY_SWATCH } from './calendarColours';
import { EventMarker } from './EventMarker';
import { expectedLabel } from './eventText';

/** Markers per day before the rest collapses into "+N". */
export const MAX_MARKERS_PER_DAY = 3;

const MONDAY = '2024-01-01';
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => addIsoDays(MONDAY, i));

/** The surface of an event in a row, as a small swatch: the ex-dividend is violet, everything else shows its status. */
export function markerSurface(event: Pick<CalendarEvent, 'type' | 'status'>): string {
  if (event.type !== 'EX_DIVIDEND') return KEY_SWATCH[event.status];
  return isEstimated(event) ? `${KEY_SWATCH.exDividend} border-dashed` : KEY_SWATCH.exDividend;
}

interface DayProps {
  date: string;
  today: string;
  events: readonly CalendarEvent[];
  baseCurrency: string;
}

function Day({ date, today, events, baseCurrency }: Readonly<DayProps>) {
  const isToday = date === today;
  const visible = events.slice(0, MAX_MARKERS_PER_DAY);
  const hidden = events.length - visible.length;
  const dayNumber = isToday ? 'bg-brand-600 text-white' : 'text-slate-700 dark:text-slate-300';
  const labels = events.map((e) => eventAriaLabel(e, isDividend(e) ? expectedLabel(e, baseCurrency) : undefined));
  return (
    <td className="h-14 min-w-0 border border-slate-200 p-0.5 align-top dark:border-slate-800" data-date={date}>
      <div className="flex justify-end">
        <span aria-current={isToday ? 'date' : undefined} className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold ${dayNumber}`}>
          {formatDayOfMonth(date)}
        </span>
      </div>
      {events.length > 0 && (
        <>
          <div className="flex flex-wrap gap-0.5" aria-hidden="true">
            {visible.map((e, i) => (
              <span
                key={e.id}
                title={labels[i]}
                data-type={e.type}
                data-status={e.status}
                className={`inline-flex h-4 w-4 items-center justify-center rounded border ${markerSurface(e)}`}
              >
                <EventMarker type={e.type} className="h-3 w-3" />
              </span>
            ))}
            {hidden > 0 && <span className="text-[10px] font-medium text-brand-700 dark:text-brand-400">+{hidden}</span>}
          </div>
          <span className="sr-only">{`${formatDate(date)}: ${labels.join('; ')}`}</span>
        </>
      )}
    </td>
  );
}

interface GridProps {
  month: string;
  today: string;
  events: readonly CalendarEvent[];
  baseCurrency: string;
}

/** One-month table for small cards: a coloured marker (shape + letter + status colour) per event; the days of the neighbouring months stay empty. */
export function CompactMonthGrid({ month, today, events, baseCurrency }: Readonly<GridProps>) {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (calendarMonthOf(e.date) === month) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  }
  return (
    <table className="w-full table-fixed border-collapse" data-testid="compact-month-grid">
      <caption className="sr-only">{`Calendar events in ${formatMonthYear(month)}, Monday to Sunday`}</caption>
      <thead>
        <tr>
          {WEEKDAYS.map((d) => (
            <th key={d} scope="col" abbr={formatWeekdayLong(d)} className="muted border border-slate-200 bg-slate-50 py-1 text-[11px] font-medium uppercase dark:border-slate-800 dark:bg-slate-900/60">
              {formatWeekdayShort(d)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {monthGrid(month).weeks.map((week) => (
          <tr key={week[0]}>
            {week.map((date) =>
              calendarMonthOf(date) === month ? (
                <Day key={date} date={date} today={today} events={byDate.get(date) ?? []} baseCurrency={baseCurrency} />
              ) : (
                <td key={date} className="h-14 border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/60" aria-hidden="true" />
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
