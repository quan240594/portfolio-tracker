/**
 * REST API contract (API Gateway HTTP API, JSON). All responses are JSON.
 * Errors: { error: { code: string; message: string; details?: unknown } } with 4xx/5xx status.
 * User identity: the JWT `sub` claim of the API Gateway authorizer (AUTH_MODE=cognito; 401 UNAUTHENTICATED without
 * it). AUTH_MODE=demo (local dev/tests only) falls back to the DEMO_USER_ID.
 *
 * Portfolios:
 * - GET /portfolios creates DEFAULT_PORTFOLIO_ID ("Main portfolio") if the user has none (idempotent).
 * - POST /portfolios: 201; 409 CONFLICT for a duplicate name (case-insensitive); 422 UNPROCESSABLE above MAX_PORTFOLIOS.
 * - PATCH /portfolios/{id}: rename, same uniqueness rule; 404 if unknown.
 * - DELETE /portfolios/{id}: 204; 409 LAST_PORTFOLIO for the only portfolio (checked first, even with
 *   `force=true`); else 409 PORTFOLIO_NOT_EMPTY with `details.transactionCount` when it has transactions
 *   unless `?force=true` (cascades and emits TransactionsChanged reason DELETED). Imports still pending for a
 *   deleted portfolio end FAILED (row 0).
 * - Read endpoints: `?portfolioId=<id>` scopes to one portfolio (404 if unknown); omitted or `all` combines all.
 * - `all` is reserved (ALL_PORTFOLIOS) and is never a portfolio id.
 * - Writes (POST /transactions, POST /imports) to an unknown portfolio: 404 NOT_FOUND.
 * - Writes (POST /transactions, imports) target exactly one portfolio and validate overselling against that
 *   portfolio only. A symbol must use the same currency in every portfolio of the user (422 otherwise), so
 *   the combined view can always be computed.
 */
import type {
  AllocationDimension,
  AllocationSlice,
  DividendOverview,
  Holding,
  ImportStatus,
  Portfolio,
  PortfolioSummary,
  Transaction,
  ValuePoint,
} from './types.js';
import type { HistoryRange, TransactionInput } from './schemas.js';

export const DEMO_USER_ID = 'demo';
/** Id of the portfolio created automatically for every user. */
export const DEFAULT_PORTFOLIO_ID = 'default';
export const DEFAULT_PORTFOLIO_NAME = 'Main portfolio';
export const MAX_PORTFOLIOS = 20;
/** Portfolio base currency: every monetary value in API responses (unless suffixed `Local`) is in it. */
export const DEFAULT_BASE_CURRENCY = 'EUR';

export const API_ROUTES = {
  health: 'GET /health',
  listPortfolios: 'GET /portfolios',
  createPortfolio: 'POST /portfolios',
  updatePortfolio: 'PATCH /portfolios/{id}',
  deletePortfolio: 'DELETE /portfolios/{id}',
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

/** Read endpoints (/portfolio, /holdings, /allocation, /history, /dividends, /transactions) accept `?portfolioId=`. */
export type PortfolioScope = { portfolioId?: string };
/** Ensures DEFAULT_PORTFOLIO_ID exists; sorted by createdAt. */
export type ListPortfoliosResponse = { portfolios: Portfolio[] };
export type CreatePortfolioRequest = { name: string };
export type UpdatePortfolioRequest = { name: string };
export type PortfolioResponse = Portfolio;
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
export type CreateImportRequest = { fileName: string; portfolioId: string };
/** Client PUTs the raw CSV to uploadUrl with header Content-Type: text/csv. */
export type CreateImportResponse = { importId: string; uploadUrl: string; expiresInSeconds: number };
export type GetImportResponse = ImportStatus;
