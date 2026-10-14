/** In-memory mock backend that derives every response from transactions using the shared calculators. */
import {
  ALL_PORTFOLIOS,
  CSV_COLUMNS,
  DEFAULT_PORTFOLIO_ID,
  DEFAULT_PORTFOLIO_NAME,
  MAX_PORTFOLIOS,
  PortfolioError,
  applyManagement,
  buildPositions,
  buildValueHistory,
  calculateAllocation,
  calculateDividends,
  calculatePortfolio,
  csvRowSchema,
  historyRangeStart,
  managementHistoryExtra,
  sortTransactions,
  type AllocationDimension,
  type AnalyticsData,
  type GetAllocationResponse,
  type GetDividendsResponse,
  type GetHistoryResponse,
  type GetHoldingsResponse,
  type GetPortfolioResponse,
  type HistoryRange,
  type ImportStatus,
  type Portfolio,
  type Transaction,
  type TransactionInput,
} from '@portfolio/shared';
import { BASE_CURRENCY, MOCK_USER_ID, STALE_SYMBOLS, TRADING_212_ID, TRADING_212_NAME, createSeed, type MockSeed } from './fixtures';
import { deleteManagementData, managementScope, resetManagement } from './management-db';
import { MockHttpError } from './utils';

export { MockHttpError };

interface MockImport {
  status: ImportStatus;
  csv?: string;
  polls: number;
}

interface DbState {
  seed: MockSeed;
  portfolios: Portfolio[];
  transactions: Transaction[];
  imports: Map<string, MockImport>;
  nextId: number;
}

let state: DbState = init();

function seedPortfolio(portfolioId: string, name: string, createdAt: string): Portfolio {
  return { portfolioId, userId: MOCK_USER_ID, name, createdAt, updatedAt: createdAt };
}

function init(options: { empty?: boolean } = {}): DbState {
  const seed = createSeed();
  const first = seed.transactions[0]?.createdAt ?? `${seed.today}T00:00:00.000Z`;
  resetManagement(seed, options);
  return {
    seed,
    portfolios: [
      seedPortfolio(DEFAULT_PORTFOLIO_ID, DEFAULT_PORTFOLIO_NAME, first),
      seedPortfolio(TRADING_212_ID, TRADING_212_NAME, first.replace(/\.\d{3}Z$/, '.001Z')),
    ],
    transactions: options.empty ? [] : [...seed.transactions],
    imports: new Map(),
    nextId: 1,
  };
}

/** Reset to the two demo portfolios (optionally without transactions). Call between tests. */
export function resetDb(options: { empty?: boolean } = {}): void {
  state = init(options);
}

const nowIso = () => new Date().toISOString();

function quotesFor(transactions: readonly Transaction[]) {
  // Unknown symbols (added by the user) get no quote → shared calculator marks them stale at avg cost.
  const quotes = { ...state.seed.quotes };
  for (const t of transactions) if (!(t.symbol in quotes)) delete quotes[t.symbol];
  return quotes;
}

/** `?portfolioId=`: omitted or 'all' = every portfolio combined; unknown ids are a 404. */
export type MockScope = string | undefined;

export function requirePortfolio(portfolioId: string): Portfolio {
  const p = state.portfolios.find((x) => x.portfolioId === portfolioId);
  if (!p) throw new MockHttpError(404, 'NOT_FOUND', `Portfolio ${portfolioId} not found`);
  return p;
}

export function scoped(scope: MockScope): Transaction[] {
  if (scope === undefined || scope === ALL_PORTFOLIOS) return state.transactions;
  requirePortfolio(scope);
  return state.transactions.filter((t) => t.portfolioId === scope);
}

/** Management scope (cash-tracking portfolios, custom assets) for a read scope; 'all' = every portfolio. */
const managementFor = (scope: MockScope) => managementScope(scope === ALL_PORTFOLIOS ? undefined : scope);

/** Holdings and summary of a scope, including cash (when tracked) and custom assets, like the API. */
export function portfolio(scope: MockScope) {
  const transactions = scoped(scope);
  const result = calculatePortfolio({
    transactions,
    quotes: quotesFor(transactions),
    profiles: state.seed.profiles,
    fx: state.seed.fx,
    fxHistory: state.seed.fxHistory,
  });
  for (const h of result.holdings) if (STALE_SYMBOLS.has(h.symbol)) h.priceStale = true;
  const { fx, fxHistory, today } = state.seed;
  return applyManagement(result, { transactions, ...managementFor(scope), fx, fxHistory, today });
}

export const getSeed = (): MockSeed => state.seed;

export const getPortfolio = (scope?: MockScope): GetPortfolioResponse => portfolio(scope).summary;

export const getHoldings = (scope?: MockScope): GetHoldingsResponse => ({ baseCurrency: BASE_CURRENCY, holdings: portfolio(scope).holdings });

