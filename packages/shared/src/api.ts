/**
 * REST API contract (API Gateway HTTP API, JSON). All responses are JSON.
 * Errors: { error: { code: string; message: string; details?: unknown } } with 4xx/5xx status.
 * User identity: JWT `sub` claim when an authorizer is configured, otherwise the DEMO_USER_ID.
 *
 * Portfolios:
 * - GET /portfolios creates DEFAULT_PORTFOLIO_ID ("Main portfolio") if the user has none (idempotent).
 * - POST /portfolios: 201; 409 CONFLICT for a duplicate name (case-insensitive); 422 above MAX_PORTFOLIOS.
 * - PATCH /portfolios/{id}: rename, same uniqueness rule; 404 if unknown.
 * - DELETE /portfolios/{id}: 204; 409 PORTFOLIO_NOT_EMPTY when it has transactions unless `?force=true`
 *   (cascades and emits TransactionsChanged reason DELETED); 409 LAST_PORTFOLIO for the only portfolio.
 * - Read endpoints: `?portfolioId=<id>` scopes to one portfolio (404 if unknown); omitted or `all` combines all.
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
