import {
  buildEarningsDatesReport,
  isMarketSymbol,
  nextEarningsEvents,
  type EARNINGS_DATES_ROUTES,
  type GetEarningsDatesResponse,
  type RefreshReport,
} from '@portfolio/shared';
import type { RouteContext } from '../deps.js';
import { HttpError, ok, type RouteResult } from '../lib/http.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';
import { loadReports } from './calendar.js';
import { heldSymbols } from './portfolio.js';
import { resolveScope } from './portfolios.js';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const NO_REFRESH: RefreshReport = {
  available: false,
  reason: 'This deployment refreshes the earnings dates with its scheduled job only (daily at 05:30 Amsterdam time).',
  nextAllowedAt: null,
};

/**
 * `GET /diagnostics/earnings-dates`: the open positions of the read scope and, for each, the next earnings date as the calendar shows it,
 * or why there is none (see `whyNoEarningsDate`), next to what the daily calendar job did last. Reads only: the transactions, one batched
 * read of the tracked-ticker items, one query per held symbol, the two run records and the stored summaries (they anchor a projected date).
 */
export async function getEarningsDates(ctx: RouteContext): Promise<RouteResult> {
  const { repo, now, calendarDates } = ctx.deps;
  const scope = await resolveScope(ctx);
  const transactions = await repo.listTransactions(ctx.userId, scope);
  const held = heldSymbols(transactions)
    .filter((symbol) => isMarketSymbol(symbol))
    .sort((a, b) => a.localeCompare(b));
  const at = now();
  const today = isoDay(at);
  const [data, profiles, reportedEarnings, status] = await Promise.all([
    repo.getEarningsDatesData(held, today),
    loadProfiles(ctx, held),
    loadReports(ctx, held),
    calendarDates?.status() ?? { budget: null, refresh: NO_REFRESH },
  ]);
  const next = nextEarningsEvents({ today, transactions, watchlist: [], profiles, earnings: data.upcoming, reportedEarnings });
  const report = buildEarningsDatesReport({
    now: at,
    held: held.map((symbol) => ({ symbol, name: profiles[symbol]?.name ?? symbol })),
    tracked: data.tracked,
    next,
    run: data.run,
    lastOk: data.lastOk,
    budget: status.budget,
    refresh: status.refresh,
  });
  return ok(report satisfies GetEarningsDatesResponse);
}

/** `POST /diagnostics/earnings-dates/refresh`: queues the calendar job once; 429 when it was asked for less than an hour ago or the allowance of the day is nearly used. */
export async function refreshEarningsDates(ctx: RouteContext): Promise<RouteResult> {
  const { calendarDates } = ctx.deps;
  if (!calendarDates) throw new HttpError(404, 'NOT_AVAILABLE', NO_REFRESH.reason ?? 'Not available');
  const result = await calendarDates.refresh();
  if (result.accepted) return ok(result, 202);
  if (result.reason === 'not-configured') throw new HttpError(503, 'NOT_CONFIGURED', result.message);
  const retryAfter = result.retryAfterSeconds;
  return {
    statusCode: 429,
    body: { error: { code: 'RATE_LIMITED', message: result.message, details: { reason: result.reason, retryAfterSeconds: retryAfter } } },
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': String(retryAfter) } }),
  };
}

export const earningsDatesHandlers: Record<keyof typeof EARNINGS_DATES_ROUTES, RouteHandler> = {
  earningsDates: getEarningsDates,
  refreshEarningsDates,
};