export const getAllocation = (by: AllocationDimension, scope?: MockScope): GetAllocationResponse => ({
  by,
  baseCurrency: BASE_CURRENCY,
  slices: calculateAllocation(portfolio(scope).holdings, by),
});

export function getHistory(range: HistoryRange, scope?: MockScope): GetHistoryResponse {
  const sorted = sortTransactions(scoped(scope));
  const today = state.seed.today;
  const from = historyRangeStart(range, today, sorted[0]?.date);
  return {
    range,
    baseCurrency: BASE_CURRENCY,
    points: buildValueHistory(sorted, state.seed.eod, state.seed.fx, from, today, state.seed.fxHistory, managementHistoryExtra({ transactions: sorted, ...managementFor(scope) })),
  };
}

export const getDividends = (scope?: MockScope): GetDividendsResponse =>
  calculateDividends(scoped(scope), state.seed.dividendEvents, state.seed.fx, state.seed.today, state.seed.fxHistory);

/** Everything the shared analytics calculators need, for one scope (see mocks/analyticsHandlers.ts). */
export function getAnalyticsData(scope?: MockScope): AnalyticsData {
  const transactions = scoped(scope);
  const { seed } = state;
  return {
    transactions,
    quotes: quotesFor(transactions),
    profiles: seed.profiles,
    fx: seed.fx,
    fxHistory: seed.fxHistory,
    eod: seed.eod,
    dividendEvents: seed.dividendEvents,
    today: seed.today,
  };
}

export const listTransactions = (scope?: MockScope): Transaction[] => sortTransactions(scoped(scope)).reverse();

function assertConsistent(transactions: readonly Transaction[]) {
  try {
    buildPositions(transactions);
  } catch (err) {
    if (err instanceof PortfolioError) throw new MockHttpError(422, 'INVALID_POSITION', err.message);
    throw err;
  }
}

/**
 * Overselling is checked within the target portfolio only; replaying everything combined additionally
 * enforces one currency per symbol across portfolios (so the combined view can always be computed).
 */
function assertPortfolioConsistent(next: readonly Transaction[], portfolioId: string) {
  assertConsistent(next.filter((t) => t.portfolioId === portfolioId));
  assertConsistent(next);
}

// --- Portfolios -------------------------------------------------------------------------------------

const byCreated = (a: Portfolio, b: Portfolio) => a.createdAt.localeCompare(b.createdAt);

/** Like the API: (re)creates the default portfolio when the user has none. */
export function listPortfolios(): Portfolio[] {
  if (!state.portfolios.length) state.portfolios = [seedPortfolio(DEFAULT_PORTFOLIO_ID, DEFAULT_PORTFOLIO_NAME, nowIso())];
  return [...state.portfolios].sort(byCreated);
}

function assertUniqueName(name: string, exceptId?: string) {
  const lower = name.toLowerCase();
  if (state.portfolios.some((p) => p.portfolioId !== exceptId && p.name.toLowerCase() === lower)) {
    throw new MockHttpError(409, 'CONFLICT', `A portfolio named “${name}” already exists.`);
  }
}

