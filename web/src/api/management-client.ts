import {
  type AddWatchlistRequest,
  type AssignCategoryHoldingsRequest,
  type BackupResponse,
  type Category,
  type CreateCategoryRequest,
  type CreateCustomAssetRequest,
  type CustomAssetWithValue,
  type GetRebalanceResponse,
  type ListAssetsResponse,
  type ListCategoriesResponse,
  type ListWatchlistResponse,
  type PortfolioSettings,
  type PutValuationRequest,
  type RebalanceQuery,
  type UpdateCategoryRequest,
  type UpdateCustomAssetRequest,
  type UpdatePortfolioSettingsRequest,
  type WatchlistItem,
} from '@portfolio/shared';
import { request, requestText, scopeQuery } from './client';

const seg = encodeURIComponent;
const base = (portfolioId: string) => `/portfolios/${seg(portfolioId)}`;

export const managementApi = {
  getSettings: (portfolioId: string, signal?: AbortSignal) => request<PortfolioSettings>('GET', `${base(portfolioId)}/settings`, { signal }),
  updateSettings: (portfolioId: string, body: UpdatePortfolioSettingsRequest) =>
    request<PortfolioSettings>('PUT', `${base(portfolioId)}/settings`, { body }),

  listCategories: (portfolioId: string, signal?: AbortSignal) =>
    request<ListCategoriesResponse>('GET', `${base(portfolioId)}/categories`, { signal }),
  createCategory: (portfolioId: string, body: CreateCategoryRequest) => request<Category>('POST', `${base(portfolioId)}/categories`, { body }),
  updateCategory: (portfolioId: string, categoryId: string, body: UpdateCategoryRequest) =>
    request<Category>('PATCH', `${base(portfolioId)}/categories/${seg(categoryId)}`, { body }),
  deleteCategory: (portfolioId: string, categoryId: string) => request<void>('DELETE', `${base(portfolioId)}/categories/${seg(categoryId)}`),
  assignHoldings: (portfolioId: string, categoryId: string, body: AssignCategoryHoldingsRequest) =>
    request<ListCategoriesResponse>('PUT', `${base(portfolioId)}/categories/${seg(categoryId)}/holdings`, { body }),

  getRebalance: (portfolioId: string, query: RebalanceQuery, signal?: AbortSignal) =>
    request<GetRebalanceResponse>('GET', `${base(portfolioId)}/rebalance`, {
      query: {
        mode: query.mode,
        amount: query.amount === undefined ? undefined : String(query.amount),
        wholeUnits: query.wholeUnits === undefined ? undefined : String(query.wholeUnits),
        minTrade: query.minTrade === undefined ? undefined : String(query.minTrade),
      },
      signal,
    }),

  listAssets: (portfolioId: string, signal?: AbortSignal) => request<ListAssetsResponse>('GET', `${base(portfolioId)}/assets`, { signal }),
  createAsset: (portfolioId: string, body: CreateCustomAssetRequest) => request<CustomAssetWithValue>('POST', `${base(portfolioId)}/assets`, { body }),
  updateAsset: (portfolioId: string, assetId: string, body: UpdateCustomAssetRequest) =>
    request<CustomAssetWithValue>('PATCH', `${base(portfolioId)}/assets/${seg(assetId)}`, { body }),
  deleteAsset: (portfolioId: string, assetId: string) => request<void>('DELETE', `${base(portfolioId)}/assets/${seg(assetId)}`),
  putValuation: (portfolioId: string, assetId: string, body: PutValuationRequest) =>
    request<CustomAssetWithValue>('PUT', `${base(portfolioId)}/assets/${seg(assetId)}/valuations`, { body }),
  deleteValuation: (portfolioId: string, assetId: string, date: string) =>
    request<CustomAssetWithValue>('DELETE', `${base(portfolioId)}/assets/${seg(assetId)}/valuations/${seg(date)}`),

  listWatchlist: (signal?: AbortSignal) => request<ListWatchlistResponse>('GET', '/watchlist', { signal }),
  addWatchlist: (body: AddWatchlistRequest) => request<WatchlistItem>('POST', '/watchlist', { body }),
  removeWatchlist: (symbol: string) => request<void>('DELETE', `/watchlist/${seg(symbol)}`),

  exportTransactionsCsv: async (scope: string, signal?: AbortSignal) =>
    (await requestText('/export/transactions', { accept: 'text/csv', query: scopeQuery(scope), signal })).text,
  exportBackup: () => request<BackupResponse>('GET', '/export/backup'),
};
