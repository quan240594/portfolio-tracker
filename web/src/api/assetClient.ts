import type {
  AssetDetailResponse,
  AssetHistoryResponse,
  AssetPositionsResponse,
  AssetRange,
  GetClosedSecuritiesResponse,
} from '@portfolio/shared';
import { request, scopeQuery } from './client';

const symbolPath = (symbol: string) => `/assets/${encodeURIComponent(symbol)}`;

export const assetApi = {
  /** Public part (profile, quote, stats, dividend history): the same for every portfolio scope. */
  detail: (symbol: string, signal?: AbortSignal) => request<AssetDetailResponse>('GET', symbolPath(symbol), { signal }),
  /** `benchmarks` is always sent (even empty): omitting it would select the default benchmark. */
  history: (scope: string, symbol: string, range: AssetRange, benchmarks: readonly string[], signal?: AbortSignal) =>
    request<AssetHistoryResponse>('GET', `${symbolPath(symbol)}/history`, { query: { ...scopeQuery(scope), range, benchmarks: benchmarks.join(',') }, signal }),
  positions: (scope: string, symbol: string, signal?: AbortSignal) =>
    request<AssetPositionsResponse>('GET', `${symbolPath(symbol)}/positions`, { query: scopeQuery(scope), signal }),
  closed: (scope: string, signal?: AbortSignal) => request<GetClosedSecuritiesResponse>('GET', '/securities/closed', { query: scopeQuery(scope), signal }),
};
