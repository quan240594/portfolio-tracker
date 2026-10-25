import {
  MAX_VALUATION_SYMBOLS,
  alignEodScale,
  applyManagement,
  buildPositions,
  buildValuationReport,
  calculatePortfolio,
  isMarketSymbol,
  managementHistoryExtra,
  marketSymbols,
  reportDates,
  sortTransactions,
  valuationQuerySchema,
  type EodPrice,
  type GetValuationReportResponse,
  type VALUATION_ROUTES,
} from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { loadQuotes } from '../lib/quotes.js';
import type { RouteHandler } from '../router.js';
import { loadManagementScope } from './management-data.js';
import { EOD_LOOKBACK_DAYS, loadFx } from './portfolio.js';
import { resolveScope } from './portfolios.js';

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const shiftDay = (date: string, days: number): string => isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));

/** The symbols examined: the open positions first, then the closed ones, at most `MAX_VALUATION_SYMBOLS`. */
function examined(transactions: readonly { symbol: string }[], open: ReadonlySet<string>): { symbols: string[]; total: number } {
  const all = marketSymbols([...new Set(transactions.map((t) => t.symbol))]).sort((a, b) => Number(open.has(b)) - Number(open.has(a)) || a.localeCompare(b));
  return { symbols: all.slice(0, MAX_VALUATION_SYMBOLS), total: all.length };
}

/**
 * `GET /diagnostics/valuation?dates=`: how the value of the dashboard chart is made up on the requested days, symbol by symbol (see
 * `buildValuationReport`). One pass: the transactions, the FX rates, one read of the closes per symbol from the oldest day, one batched
 * read of the quotes, the cash/custom settings. Reads only.
 */
export async function getValuationReport(ctx: RouteContext): Promise<RouteResult> {
  const { dates: requested } = validate(valuationQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const { repo, now } = ctx.deps;
  const scope = await resolveScope(ctx);
  const transactions = sortTransactions(await repo.listTransactions(ctx.userId, scope));
  const today = isoDay(now());
  const dates = reportDates(requested, today);
  const { fx, fxHistory } = await loadFx(ctx.deps, transactions);
  const open = new Set([...buildPositions(transactions).values()].filter((p) => p.quantity > 0).map((p) => p.symbol));
  const { symbols, total } = examined(transactions, open);
  const chosen = new Set(symbols);
  const kept = transactions.filter((t) => !isMarketSymbol(t.symbol) || chosen.has(t.symbol));
  const from = shiftDay(dates[0] ?? today, -EOD_LOOKBACK_DAYS);
  const [series, quotes, management] = await Promise.all([
    Promise.all(symbols.map((s) => repo.getEod(s, from, today))),
    loadQuotes(repo, symbols),
    loadManagementScope(ctx, scope),
  ]);
  const storedEod: Record<string, EodPrice[]> = Object.fromEntries(symbols.map((s, i) => [s, series[i]!]));
  const eod: Record<string, EodPrice[]> = Object.fromEntries(symbols.map((s, i) => [s, alignEodScale(series[i]!, quotes[s])]));
  const headline = applyManagement(calculatePortfolio({ transactions: kept, quotes, profiles: {}, fx, fxHistory, now: now() }), { transactions: kept, ...management, fx, fxHistory, today }).summary.totalValue;
  const rowsRead = transactions.length + series.reduce((sum, rows) => sum + rows.length, 0) + Object.keys(quotes).length + fxHistory.length;
  const report = buildValuationReport({
    transactions: kept,
    eod,
    storedEod,
    fx,
    fxHistory,
    quotes,
    extra: managementHistoryExtra({ transactions: kept, ...management }),
    today,
    dates,
    headline,
    symbolsTotal: total,
    rowsRead,
  });
  return ok(report satisfies GetValuationReportResponse);
}

export const diagnosticsHandlers: Record<keyof typeof VALUATION_ROUTES, RouteHandler> = {
  valuationReport: getValuationReport,
};
