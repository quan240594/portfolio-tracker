import {
  CALENDAR_EVENT_TYPES,
  CALENDAR_SCOPES,
  CALENDAR_STATUSES,
  addIsoDays,
  calendarAddMonths,
  calendarLastDay,
  calendarMonthOf,
  matchesCalendarFilter,
  roundTo,
  type CalendarEvent,
  type CalendarEventType,
  type CalendarScope,
  type CalendarStatus,
} from '@portfolio/shared';
import { EX_DIVIDEND_MARKER_FILL } from './calendarColours';

export type CalendarView = 'calendar' | 'list';
export type CalendarRange = 'month' | 'year';

export interface CalendarUiState {
  view: CalendarView;
  range: CalendarRange;
  /** The month shown (YYYY-MM); with the 12-month range it only anchors the "back to this month" state. */
  month: string;
  types: CalendarEventType[];
  statuses: CalendarStatus[];
  scope: CalendarScope;
}

// --- Presentation of event types and statuses -------------------------------------------------------------

export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon';

export interface EventMeta {
  label: string;
  /** One letter inside the marker, so colour is never the only signal. */
  letter: string;
  shape: MarkerShape;
  /** Fill of the marker shape. */
  fill: string;
}

/** Neutral marker colour of every type but the ex-dividend: shape and letter tell the type, the three status hues stay free for the status. */
const MARKER_FILL = 'fill-slate-700 dark:fill-slate-200';

export const EVENT_META: Readonly<Record<CalendarEventType, EventMeta>> = {
  EX_DIVIDEND: {
    label: 'Ex-dividend',
    letter: 'E',
    shape: 'circle',
    fill: EX_DIVIDEND_MARKER_FILL,
  },
  DIVIDEND_PAY: {
    label: 'Dividend payment',
    letter: 'P',
    shape: 'square',
    fill: MARKER_FILL,
  },
  EARNINGS: {
    label: 'Earnings',
    letter: 'R',
    shape: 'diamond',
    fill: MARKER_FILL,
  },
  SPLIT: {
    label: 'Stock split',
    letter: 'S',
    shape: 'triangle',
    fill: MARKER_FILL,
  },
  CORPORATE_ACTION: {
    label: 'Corporate action',
    letter: 'C',
    shape: 'hexagon',
    fill: MARKER_FILL,
  },
};

export const STATUS_LABELS: Readonly<Record<CalendarStatus, string>> = { CONFIRMED: 'Confirmed', ESTIMATED: 'Estimated', PAID: 'Received' };
export const SCOPE_LABELS: Readonly<Record<CalendarScope, string>> = { holdings: 'My holdings', watchlist: 'Watchlist', all: 'Holdings and watchlist' };

/** What the status chip and the accessible name say: released results are "Reported" (CONFIRMED underneath; there is no separate status). */
export const statusLabel = (e: Pick<CalendarEvent, 'status' | 'earningsPhase'>): string => (e.earningsPhase === 'reported' ? 'Reported' : STATUS_LABELS[e.status]);

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  alphavantage: 'Alpha Vantage',
  eodhd: 'EODHD',
  'market-data': 'Market data provider',
  transactions: 'Your transactions',
  estimate: 'Projected from your payment history',
  'earnings-summary': 'Earnings summary (company release)',
  mock: 'Demo data',
};
const EARNINGS_ESTIMATE_LABEL = 'Projected from the previous report';

/** Where an event's date comes from; a projected earnings date is projected from the previous report, a projected dividend from your payments. */
export const sourceLabel = (source: string, type?: CalendarEventType): string => (source === 'estimate' && type === 'EARNINGS' ? EARNINGS_ESTIMATE_LABEL : (SOURCE_LABELS[source] ?? source));

export const isDividend = (e: Pick<CalendarEvent, 'type'>): boolean => e.type === 'EX_DIVIDEND' || e.type === 'DIVIDEND_PAY';

// --- URL state ---------------------------------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function listParam<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T[] {
  const raw = params.get(name);
  if (raw === null) return [...allowed];
  return raw
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export function parseCalendarState(params: URLSearchParams, today: string, defaultView: CalendarView): CalendarUiState {
  const month = params.get('month') ?? '';
  const view = params.get('view');
  const scope = params.get('scope');
  const range: CalendarRange = params.get('range') === 'year' ? 'year' : 'month';
  const requestedView = view === 'calendar' || view === 'list' ? view : defaultView;
  return {
    // The grid shows one month, so the 12-month range is always a list.
    view: range === 'year' ? 'list' : requestedView,
    range,
    month: MONTH_RE.test(month) ? month : calendarMonthOf(today),
    types: listParam(params, 'types', CALENDAR_EVENT_TYPES),
    statuses: listParam(params, 'status', CALENDAR_STATUSES),
    scope: CALENDAR_SCOPES.find((s) => s === scope) ?? 'all',
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v));

