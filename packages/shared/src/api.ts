/**
 * REST API contract (API Gateway HTTP API, JSON). All responses are JSON.
 * Errors: { error: { code: string; message: string; details?: unknown } } with 4xx/5xx status.
 * User identity: JWT `sub` claim when an authorizer is configured, otherwise the DEMO_USER_ID.
 */
import type {
  AllocationDimension,
  AllocationSlice,
  DividendOverview,
  Holding,
  ImportStatus,
  PortfolioSummary,
  Transaction,
  ValuePoint,
} from './types.js';
import type { HistoryRange, TransactionInput } from './schemas.js';

export const DEMO_USER_ID = 'demo';

export const API_ROUTES = {
  health: 'GET /health',
  portfolio: 'GET /portfolio',
  holdings: 'GET /holdings',
  allocation: 'GET /allocation',
  history: 'GET /history',
  dividends: 'GET /dividends',
  listTransactions: 'GET /transactions',
  createTransaction: 'POST /transactions',
  deleteTransaction: 'DELETE /transactions/{id}',
  createImport: 'POST /imports',
  getImport: 'GET /imports/{id}',
} as const;

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export type GetPortfolioResponse = PortfolioSummary;
export type GetHoldingsResponse = { baseCurrency: string; holdings: Holding[] };
export type GetAllocationRequest = { by?: AllocationDimension };
export type GetAllocationResponse = { by: AllocationDimension; baseCurrency: string; slices: AllocationSlice[] };
export type GetHistoryRequest = { range?: HistoryRange };
export type GetHistoryResponse = { range: HistoryRange; baseCurrency: string; points: ValuePoint[] };
export type GetDividendsResponse = DividendOverview;
export type ListTransactionsResponse = { transactions: Transaction[] };
export type CreateTransactionRequest = TransactionInput;
export type CreateTransactionResponse = Transaction;
export type CreateImportRequest = { fileName: string };
/** Client PUTs the raw CSV to uploadUrl with header Content-Type: text/csv. */
export type CreateImportResponse = { importId: string; uploadUrl: string; expiresInSeconds: number };
export type GetImportResponse = ImportStatus;
