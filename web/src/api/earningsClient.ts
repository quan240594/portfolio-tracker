import type { EarningsListResponse, EarningsRefreshResponse, EarningsStatusResponse } from '@portfolio/shared';
import { request } from './client';

export const earningsApi = {
  list: (params: { symbol?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<EarningsListResponse>('GET', '/earnings', { query: { symbol: params.symbol, limit: params.limit === undefined ? undefined : String(params.limit) }, signal }),
  status: (signal?: AbortSignal) => request<EarningsStatusResponse>('GET', '/earnings/status', { signal }),
  refresh: (symbol: string) => request<EarningsRefreshResponse>('POST', `/earnings/${encodeURIComponent(symbol)}/refresh`),
};
