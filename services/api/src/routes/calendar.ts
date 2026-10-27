import {
  buildCalendar,
  calendarDataWindow,
  calendarQuerySchema,
  calendarToIcs,
  marketSymbols,
  resolveCalendarQuery,
  type CALENDAR_ROUTES,
  type CalendarData,
  type CalendarResponse,
  type GetCalendarResponse,
  type ReportedEarnings,
} from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';
import { heldSymbols, loadFx } from './portfolio.js';
import { resolveScope } from './portfolios.js';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Quarters read per held company: the ones in the calendar window and the latest, which anchors the projected next date. */
const REPORTS_PER_SYMBOL = 6;

/** The report date and fiscal period of the stored earnings summaries of `symbols`. */
async function loadReports(ctx: RouteContext, symbols: readonly string[]): Promise<ReportedEarnings[]> {
  const lists = await Promise.all(symbols.map((symbol) => ctx.deps.repo.getEarningsSummaries(symbol, REPORTS_PER_SYMBOL)));
  return lists.flat().map((summary) => ({ symbol: summary.symbol, reportDate: summary.reportDate, period: summary.period }));
}

/**
 * Loads what the calendar needs for the caller only (`ctx.userId`): the transactions of the read scope, the stored
 * dividend/earnings/split items of the held (and, unless `scope=holdings`, watchlist) symbols, quotes, profiles and FX.
 */
async function loadCalendar(ctx: RouteContext): Promise<CalendarResponse> {
  const { repo, mgmt, now } = ctx.deps;
  const params = validate(calendarQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const today = isoDay(now());
  const query = resolveCalendarQuery(params, today);
  const portfolioScope = await resolveScope(ctx);
  const [transactions, watchlistEntries] = await Promise.all([
    repo.listTransactions(ctx.userId, portfolioScope),
    query.scope === 'holdings' ? [] : mgmt.listWatchlist(ctx.userId),
  ]);
  const held = heldSymbols(transactions);
  const watchlist = marketSymbols(watchlistEntries.map((w) => w.symbol));
  const symbols = [...new Set([...held, ...watchlist])];
  const profileSymbols = [...new Set([...marketSymbols(transactions.map((t) => t.symbol)), ...watchlist])];
  const window = calendarDataWindow(query, today);
  const [dividendEvents, stored, reportedEarnings, quotes, profiles, { fx, fxHistory }] = await Promise.all([
    Promise.all(symbols.map((s) => repo.getDividendEvents(s))),
    symbols.length > 0 ? repo.getCalendarEvents(symbols, window.from, window.to) : { earnings: [], splits: [] },
    loadReports(ctx, held),
    held.length > 0 ? repo.getQuotes(held) : {},
    profileSymbols.length > 0 ? loadProfiles(ctx, profileSymbols) : {},
    loadFx(ctx.deps, transactions),
  ]);
  const data: CalendarData = {
    today,
    transactions,
    quotes,
    profiles,
    fx,
    fxHistory,
    dividendEvents: dividendEvents.flat(),
    earnings: stored.earnings,
    reportedEarnings,
    splits: stored.splits,
    watchlist,
  };
  return buildCalendar(data, query);
}

export async function getCalendar(ctx: RouteContext): Promise<RouteResult> {
  return ok((await loadCalendar(ctx)) satisfies GetCalendarResponse);
}

/** The same events as a downloadable iCalendar file (a download, not a subscription: calendar apps cannot send the JWT). */
export async function getCalendarIcs(ctx: RouteContext): Promise<RouteResult> {
  const calendar = await loadCalendar(ctx);
  return {
    statusCode: 200,
    body: calendarToIcs(calendar.events, { baseCurrency: calendar.baseCurrency, now: ctx.deps.now() }),
    contentType: 'text/calendar; charset=utf-8',
    headers: { 'content-disposition': `attachment; filename="portfolio-calendar-${calendar.from}_${calendar.to}.ics"` },
  };
}

export const calendarHandlers: Record<keyof typeof CALENDAR_ROUTES, RouteHandler> = {
  calendar: getCalendar,
  calendarIcs: getCalendarIcs,
};