/** Writes `next` into `params`, leaving out everything that equals the default so URLs stay short. */
export function applyCalendarState(params: URLSearchParams, next: CalendarUiState, today: string, defaultView: CalendarView): URLSearchParams {
  const out = new URLSearchParams(params);
  const set = (name: string, value: string | null) => (value === null ? out.delete(name) : out.set(name, value));
  set('view', next.view === defaultView ? null : next.view);
  set('range', next.range === 'month' ? null : next.range);
  set('month', next.month === calendarMonthOf(today) ? null : next.month);
  set('types', sameSet(next.types, CALENDAR_EVENT_TYPES) ? null : next.types.join(','));
  set('status', sameSet(next.statuses, CALENDAR_STATUSES) ? null : next.statuses.join(','));
  set('scope', next.scope === 'all' ? null : next.scope);
  return out;
}

// --- Dates and ranges --------------------------------------------------------------------------------------

/** Today in the user's time zone as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Monday = 0 … Sunday = 6. */
const weekdayIndex = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export interface MonthGrid {
  month: string;
  from: string;
  to: string;
  /** Monday-first weeks (7 dates each) covering the month, including the days of the neighbouring months. */
  weeks: string[][];
}

export function monthGrid(month: string): MonthGrid {
  const first = `${month}-01`;
  const last = calendarLastDay(month);
  const from = addIsoDays(first, -weekdayIndex(first));
  const to = addIsoDays(last, 6 - weekdayIndex(last));
  const weeks: string[][] = [];
  for (let start = from; start <= to; start = addIsoDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addIsoDays(start, i)));
  }
  return { month, from, to, weeks };
}

export const shiftMonth = (month: string, delta: number): string => calendarAddMonths(month, delta);

/** The dates requested from the API for a UI state: the visible grid (month range) or today + 364 days (12-month range). */
export function requestRange(state: Pick<CalendarUiState, 'range' | 'month' | 'view'>, today: string): { from: string; to: string } {
  if (state.range === 'year') return { from: today, to: addIsoDays(today, 364) };
  if (state.view === 'calendar') {
    const grid = monthGrid(state.month);
    return { from: grid.from, to: grid.to };
  }
  return { from: `${state.month}-01`, to: calendarLastDay(state.month) };
}

// --- Events ------------------------------------------------------------------------------------------------

export function filterEvents(events: readonly CalendarEvent[], state: Pick<CalendarUiState, 'types' | 'statuses' | 'scope'>): CalendarEvent[] {
  if (state.types.length === 0 || state.statuses.length === 0) return [];
  return events.filter((e) => matchesCalendarFilter(e, { types: state.types, statuses: state.statuses, scope: state.scope }));
}

export function groupByDate(events: readonly CalendarEvent[]): { date: string; events: CalendarEvent[] }[] {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, events: list }));
}

/** Expected dividend income of a month: the events that carry their dividend's amount (pay date, else ex-date). */
export function monthIncome(events: readonly CalendarEvent[], month: string): number {
  return roundTo(events.filter((e) => e.countsAsIncome && calendarMonthOf(e.date) === month).reduce((s, e) => s + (e.expectedAmount ?? 0), 0));
}

/** Income still to come between two dates (inclusive): declared and estimated dividends; what was already received (PAID) is left out. */
export function remainingIncome(events: readonly CalendarEvent[], from: string, to: string): number {
  return roundTo(events.filter((e) => e.countsAsIncome && e.status !== 'PAID' && e.date >= from && e.date <= to).reduce((s, e) => s + (e.expectedAmount ?? 0), 0));
}

export const isEstimated = (e: Pick<CalendarEvent, 'status'>): boolean => e.status === 'ESTIMATED';

/** `AAPL · Ex-dividend · Confirmed` — the accessible name of a chip or row. */
export function eventAriaLabel(e: CalendarEvent, amount: string | undefined): string {
  const parts = [e.symbol, EVENT_META[e.type].label, statusLabel(e).toLowerCase()];
  if (amount) parts.push(amount);
  return parts.join(', ');
}
