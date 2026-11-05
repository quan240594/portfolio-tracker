import {
  buildDividendDatesReport,
  currentHoldings,
  manualDividendEvent,
  withManualDividends,
  type DIVIDEND_DATES_ROUTES,
  type GetDividendDatesResponse,
  type RefreshReport,
} from '@portfolio/shared';
import type { DividendChecksStatus, RouteContext } from '../deps.js';
import { HttpError, ok, type RouteResult } from '../lib/http.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';
import { loadFx } from './portfolio.js';
import { resolveScope } from './portfolios.js';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const NO_CHECK: RefreshReport = {
  available: false,
  reason: 'This deployment checks the dividends with its scheduled job only (a few symbols a day, daily at 05:30 Amsterdam time).',
  nextAllowedAt: null,
};

const NO_STATUS: DividendChecksStatus = { budget: null, refresh: NO_CHECK };

/**
 * `GET /diagnostics/dividend-dates`: the held symbols that can pay a dividend (ETFs included, crypto not) and, for each, the next dividend as the
 * calendar shows it (declared or only projected), the latest stored one, when and how its dividends were last checked, and why there is no declared
 * upcoming date (see `whyNoDeclaredDividend`), next to the EODHD allowance of the day and the state of the free fallback feed. Reads only: the
 * transactions, the stored dividend events and calendar markers of the held symbols, the entries of the user and the FX rates.
 */
export async function getDividendDates(ctx: RouteContext): Promise<RouteResult> {
  const { repo, mgmt, now, dividendChecks } = ctx.deps;
  const scope = await resolveScope(ctx);
  const transactions = await repo.listTransactions(ctx.userId, scope);
  const at = now();
  const { held } = currentHoldings(transactions, isoDay(at));
  const [data, stored, manual, profiles, { fx, fxHistory }, status] = await Promise.all([
    repo.getDividendDatesData(held),
    Promise.all(held.map((symbol) => repo.getDividendEvents(symbol))),
    mgmt.listManualDividends(ctx.userId),
    loadProfiles(ctx, held),
    loadFx(ctx.deps, transactions),
    dividendChecks?.status() ?? NO_STATUS,
  ]);
  const report = buildDividendDatesReport({
    now: at,
    transactions,
    profiles,
    fx,
    fxHistory,
    dividendEvents: withManualDividends(stored.flat(), manual.map((entry) => manualDividendEvent(entry))),
    tracked: data.tracked,
    states: data.states,
    budget: status.budget,
    refresh: status.refresh,
    feed: data.feed,
    ...(status.configured === undefined ? {} : { configured: status.configured }),
  });
  return ok(report satisfies GetDividendDatesResponse);
}

/** `POST /diagnostics/dividend-dates/refresh`: queues a dividends-only calendar run; 429 when it was asked for less than an hour ago or the EODHD allowance of the day is nearly used. */
export async function refreshDividendDates(ctx: RouteContext): Promise<RouteResult> {
  const { dividendChecks } = ctx.deps;
  if (!dividendChecks) throw new HttpError(404, 'NOT_AVAILABLE', NO_CHECK.reason ?? 'Not available');
  const result = await dividendChecks.refresh();
  if (result.accepted) return ok(result, 202);
  if (result.reason === 'not-configured') throw new HttpError(503, 'NOT_CONFIGURED', result.message);
  const retryAfter = result.retryAfterSeconds;
  return {
    statusCode: 429,
    body: { error: { code: 'RATE_LIMITED', message: result.message, details: { reason: result.reason, retryAfterSeconds: retryAfter } } },
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': String(retryAfter) } }),
  };
}

export const dividendDatesHandlers: Record<keyof typeof DIVIDEND_DATES_ROUTES, RouteHandler> = {
  dividendDates: getDividendDates,
  refreshDividendDates,
};
