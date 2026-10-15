/**
 * Calendar REST contract (reads only; `?portfolioId=` scopes to one portfolio, omitted or `all` = combined).
 *
 * - GET /calendar       `?from=&to=&types=&status=&scope=` → CalendarResponse (events, summary, monthly income, coverage notes)
 * - GET /calendar.ics   same filters → `text/calendar` download with one all-day VEVENT per event
 *
 * `from`/`to` are YYYY-MM-DD; the default range is the current month ± 1 month and at most
 * MAX_CALENDAR_RANGE_DAYS days may be requested (400 VALIDATION_ERROR otherwise). `types` and `status` are comma-separated
 * lists of CALENDAR_EVENT_TYPES / CALENDAR_STATUSES; `scope` is `holdings`, `watchlist` or `all` (default).
 * The .ics output is a download (calendar apps cannot send the JWT), not a subscription URL.
 */
import { z } from 'zod';
import { daysBetween } from './analytics.js';
import {
  CALENDAR_EVENT_TYPES,
  CALENDAR_SCOPES,
  CALENDAR_STATUSES,
  MAX_CALENDAR_RANGE_DAYS,
  calendarAddMonths,
  calendarLastDay,
  calendarMonthOf,
  defaultCalendarRange,
  type CalendarQuery,
  type CalendarResponse,
} from './calendar.js';
import { portfolioScopeSchema } from './schemas.js';

export const CALENDAR_ROUTES = {
  calendar: 'GET /calendar',
  calendarIcs: 'GET /calendar.ics',
} as const;

export type GetCalendarResponse = CalendarResponse;

const isValidDay = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const isoDay = z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine(isValidDay, 'Not a calendar date').optional());

/** `a,b` → ['A', 'B']; an empty value counts as omitted. */
const upperList = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => {
      if (v === '' || v === null || v === undefined) return undefined;
      return typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        : v;
    },
    z.array(z.enum(values)).optional(),
  );

export const calendarQuerySchema = portfolioScopeSchema
  .extend({
    from: isoDay,
    to: isoDay,
    types: upperList(CALENDAR_EVENT_TYPES),
    status: upperList(CALENDAR_STATUSES),
    scope: z.preprocess(emptyToUndefined, z.enum(CALENDAR_SCOPES).default('all')),
  })
  .superRefine((q, ctx) => {
    if (!q.from || !q.to) return;
    if (q.to < q.from) ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must not be before `from`' });
    else if (daysBetween(q.from, q.to) + 1 > MAX_CALENDAR_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `The range must not exceed ${MAX_CALENDAR_RANGE_DAYS} days` });
    }
  });
export type CalendarQueryParams = z.output<typeof calendarQuerySchema>;

/** Fills in the default range: the current month ± 1; a single bound spans the month after / before it. */
export function resolveCalendarQuery(params: CalendarQueryParams, today: string): CalendarQuery {
  let { from, to } = params;
  if (from === undefined && to === undefined) ({ from, to } = defaultCalendarRange(today));
  else if (to === undefined) to = calendarLastDay(calendarAddMonths(calendarMonthOf(from!), 1));
  else if (from === undefined) from = `${calendarAddMonths(calendarMonthOf(to), -1)}-01`;
  return { from: from!, to: to!, types: params.types, statuses: params.status, scope: params.scope };
}

/** Client-side parameters of GET /calendar (everything optional; the API applies its defaults). */
export interface CalendarParams {
  from?: string;
  to?: string;
  types?: readonly string[];
  status?: readonly string[];
  scope?: string;
}
