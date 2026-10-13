/** In-memory mock backend that derives every response from transactions using the shared calculators. */
import {
  CSV_COLUMNS,
  PortfolioError,
  buildPositions,
  buildValueHistory,
  calculateAllocation,
  calculateDividends,
  calculatePortfolio,
  csvRowSchema,
  historyRangeStart,
  sortTransactions,
  type AllocationDimension,
  type GetAllocationResponse,
  type GetDividendsResponse,
  type GetHistoryResponse,
  type GetHoldingsResponse,
  type GetPortfolioResponse,
  type HistoryRange,
  type ImportStatus,
  type Transaction,
  type TransactionInput,
} from '@portfolio/shared';
import { BASE_CURRENCY, MOCK_USER_ID, STALE_SYMBOLS, createSeed, type MockSeed } from './fixtures';

interface MockImport {
  status: ImportStatus;
  csv?: string;
  polls: number;
}

interface DbState {
  seed: MockSeed;
  transactions: Transaction[];
  imports: Map<string, MockImport>;
  nextId: number;
}

let state: DbState = init();

function init(options: { empty?: boolean } = {}): DbState {
  const seed = createSeed();
  return {
    seed,
    transactions: options.empty ? [] : [...seed.transactions],
    imports: new Map(),
    nextId: 1,
  };
}

/** Reset to the default demo portfolio (or an empty one). Call between tests. */
export function resetDb(options: { empty?: boolean } = {}): void {
  state = init(options);
}

export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const nowIso = () => new Date().toISOString();

function quotesFor(transactions: readonly Transaction[]) {
  // Unknown symbols (added by the user) get no quote → shared calculator marks them stale at avg cost.
  const quotes = { ...state.seed.quotes };
  for (const t of transactions) if (!(t.symbol in quotes)) delete quotes[t.symbol];
  return quotes;
}

function portfolio() {
  const result = calculatePortfolio({
    transactions: state.transactions,
    quotes: quotesFor(state.transactions),
    profiles: state.seed.profiles,
    fx: state.seed.fx,
    fxHistory: state.seed.fxHistory,
  });
  for (const h of result.holdings) if (STALE_SYMBOLS.has(h.symbol)) h.priceStale = true;
  return result;
}

export const getPortfolio = (): GetPortfolioResponse => portfolio().summary;

export const getHoldings = (): GetHoldingsResponse => ({ baseCurrency: BASE_CURRENCY, holdings: portfolio().holdings });

export const getAllocation = (by: AllocationDimension): GetAllocationResponse => ({
  by,
  baseCurrency: BASE_CURRENCY,
  slices: calculateAllocation(portfolio().holdings, by),
});

export function getHistory(range: HistoryRange): GetHistoryResponse {
  const sorted = sortTransactions(state.transactions);
  const today = state.seed.today;
  const from = historyRangeStart(range, today, sorted[0]?.date);
  return {
    range,
    baseCurrency: BASE_CURRENCY,
    points: buildValueHistory(sorted, state.seed.eod, state.seed.fx, from, today, state.seed.fxHistory),
  };
}

export const getDividends = (): GetDividendsResponse =>
  calculateDividends(state.transactions, state.seed.dividendEvents, state.seed.fx, state.seed.today, state.seed.fxHistory);

export const listTransactions = (): Transaction[] =>
  sortTransactions(state.transactions).reverse();

function assertConsistent(transactions: readonly Transaction[]) {
  try {
    buildPositions(transactions);
  } catch (err) {
    if (err instanceof PortfolioError) throw new MockHttpError(422, 'INVALID_POSITION', err.message);
    throw err;
  }
}

export function addTransaction(input: TransactionInput, importId?: string, rowNumber?: number): Transaction {
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
  assertConsistent(next);
  state.transactions = next;
  return txn;
}

export function deleteTransaction(id: string): void {
  if (!state.transactions.some((t) => t.id === id)) throw new MockHttpError(404, 'NOT_FOUND', `Transaction ${id} not found`);
  const next = state.transactions.filter((t) => t.id !== id);
  assertConsistent(next);
  state.transactions = next;
}

export function createImport(fileName: string): ImportStatus {
  const importId = `imp-${Date.now().toString(36)}-${state.nextId++}`;
  const now = nowIso();
  const status: ImportStatus = { importId, userId: MOCK_USER_ID, fileName, status: 'PENDING', createdAt: now, updatedAt: now };
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
  imp.status = { ...imp.status, ...processCsv(importId, imp.csv), updatedAt: nowIso() };
  return imp.status;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
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
    rows.push(cells);
  }
  return rows;
}

const REQUIRED = ['date', 'type', 'symbol', 'quantity', 'price', 'fee', 'currency'];
/** Case-insensitive header → schema key (e.g. "FXRATE" → "fxRate"). */
const COLUMN_BY_LOWER = new Map<string, string>(CSV_COLUMNS.map((c) => [c.toLowerCase(), c]));

function processCsv(importId: string, csv: string): Partial<ImportStatus> {
  const [header, ...data] = parseCsv(csv);
  const cols = (header ?? []).map((h) => COLUMN_BY_LOWER.get(h.toLowerCase()) ?? h.toLowerCase());
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) {
    return { status: 'FAILED', rowCount: data.length, importedCount: 0, errors: [{ row: 1, message: `Missing column(s): ${missing.join(', ')}` }] };
  }
  const errors: { row: number; message: string }[] = [];
  const parsed: { row: number; input: TransactionInput }[] = [];
  data.forEach((cells, i) => {
    const row = i + 2;
    const obj = Object.fromEntries(cols.map((c, j) => [c, cells[j] ?? '']));
    const res = csvRowSchema.safeParse(obj);
    if (res.success) parsed.push({ row, input: res.data });
    else
      errors.push({
        row,
        message: res.error.issues.map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`).join('; '),
      });
  });
  if (!errors.length) {
    try {
      buildPositions([
        ...state.transactions,
        ...parsed.map(({ row, input }) => ({ ...input, id: `${importId}-${row}`, userId: MOCK_USER_ID, createdAt: nowIso() })),
      ]);
    } catch (err) {
      if (!(err instanceof PortfolioError)) throw err;
      errors.push({ row: parsed.find((p) => err.message.includes(` ${p.input.symbol} `))?.row ?? 0, message: err.message });
    }
  }
  if (errors.length) return { status: 'FAILED', rowCount: data.length, importedCount: 0, errors };
  for (const { row, input } of parsed) addTransaction(input, importId, row);
  return { status: 'COMPLETED', rowCount: data.length, importedCount: parsed.length, errors: [] };
}
