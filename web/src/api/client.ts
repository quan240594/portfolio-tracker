import {
  ALL_PORTFOLIOS,
  type AllocationDimension,
  type CategoryAllocationResponse,
  type ApiError as ApiErrorBody,
  type CreateImportRequest,
  type CreateImportResponse,
  type CreateTransactionRequest,
  type CreateTransactionResponse,
  type GetAllocationResponse,
  type GetDividendsResponse,
  type GetHistoryResponse,
  type GetHoldingsResponse,
  type GetImportResponse,
  type GetPortfolioResponse,
  type HistoryRange,
  type ListPortfoliosResponse,
  type ListTransactionsResponse,
  type PortfolioResponse,
} from '@portfolio/shared';
import { API_BASE_URL } from '../config';
import { authorizationHeaders, notifyUnauthorized } from '../features/auth/tokenHooks';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const isErrorBody = (v: unknown): v is ApiErrorBody =>
  typeof v === 'object' &&
  v !== null &&
  'error' in v &&
  typeof (v as ApiErrorBody).error === 'object' &&
  (v as ApiErrorBody).error !== null &&
  typeof (v as ApiErrorBody).error.message === 'string';

/** Resolves against the page origin so relative bases like "/api" work in browsers and jsdom alike. */
export function apiUrl(path: string, query?: Record<string, string | undefined>): string {
  const base = API_BASE_URL.startsWith('http') ? API_BASE_URL : `${globalThis.location?.origin ?? 'http://localhost'}${API_BASE_URL}`;
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path, opts.query), {
      method,
      headers: {
        Accept: 'application/json',
        ...(await authorizationHeaders()),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const data = await parseBody(res);

  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) throw toApiError(res, data);
  return data as T;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    if (res.ok) throw new ApiError(res.status, 'INVALID_RESPONSE', 'The server returned an invalid response.');
    return undefined;
  }
}

function toApiError(res: Response, data: unknown): ApiError {
  if (isErrorBody(data)) return new ApiError(res.status, data.error.code, data.error.message, data.error.details);
  return new ApiError(res.status, `HTTP_${res.status}`, res.statusText || `Request failed with status ${res.status}`);
}

/** `?portfolioId=` for one portfolio; omitted for the combined view. `scope` is 'all' (ALL_PORTFOLIOS) or a portfolio id. */
export const scopeQuery = (scope: string) => (scope === ALL_PORTFOLIOS ? {} : { portfolioId: scope });

export const api = {
  listPortfolios: (signal?: AbortSignal) => request<ListPortfoliosResponse>('GET', '/portfolios', { signal }),
  createPortfolio: (name: string) => request<PortfolioResponse>('POST', '/portfolios', { body: { name } }),
  renamePortfolio: (id: string, name: string) =>
    request<PortfolioResponse>('PATCH', `/portfolios/${encodeURIComponent(id)}`, { body: { name } }),
  deletePortfolio: (id: string, force = false) =>
    request<void>('DELETE', `/portfolios/${encodeURIComponent(id)}`, { query: force ? { force: 'true' } : undefined }),
  getPortfolio: (scope: string, signal?: AbortSignal) =>
    request<GetPortfolioResponse>('GET', '/portfolio', { query: scopeQuery(scope), signal }),
  getHoldings: (scope: string, signal?: AbortSignal) =>
    request<GetHoldingsResponse>('GET', '/holdings', { query: scopeQuery(scope), signal }),
  getAllocation: (scope: string, by: AllocationDimension | 'category', signal?: AbortSignal) =>
    request<GetAllocationResponse | CategoryAllocationResponse>('GET', '/allocation', { query: { ...scopeQuery(scope), by }, signal }),
  getHistory: (scope: string, range: HistoryRange, signal?: AbortSignal) =>
    request<GetHistoryResponse>('GET', '/history', { query: { ...scopeQuery(scope), range }, signal }),
  getDividends: (scope: string, signal?: AbortSignal) =>
    request<GetDividendsResponse>('GET', '/dividends', { query: scopeQuery(scope), signal }),
  listTransactions: (scope: string, signal?: AbortSignal) =>
    request<ListTransactionsResponse>('GET', '/transactions', { query: scopeQuery(scope), signal }),
  createTransaction: (body: CreateTransactionRequest) =>
    request<CreateTransactionResponse>('POST', '/transactions', { body }),
  deleteTransaction: (id: string) => request<void>('DELETE', `/transactions/${encodeURIComponent(id)}`),
  createImport: (body: CreateImportRequest) => request<CreateImportResponse>('POST', '/imports', { body }),
  getImport: (id: string, signal?: AbortSignal) =>
    request<GetImportResponse>('GET', `/imports/${encodeURIComponent(id)}`, { signal }),
};

/** Upload raw CSV to the presigned S3 URL returned by POST /imports. */
export async function uploadCsv(uploadUrl: string, file: Blob): Promise<void> {
  let body: string;
  try {
    // Send the text (files are capped at 1 MB) so the body is serialised identically across runtimes.
    body = await file.text();
  } catch {
    throw new ApiError(0, 'FILE_READ_FAILED', 'The selected file could not be read.');
  }
  let res: Response;
  try {
    res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body });
  } catch {
    throw new ApiError(0, 'UPLOAD_FAILED', 'Uploading the file failed. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `Uploading the file failed (HTTP ${res.status}).`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
