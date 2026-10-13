import { buildPositions, parseImportObjectKey, PortfolioError, importObjectKey, type Transaction } from '@portfolio/shared';
import { MAX_ERRORS, parseImportCsv, type ParsedRow, type RowError } from './csv.js';
import type { EventPublisher } from './events.js';
import { logger } from './logger.js';
import type { S3ObjectRef } from './messages.js';
import { MAX_OBJECT_BYTES, type ObjectReader } from './objects.js';
import type { IngestStore } from './store.js';

export interface IngestDeps {
  store: IngestStore;
  reader: ObjectReader;
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

/** Maps an oversell PortfolioError ("Cannot sell Q SYM on DATE: ...") back to the offending CSV row, if it came from this file. */
function rowForPortfolioError(err: PortfolioError, rows: ParsedRow[]): number {
  const m = /^Cannot sell (\S+) (\S+) on (\d{4}-\d{2}-\d{2})/.exec(err.message);
  if (m) {
    const [, qty, symbol, date] = m;
    const hit = rows.find((r) => r.input.type === 'SELL' && r.input.symbol === symbol && r.input.date === date && String(r.input.quantity) === qty);
    if (hit) return hit.row;
  }
  const mixed = /^Mixed currencies for (\S+): \S+ and (\S+)/.exec(err.message);
  if (mixed) {
    const [, symbol, offending] = mixed;
    // Prefer the row carrying the conflicting currency; fall back to any row of the symbol.
    const hit =
      rows.find((r) => r.input.symbol === symbol && r.input.currency === offending) ?? rows.find((r) => r.input.symbol === symbol);
    if (hit) return hit.row;
  }
  return 0;
}

/**
 * Processes one uploaded CSV. Domain problems (bad rows, oversell, too large, missing file) mark the import FAILED
 * and resolve normally; infrastructure errors are thrown so the SQS message is retried.
 */
export async function processImportObject(deps: IngestDeps, ref: S3ObjectRef): Promise<ProcessOutcome> {
  const parsedKey = safeParseKey(ref.key);
  if (!parsedKey) {
    logger.info('Ignoring object outside the imports/ layout', { key: ref.key });
    return 'IGNORED';
  }
  const { userId, importId } = parsedKey;
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

  const file = await deps.reader.readText(ref.bucket, importObjectKey(userId, importId), MAX_OBJECT_BYTES);
  if (!file.ok) return fail(0, [{ row: 0, message: file.reason }]);

  const parsed = parseImportCsv(file.content);
  if (!parsed.ok) return fail(parsed.rowCount, parsed.errors);

  const baseMs = deps.now().getTime();
  const imported: Transaction[] = parsed.rows.map(({ row, input }) => {
    const t: Transaction = {
      id: `${importId}-${row}`,
      userId,
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
  try {
    buildPositions([...current, ...imported]);
  } catch (err) {
    if (err instanceof PortfolioError) {
      return fail(parsed.rowCount, [{ row: rowForPortfolioError(err, parsed.rows), message: err.message }]);
    }
    throw err;
  }

  await deps.store.putTransactions(imported);
  await deps.store.registerUser(userId);
  const tickers = new Map(imported.map((t) => [t.symbol, t.currency]));
  await deps.store.trackTickers([...tickers].map(([symbol, currency]) => ({ symbol, currency })));
  await deps.events.transactionsChanged({ userId, symbols: [...tickers.keys()].sort(), reason: 'IMPORTED', importId });
  await deps.store.markCompleted(userId, importId, parsed.rowCount, imported.length);
  log.info('Import completed', { rowCount: parsed.rowCount, importedCount: imported.length });
  return 'COMPLETED';
}