const newPortfolioId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${state.nextId++}`;

export function createPortfolio(name: string): Portfolio {
  if (state.portfolios.length >= MAX_PORTFOLIOS) {
    throw new MockHttpError(422, 'UNPROCESSABLE', `You can have at most ${MAX_PORTFOLIOS} portfolios.`);
  }
  assertUniqueName(name);
  const now = nowIso();
  const p: Portfolio = { portfolioId: newPortfolioId(), userId: MOCK_USER_ID, name, createdAt: now, updatedAt: now };
  state.portfolios = [...state.portfolios, p];
  return p;
}

export function renamePortfolio(portfolioId: string, name: string): Portfolio {
  const existing = requirePortfolio(portfolioId);
  assertUniqueName(name, portfolioId);
  const updated = { ...existing, name, updatedAt: nowIso() };
  state.portfolios = state.portfolios.map((p) => (p.portfolioId === portfolioId ? updated : p));
  return updated;
}

export function deletePortfolio(portfolioId: string, force = false): void {
  const p = requirePortfolio(portfolioId);
  if (state.portfolios.length === 1) {
    throw new MockHttpError(409, 'LAST_PORTFOLIO', 'You cannot delete your only portfolio.');
  }
  const count = state.transactions.filter((t) => t.portfolioId === portfolioId).length;
  if (count > 0 && !force) {
    throw new MockHttpError(409, 'PORTFOLIO_NOT_EMPTY', `Portfolio “${p.name}” still has ${count} transactions.`, { transactionCount: count });
  }
  state.transactions = state.transactions.filter((t) => t.portfolioId !== portfolioId);
  state.portfolios = state.portfolios.filter((x) => x.portfolioId !== portfolioId);
  deleteManagementData(portfolioId);
}

// --- Transactions & imports -------------------------------------------------------------------------

export function addTransaction(input: TransactionInput, importId?: string, rowNumber?: number): Transaction {
  requirePortfolio(input.portfolioId);
  const id = importId ? `${importId}-${rowNumber}` : `mock-${Date.now().toString(36)}-${state.nextId++}`;
  const txn: Transaction = {
    id,
    userId: MOCK_USER_ID,
    ...input,
    ...(input.note ? { note: input.note } : {}),
    ...(importId ? { importId } : {}),
    createdAt: nowIso(),
  };
  if (!input.note) delete txn.note;
  const next = [...state.transactions, txn];
  assertPortfolioConsistent(next, txn.portfolioId);
  state.transactions = next;
  return txn;
}

export function deleteTransaction(id: string): void {
  const txn = state.transactions.find((t) => t.id === id);
  if (!txn) throw new MockHttpError(404, 'NOT_FOUND', `Transaction ${id} not found`);
  const next = state.transactions.filter((t) => t.id !== id);
  assertPortfolioConsistent(next, txn.portfolioId);
  state.transactions = next;
}

export function createImport(fileName: string, portfolioId: string): ImportStatus {
  requirePortfolio(portfolioId);
  const importId = `imp-${Date.now().toString(36)}-${state.nextId++}`;
  const now = nowIso();
  const status: ImportStatus = { importId, userId: MOCK_USER_ID, portfolioId, fileName, status: 'PENDING', createdAt: now, updatedAt: now };
  state.imports.set(importId, { status, polls: 0 });
  return status;
}

export function storeUpload(importId: string, csv: string): void {
  const imp = state.imports.get(importId);
  if (!imp) throw new MockHttpError(404, 'NOT_FOUND', 'Unknown upload');
  imp.csv = csv;
}

/** Simulates the async ingest pipeline: PENDING → PROCESSING (first poll) → COMPLETED/FAILED. */
export function getImport(importId: string): ImportStatus {
  const imp = state.imports.get(importId);
  if (!imp) throw new MockHttpError(404, 'NOT_FOUND', `Import ${importId} not found`);
  if (imp.csv === undefined || imp.status.status === 'COMPLETED' || imp.status.status === 'FAILED') return imp.status;
  imp.polls += 1;
  if (imp.polls === 1) {
    imp.status = { ...imp.status, status: 'PROCESSING', updatedAt: nowIso() };
    return imp.status;
  }
  imp.status = { ...imp.status, ...processCsv(importId, imp.status.portfolioId, imp.csv), updatedAt: nowIso() };
  return imp.status;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseCsv(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parseCsvLine);
}

const REQUIRED = ['date', 'type', 'symbol', 'quantity', 'price', 'fee', 'currency'];
/** Case-insensitive header → schema key (e.g. "FXRATE" → "fxRate"). */
const COLUMN_BY_LOWER = new Map<string, string>(CSV_COLUMNS.map((c) => [c.toLowerCase(), c]));

function processCsv(importId: string, portfolioId: string, csv: string): Partial<ImportStatus> {
  const [header, ...data] = parseCsv(csv);
  const cols = (header ?? []).map((h) => COLUMN_BY_LOWER.get(h.toLowerCase()) ?? h.toLowerCase());
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) {
    return { status: 'FAILED', rowCount: data.length, importedCount: 0, errors: [{ row: 1, message: `Missing column(s): ${missing.join(', ')}` }] };
  }
  const errors: { row: number; message: string }[] = [];
  const parsed: { row: number; input: TransactionInput }[] = [];
  if (!state.portfolios.some((p) => p.portfolioId === portfolioId)) {
    return { status: 'FAILED', rowCount: data.length, importedCount: 0, errors: [{ row: 0, message: 'The target portfolio no longer exists' }] };
  }
  data.forEach((cells, i) => {
    const row = i + 2;
    const obj = Object.fromEntries(cols.map((c, j) => [c, cells[j] ?? '']));
    const res = csvRowSchema.safeParse(obj);
    if (res.success) parsed.push({ row, input: { ...res.data, portfolioId } });
    else
      errors.push({
        row,
        message: res.error.issues.map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`).join('; '),
      });
  });
  if (!errors.length) {
    const incoming = parsed.map(({ row, input }) => ({ ...input, id: `${importId}-${row}`, userId: MOCK_USER_ID, createdAt: nowIso() }));
    try {
      // Oversell check against the target portfolio, currency consistency against everything.
      buildPositions([...state.transactions.filter((t) => t.portfolioId === portfolioId), ...incoming]);
      buildPositions([...state.transactions, ...incoming]);
    } catch (err) {
      if (!(err instanceof PortfolioError)) throw err;
      errors.push({ row: parsed.find((p) => err.message.includes(` ${p.input.symbol} `))?.row ?? 0, message: err.message });
    }
  }
  if (errors.length) return { status: 'FAILED', rowCount: data.length, importedCount: 0, errors };
  for (const { row, input } of parsed) addTransaction(input, importId, row);
  return { status: 'COMPLETED', rowCount: data.length, importedCount: parsed.length, errors: [] };
}
