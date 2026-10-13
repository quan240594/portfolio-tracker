import type {
  AllocationDimension,
  ApiError as ApiErrorBody,
  CreateImportRequest,
  CreateImportResponse,
  CreateTransactionRequest,
  CreateTransactionResponse,
  GetAllocationResponse,
  GetDividendsResponse,
  GetHistoryResponse,
  GetHoldingsResponse,
  GetImportResponse,
  GetPortfolioResponse,
  HistoryRange,
  ListTransactionsResponse,
} from '@portfolio/shared';
import { API_BASE_URL } from '../config';

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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path, opts.query), {
      method,
      headers: { Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiError(res.status, 'INVALID_RESPONSE', 'The server returned an invalid response.');
    }
  }

  if (!res.ok) {
    if (isErrorBody(data)) throw new ApiError(res.status, data.error.code, data.error.message, data.error.details);
    throw new ApiError(res.status, `HTTP_${res.status}`, res.statusText || `Request failed with status ${res.status}`);
  }
  return data as T;
}

export const api = {
  getPortfolio: (signal?: AbortSignal) => request<GetPortfolioResponse>('GET', '/portfolio', { signal }),
  getHoldings: (signal?: AbortSignal) => request<GetHoldingsResponse>('GET', '/holdings', { signal }),
  getAllocation: (by: AllocationDimension, signal?: AbortSignal) =>
    request<GetAllocationResponse>('GET', '/allocation', { query: { by }, signal }),
  getHistory: (range: HistoryRange, signal?: AbortSignal) =>
    request<GetHistoryResponse>('GET', '/history', { query: { range }, signal }),
  getDividends: (signal?: AbortSignal) => request<GetDividendsResponse>('GET', '/dividends', { signal }),
  listTransactions: (signal?: AbortSignal) => request<ListTransactionsResponse>('GET', '/transactions', { signal }),
  createTransaction: (body: CreateTransactionRequest) =>
    request<CreateTransactionResponse>('POST', '/transactions', { body }),
  deleteTransaction: (id: string) => request<void>('DELETE', `/transactions/${encodeURIComponent(id)}`),
  createImport: (body: CreateImportRequest) => request<CreateImportResponse>('POST', '/imports', { body }),
  getImport: (id: string, signal?: AbortSignal) =>
    request<GetImportResponse>('GET', `/imports/${encodeURIComponent(id)}`, { signal }),
};

function readText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsText(blob);
  });
}

/** Upload raw CSV to the presigned S3 URL returned by POST /imports. */
export async function uploadCsv(uploadUrl: string, file: Blob): Promise<void> {
  let body: string;
  try {
    // Send the text (files are capped at 1 MB) so the body is serialised identically across runtimes.
    body = await readText(file);
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
