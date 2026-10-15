import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  buildCalendar,
  calendarDataWindow,
  calendarQuerySchema,
  calendarToIcs,
  marketSymbols,
  resolveCalendarQuery,
  type CalendarData,
  type CalendarResponse,
} from '@portfolio/shared';
import * as db from './db';
import { createCalendarSeed } from './calendarSeed';
import { listWatchlist } from './management-db';
import { api, errorResponse, latency } from './utils';

/**
 * Mock backend for GET /calendar and /calendar.ics: the shared `buildCalendar` runs on the demo fixtures (transactions,
 * dividend events, watchlist, demo earnings and splits), exactly as the API runs it on DynamoDB data.
 */
function compute(request: Request): CalendarResponse {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = calendarQuerySchema.safeParse(params);
  if (!parsed.success) throw new db.MockHttpError(400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.issues);
  const seed = db.getSeed();
  const query = resolveCalendarQuery(parsed.data, seed.today);
  const base = db.getAnalyticsData(parsed.data.portfolioId);
  const calendar = createCalendarSeed(seed.today);
  const window = calendarDataWindow(query, seed.today);
  const watchlist = query.scope === 'holdings' ? [] : marketSymbols(listWatchlist().map((w) => w.symbol));
  const data: CalendarData = {
    today: base.today,
    transactions: base.transactions,
    quotes: base.quotes,
    profiles: base.profiles,
    fx: base.fx,
    fxHistory: base.fxHistory,
    dividendEvents: [...base.dividendEvents, ...calendar.dividendEvents],
    earnings: calendar.earnings.filter((e) => e.date >= window.from && e.date <= window.to),
    splits: calendar.splits.filter((s) => s.date >= window.from && s.date <= window.to),
    watchlist,
  };
  return buildCalendar(data, query);
}

async function respond(request: Request, ics: boolean): Promise<Response> {
  await latency();
  try {
    const calendar = compute(request);
    if (!ics) return HttpResponse.json(calendar);
    const body = calendarToIcs(calendar.events, { baseCurrency: calendar.baseCurrency, now: new Date() });
    return new HttpResponse(body, {
      status: 200,
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `attachment; filename="portfolio-calendar-${calendar.from}_${calendar.to}.ics"`,
      },
    });
  } catch (err) {
    if (err instanceof db.MockHttpError) return errorResponse(err.status, err.code, err.message, err.details);
    throw err;
  }
}

export const calendarHandlers: HttpHandler[] = [
  http.get(api('/calendar'), ({ request }) => respond(request, false)),
  http.get(api('/calendar.ics'), ({ request }) => respond(request, true)),
];
