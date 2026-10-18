import { logger, runToCompletion, type EventPublisher, type FileStore, type JobHandler, type JobPayloads } from '@portfolio/platform';
import { buildPositions, isMarketSymbol, parseImportObjectKey, PortfolioError, importObjectKey, type Transaction } from '@portfolio/shared';
import { MAX_ERRORS, parseImportCsv, type ParsedRow, type RowError } from './csv.js';
import type { S3ObjectRef } from './messages.js';
import type { IngestStore } from './store.js';

/** Largest CSV the ingestion reads. */
export const MAX_OBJECT_BYTES = 1024 * 1024;

export interface IngestDeps {
  store: IngestStore;
  /** Where the uploaded CSV files live. */
  files: FileStore;
  events: EventPublisher;
  now: () => Date;
}

export type ProcessOutcome = 'IGNORED' | 'NOT_FOUND' | 'ALREADY_DONE' | 'FAILED' | 'COMPLETED';

const safeParseKey = (key: string) => {
  try {
    return parseImportObjectKey(key);
  } catch {
    return null; // malformed percent-encoding
  }
};

/** The user owning an uploaded object, or null when the key is outside the imports/ layout. */
export const importOwner = (key: string): string | null => safeParseKey(key)?.userId ?? null;

/**
 * Maps an oversell or invalid-split PortfolioError ("Cannot sell Q SYM on DATE: ..." / "Cannot split SYM on DATE: ...")
 * back to the offending CSV row, if it came from this file. Anything else (a later stored sell, or mixed currencies
 * already present in stored data, since the file's own currencies are checked beforehand) is a file-level error (row 0).
 */
function rowForPortfolioError(err: PortfolioError, rows: ParsedRow[]): number {
  const sell = /^Cannot sell (\S+) (\S+) on (\d{4}-\d{2}-\d{2})/.exec(err.message);
  if (sell) {
    const [, qty, symbol, date] = sell;
    const hit = rows.find((r) => r.input.type === 'SELL' && r.input.symbol === symbol && r.input.date === date && String(r.input.quantity) === qty);
    if (hit) return hit.row;
  }
  const split = /^Cannot split (\S+) on (\d{4}-\d{2}-\d{2})/.exec(err.message);
  if (split) {
    const hit = rows.find((r) => r.input.type === 'SPLIT' && r.input.symbol === split[1] && r.input.date === split[2]);
    if (hit) return hit.row;
  }
  return 0;
}

/**
 * A symbol must use the same currency in every portfolio of the user (same rule as the API). Returns the
 * first imported row that breaks it, checked against all stored transactions and the earlier rows of the file.
 */
function currencyConflict(existing: readonly Transaction[], rows: ParsedRow[]): RowError | null {
  const currencies = new Map<string, string>();
  for (const t of existing) if (!currencies.has(t.symbol)) currencies.set(t.symbol, t.currency);
  for (const { row, input } of rows) {
    const known = currencies.get(input.symbol);
    if (known === undefined) currencies.set(input.symbol, input.currency);
    else if (known !== input.currency) return { row, message: `Mixed currencies for ${input.symbol}: ${known} and ${input.currency}` };
  }
  return null;
}

/**
 * Processes the upload of an S3 object (AWS: one S3 event of the ingest queue) by running the `importUploaded` job; objects
 * outside `imports/` are ignored.
 */
export function processImportObject(deps: IngestDeps, ref: S3ObjectRef): Promise<ProcessOutcome> {
  const parsedKey = safeParseKey(ref.key);
  if (!parsedKey) {
    logger.info('Ignoring object outside the imports/ layout', { key: ref.key });
    return Promise.resolve('IGNORED');
  }
  return runToCompletion(importUploadedJob(deps), parsedKey);
}

/** The `importUploaded` job: one step, idempotent (a finished import is acknowledged, a half-written one is redone). */
export function importUploadedJob(deps: IngestDeps): JobHandler<JobPayloads['importUploaded'], ProcessOutcome> {
  return async ({ payload }) => ({ done: true, result: await processImport(deps, payload) });
}

