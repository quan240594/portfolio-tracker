import {
  alignEodScale,
  assetHistoryQuerySchema,
  assetRangeStart,
  assetSymbolSchema,
  computeAssetDetail,
  computeAssetHistory,
  computeAssetPositions,
  computeClosedSecurities,
  type ASSET_DETAIL_ROUTES,
  type AssetDetailResponse,
  type AssetHistoryResponse,
  type AssetPositionsResponse,
  type GetClosedSecuritiesResponse,
  type Transaction,
} from '@portfolio/shared';
import { HttpError, ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import type { RouteHandler } from '../router.js';
import { benchmarkOptions } from './growth.js';
import { computePortfolio, loadFx } from './portfolio.js';
import { ensurePortfolios, resolveScope } from './portfolios.js';
import { loadProfiles } from '../lib/profiles.js';

/** Days of closes behind "today" read for the public detail: enough for the last two closes across holidays. */
const RECENT_EOD_DAYS = 14;
/** Start of all stored history (`ALL` and `5Y` ranges read everything stored for the symbol). */
const EPOCH = '1970-01-01';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

const notFound = (symbol: string) => new HttpError(404, 'NOT_FOUND', `No data for ${symbol}`);

function pathSymbol(ctx: RouteContext): string {
  const raw = String(ctx.pathParams.symbol);
  const parsed = assetSymbolSchema.safeParse(raw);
  if (!parsed.success) throw notFound(raw);
  return parsed.data;
}

export async function getAssetDetail(ctx: RouteContext): Promise<RouteResult> {
  const symbol = pathSymbol(ctx);
  const { repo, now } = ctx.deps;
  const today = isoDay(now());
  const [profiles, quotes, eod, dividendEvents, { fx }] = await Promise.all([
    loadProfiles(ctx, [symbol]),
    repo.getQuotes([symbol]),
    repo.getEod(symbol, addDays(today, -RECENT_EOD_DAYS), today),
    repo.getDividendEvents(symbol),
    loadFx(ctx.deps, []),
  ]);
  const detail = computeAssetDetail({ symbol, today, profile: profiles[symbol], quote: quotes[symbol], eod: alignEodScale(eod, quotes[symbol]), dividendEvents, fx });
  if (!detail) throw notFound(symbol);
  return ok(detail satisfies AssetDetailResponse);
}

const ofSymbol = (transactions: readonly Transaction[], symbol: string) => transactions.filter((t) => t.symbol === symbol);

export async function getAssetHistory(ctx: RouteContext): Promise<RouteResult> {
  const symbol = pathSymbol(ctx);
  const { range, benchmarks } = validate(assetHistoryQuerySchema.safeParse(ctx.query), 'Invalid query parameters');
  const { repo, now } = ctx.deps;
  const scope = await resolveScope(ctx);
  const today = isoDay(now());
  const scopeTransactions = await repo.listTransactions(ctx.userId, scope);
  const transactions = ofSymbol(scopeTransactions, symbol);
  // Shorter ranges only read the window they show; the longest read everything stored.
  const from = range === 'ALL' || range === '5Y' ? EPOCH : addDays(assetRangeStart(range, today), -RECENT_EOD_DAYS);
  const [profiles, quotes, eod, benchmarkEod, { fx, fxHistory }] = await Promise.all([
    loadProfiles(ctx, [symbol]),
    repo.getQuotes([symbol]),
    repo.getEod(symbol, from, today),
    Promise.all(benchmarks.map((b) => repo.getEod(b, from, today))),
    loadFx(ctx.deps, transactions),
  ]);
  if (eod.length === 0 && transactions.length === 0 && !profiles[symbol] && !quotes[symbol]) throw notFound(symbol);
  const options = await benchmarkOptions(ctx, { transactions: scopeTransactions, eod: Object.fromEntries(benchmarks.map((b, i) => [b, benchmarkEod[i]!])), today }, benchmarks);
  const history = computeAssetHistory({
    symbol,
    today,
    range,
    profile: profiles[symbol],
    quote: quotes[symbol],
    eod: alignEodScale(eod, quotes[symbol]),
    transactions,
    benchmarks: benchmarks.map((b, i) => ({ symbol: b, eod: benchmarkEod[i]! })),
    options,
    fx,
    fxHistory,
  });
  return ok(history satisfies AssetHistoryResponse);
}

export async function getAssetPositions(ctx: RouteContext): Promise<RouteResult> {
  const symbol = pathSymbol(ctx);
  const { repo, now } = ctx.deps;
  const scope = await resolveScope(ctx);
  const transactions = ofSymbol(await repo.listTransactions(ctx.userId, scope), symbol);
  const [profiles, quotes, { fx, fxHistory }, portfolios] = await Promise.all([
    loadProfiles(ctx, [symbol]),
    repo.getQuotes([symbol]),
    loadFx(ctx.deps, transactions),
    ensurePortfolios(ctx),
  ]);
  // The share of a position is measured against the whole portfolio it sits in, like the holdings weights.
  const ids = [...new Set(transactions.map((t) => t.portfolioId))];
  const totals = await Promise.all(ids.map((id) => computePortfolio({ ...ctx, query: { ...ctx.query, portfolioId: id } })));
  const portfolioValues = Object.fromEntries(ids.map((id, i) => [id, totals[i]!.summary.totalValue]));
  const result = computeAssetPositions({ symbol, today: isoDay(now()), transactions, profile: profiles[symbol], quote: quotes[symbol], fx, fxHistory, portfolios, portfolioValues });
  return ok(result satisfies AssetPositionsResponse);
}

export async function getClosedSecurities(ctx: RouteContext): Promise<RouteResult> {
  const { repo } = ctx.deps;
  const transactions = await repo.listTransactions(ctx.userId, await resolveScope(ctx));
  const symbols = [...new Set(transactions.map((t) => t.symbol))];
  const [profiles, { fx, fxHistory }] = await Promise.all([symbols.length ? loadProfiles(ctx, symbols) : {}, loadFx(ctx.deps, transactions)]);
  return ok(computeClosedSecurities({ transactions, profiles, fx, fxHistory }) satisfies GetClosedSecuritiesResponse);
}

export const assetDetailHandlers: Record<keyof typeof ASSET_DETAIL_ROUTES, RouteHandler> = {
  assetDetail: getAssetDetail,
  assetHistory: getAssetHistory,
  assetPositions: getAssetPositions,
  closedSecurities: getClosedSecurities,
};
