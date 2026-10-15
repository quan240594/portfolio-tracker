import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  assetHistoryQuerySchema,
  assetSymbolSchema,
  buildBenchmarkOptions,
  computeAssetDetail,
  computeAssetHistory,
  computeAssetPositions,
  computeClosedSecurities,
  portfolioScopeSchema,
  type AssetData,
} from '@portfolio/shared';
import { ASSET_DETAILS } from './assetDetails';
import * as db from './db';
import { api, errorResponse, guard, latency } from './utils';

/** Everything stored for one symbol in the demo seed (profile with the optional details, quote, closes, dividend events). */
function assetData(symbol: string): AssetData {
  const seed = db.getSeed();
  const base = seed.profiles[symbol];
  return {
    symbol,
    today: seed.today,
    profile: base ? { ...base, ...ASSET_DETAILS[symbol] } : undefined,
    quote: seed.quotes[symbol],
    eod: seed.eod[symbol] ?? [],
    dividendEvents: seed.dividendEvents.filter((e) => e.symbol === symbol),
    fx: seed.fx,
    fxHistory: seed.fxHistory,
  };
}

const notFound = (symbol: string) => new db.MockHttpError(404, 'NOT_FOUND', `No data for ${symbol}`);

function pathSymbol(raw: unknown): string {
  const parsed = assetSymbolSchema.safeParse(String(raw));
  if (!parsed.success) throw notFound(String(raw));
  return parsed.data;
}

function scopeOf(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get('portfolioId') ?? undefined;
  const parsed = portfolioScopeSchema.safeParse({ portfolioId: raw });
  if (!parsed.success) throw new db.MockHttpError(400, 'VALIDATION_ERROR', 'Invalid portfolio id', parsed.error.flatten());
  return parsed.data.portfolioId;
}

/** Every demo symbol has end-of-day prices; suggestions that are not tracked are added by `buildBenchmarkOptions` (without data). */
function benchmarkOptions() {
  const { eod, profiles } = db.getSeed();
  return buildBenchmarkOptions(Object.entries(eod).map(([symbol, prices]) => ({ symbol, hasData: prices.length > 0, ...(profiles[symbol] ? { name: profiles[symbol].name } : {}) })));
}

/** Mock backend of GET /assets/{symbol}[/history|/positions] and GET /securities/closed, on the shared calculators. */
export const securitiesHandlers: HttpHandler[] = [
  http.get(api('/assets/:symbol'), async ({ params }) => {
    await latency();
    return guard(() => {
      const symbol = pathSymbol(params.symbol);
      const detail = computeAssetDetail(assetData(symbol));
      if (!detail) throw notFound(symbol);
      return HttpResponse.json(detail);
    })();
  }),

  http.get(api('/assets/:symbol/history'), async ({ request, params }) => {
    await latency();
    const query = assetHistoryQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid query parameters', query.error.issues);
    return guard(() => {
      const symbol = pathSymbol(params.symbol);
      const data = assetData(symbol);
      const transactions = db.scoped(scopeOf(request));
      const known = data.profile || data.quote || data.eod.length > 0 || transactions.some((t) => t.symbol === symbol);
      if (!known) throw notFound(symbol);
      const { range, benchmarks } = query.data;
      return HttpResponse.json(
        computeAssetHistory({ ...data, range, transactions, benchmarks: benchmarks.map((b) => ({ symbol: b, eod: db.getSeed().eod[b] ?? [] })), options: benchmarkOptions() }),
      );
    })();
  }),

  http.get(api('/assets/:symbol/positions'), async ({ request, params }) => {
    await latency();
    return guard(() => {
      const symbol = pathSymbol(params.symbol);
      const transactions = db.scoped(scopeOf(request));
      const portfolios = db.listPortfolios();
      const portfolioValues = Object.fromEntries(portfolios.map((p) => [p.portfolioId, db.portfolio(p.portfolioId).summary.totalValue]));
      const { fx, fxHistory, today, profiles, quotes } = db.getSeed();
      return HttpResponse.json(computeAssetPositions({ symbol, today, transactions, profile: profiles[symbol], quote: quotes[symbol], fx, fxHistory, portfolios, portfolioValues }));
    })();
  }),

  http.get(api('/securities/closed'), async ({ request }) => {
    await latency();
    return guard(() => {
      const { fx, fxHistory, profiles } = db.getSeed();
      return HttpResponse.json(computeClosedSecurities({ transactions: db.scoped(scopeOf(request)), profiles, fx, fxHistory }));
    })();
  }),
];