/**
 * Processes one uploaded CSV. Domain problems (bad rows, oversell, too large, missing file) mark the import FAILED
 * and resolve normally; infrastructure errors are thrown so the message is retried.
 */
export async function processImport(deps: IngestDeps, { userId, importId }: { userId: string; importId: string }): Promise<ProcessOutcome> {
  const log = logger.createChild({ persistentKeys: { userId, importId } });

  const existing = await deps.store.getImport(userId, importId);
  if (!existing) {
    log.warn('No IMPORT item for uploaded object; ignoring');
    return 'NOT_FOUND';
  }
  if (existing.status === 'COMPLETED' || existing.status === 'FAILED') {
    log.info('Import already processed; acknowledging duplicate delivery', { status: existing.status });
    return 'ALREADY_DONE';
  }
  if (!(await deps.store.markProcessing(userId, importId))) {
    log.info('Import reached a terminal state concurrently; acknowledging');
    return 'ALREADY_DONE';
  }

  const fail = async (rowCount: number, errors: RowError[]): Promise<ProcessOutcome> => {
    await deps.store.markFailed(userId, importId, rowCount, errors.slice(0, MAX_ERRORS));
    log.warn('Import failed validation', { rowCount, errorCount: errors.length });
    return 'FAILED';
  };

  const { portfolioId } = existing;
  if (!portfolioId) return fail(0, [{ row: 0, message: 'Import has no target portfolio' }]);
  if (!(await deps.store.portfolioExists(userId, portfolioId))) {
    return fail(0, [{ row: 0, message: `Portfolio ${portfolioId} not found` }]);
  }

  const file = await deps.files.readText(importObjectKey(userId, importId), MAX_OBJECT_BYTES);
  if (!file.ok) return fail(0, [{ row: 0, message: file.reason }]);

  const parsed = parseImportCsv(file.content);
  if (!parsed.ok) return fail(parsed.rowCount, parsed.errors);

  const baseMs = deps.now().getTime();
  const imported: Transaction[] = parsed.rows.map(({ row, input }) => {
    const t: Transaction = {
      id: `${importId}-${row}`,
      userId,
      portfolioId,
      ...input,
      importId,
      // Row-ordered timestamps keep same-day transactions in file order when replayed.
      createdAt: new Date(baseMs + row).toISOString(),
    };
    if (t.note === undefined) delete t.note;
    if (t.fxRate === undefined) delete t.fxRate;
    return t;
  });

  // On redelivery, rows of this import may already be stored; exclude them so they are not double-counted.
  const current = (await deps.store.listTransactions(userId)).filter((t) => t.importId !== importId);
  const conflict = currencyConflict(current, parsed.rows);
  if (conflict) return fail(parsed.rowCount, [conflict]);
  try {
    // Overselling is validated against the target portfolio only.
    buildPositions([...current.filter((t) => t.portfolioId === portfolioId), ...imported]);
  } catch (err) {
    if (err instanceof PortfolioError) {
      return fail(parsed.rowCount, [{ row: rowForPortfolioError(err, parsed.rows), message: err.message }]);
    }
    throw err;
  }

  await deps.store.putTransactions(imported);
  await deps.store.registerUser(userId);
  // Cash (CASH.*) rows have no price feed: only market symbols are tracked and announced for enrichment.
  const tickers = new Map(imported.filter((t) => isMarketSymbol(t.symbol)).map((t) => [t.symbol, t.currency]));
  await deps.store.trackTickers([...tickers].map(([symbol, currency]) => ({ symbol, currency })));
  if (tickers.size > 0) {
    await deps.events.transactionsChanged({
      userId,
      portfolioId,
      symbols: [...tickers.keys()].sort((a, b) => a.localeCompare(b)),
      reason: 'IMPORTED',
      importId,
    });
  }
  await deps.store.markCompleted(userId, importId, parsed.rowCount, imported.length);
  log.info('Import completed', { portfolioId, rowCount: parsed.rowCount, importedCount: imported.length });
  return 'COMPLETED';
}
