import {
  allocationQuerySchema,
  buildPositions,
  buildValueHistory,
  calculateAllocation,
  calculateDividends,
  calculatePortfolio,
  historyQuerySchema,
  historyRangeStart,
  sortTransactions,
  type EodPrice,
  type FxDay,
  type FxRates,
  type GetAllocationResponse,
  type GetDividendsResponse,
  type GetHistoryResponse,
  type GetHoldingsResponse,
  type GetPortfolioResponse,
  type IsoDate,
  type Transaction,
  type ValuePoint,
} from '@portfolio/shared';
import { ok, validate, type RouteResult } from '../lib/http.js';
import type { Deps, RouteContext } from '../deps.js';

export const MAX_HISTORY_POINTS = 400;
/** Extra days of EOD loaded before the range start so carry-forward closes are seeded. */
const EOD_LOOKBACK_DAYS = 14;
/** Days of ECB fixings loaded before the first transaction, so a trade on a weekend/holiday still has a prior fixing. */
export const FX_LOOKBACK_DAYS = 7;

const isoDay = (d: Date): IsoDate => d.toISOString().slice(0, 10);
const addDays = (date: IsoDate, days: number): IsoDate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

export function heldSymbols(transactions: readonly Transaction[]): string[] {
  return [...buildPositions(transactions).values()].filter((p) => p.quantity > 0).map((p) => p.symbol);
}

interface FxContext {
  /** Latest rates: market values and upcoming dividends are converted at these. */
  fx: FxRates;
  /** Daily ECB fixings from FX_LOOKBACK_DAYS before the first transaction until today, oldest first. */
  fxHistory: FxDay[];
}

/**
 * Loads the latest FX rates plus the daily fixings covering every transaction date. Without FX_DAY
 * items the engine converts each transaction at the latest rate; without a LATEST item the newest
 * fixing stands in. With neither, an empty rate table still works for base-currency-only portfolios;
 * any other currency raises MissingFxRateError (-> 503 FX_UNAVAILABLE).
 */
async function loadFx(deps: Deps, transactions: readonly Transaction[]): Promise<FxContext> {
  const base = deps.config.baseCurrency;
  const today = isoDay(deps.now());
  // Base-currency-only portfolios never convert anything, so they skip the history query.
  const needsHistory = transactions.some((t) => t.currency !== base);
  const first = transactions.reduce<IsoDate>((min, t) => (t.date < min ? t.date : min), today);
  const [latest, fxHistory] = await Promise.all([
    deps.repo.getFx(base),
    needsHistory ? deps.repo.getFxHistory(base, addDays(first, -FX_LOOKBACK_DAYS), today) : [],
  ]);
  const newest = fxHistory.at(-1);
  const fx: FxRates = latest ??
    (newest
      ? { base, rates: newest.rates, asOf: `${newest.date}T00:00:00.000Z` }
      : { base, rates: {}, asOf: deps.now().toISOString() });
  return { fx, fxHistory };
}

async function computePortfolio(ctx: RouteContext) {
  const { repo } = ctx.deps;
  const transactions = await repo.listTransactions(ctx.userId);
  const symbols = heldSymbols(transactions);
  const [quotes, profiles, { fx, fxHistory }] = await Promise.all([
    symbols.length ? repo.getQuotes(symbols) : {},
    symbols.length ? repo.getProfiles(symbols) : {},
    loadFx(ctx.deps, transactions),
  ]);
  return calculatePortfolio({ transactions, quotes, profiles, fx, fxHistory, now: ctx.deps.now() });
}

export async function getPortfolio(ctx: RouteContext): Promise<RouteResult> {
  const { summary } = await computePortfolio(ctx);
  return ok(summary satisfies GetPortfolioResponse);
}

export async function getHoldings(ctx: RouteContext): Promise<RouteResult> {
  const { summary, holdings } = await computePortfolio(ctx);
  return ok({ baseCurrency: summary.baseCurrency, holdings } satisfies GetHoldingsResponse);
}

export async function getAllocation(ctx: RouteContext): Promise<RouteResult> {
  const { by } = validate(allocationQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const { summary, holdings } = await computePortfolio(ctx);
  return ok({ by, baseCurrency: summary.baseCurrency, slices: calculateAllocation(holdings, by) } satisfies GetAllocationResponse);
}

/** Evenly samples `points` down to at most `max` entries, always keeping the first and last point. */
export function downsample(points: ValuePoint[], max = MAX_HISTORY_POINTS): ValuePoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: ValuePoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

export async function getHistory(ctx: RouteContext): Promise<RouteResult> {
  const { range } = validate(historyQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const { repo } = ctx.deps;
  const transactions = sortTransactions(await repo.listTransactions(ctx.userId));
  const { fx, fxHistory } = await loadFx(ctx.deps, transactions);
  const today = isoDay(ctx.deps.now());
  if (transactions.length === 0) {
    return ok({ range, baseCurrency: fx.base, points: [] } satisfies GetHistoryResponse);
  }
  const from = historyRangeStart(range, today, transactions[0]!.date);
  // All symbols ever traded matter for history (positions may have been closed inside the range).
  const symbols = [...new Set(transactions.map((t) => t.symbol))];
  const eodFrom = addDays(from, -EOD_LOOKBACK_DAYS);
  const series = await Promise.all(symbols.map((s) => repo.getEod(s, eodFrom, today)));
  const eod: Record<string, EodPrice[]> = Object.fromEntries(symbols.map((s, i) => [s, series[i]!]));
  const points = downsample(buildValueHistory(transactions, eod, fx, from, today, fxHistory));
  return ok({ range, baseCurrency: fx.base, points } satisfies GetHistoryResponse);
}

export async function getDividends(ctx: RouteContext): Promise<RouteResult> {
  const { repo } = ctx.deps;
  const transactions = await repo.listTransactions(ctx.userId);
  const symbols = heldSymbols(transactions);
  const [events, { fx, fxHistory }] = await Promise.all([
    Promise.all(symbols.map((s) => repo.getDividendEvents(s))),
    loadFx(ctx.deps, transactions),
  ]);
  const overview = calculateDividends(transactions, events.flat(), fx, isoDay(ctx.deps.now()), fxHistory);
  return ok(overview satisfies GetDividendsResponse);
}
