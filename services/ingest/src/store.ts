import {
  cond,
  listTransactions,
  putTransactions,
  registerUser,
  trackTickers,
  type ItemStore,
} from '@portfolio/platform';
import { fromItem, keys, type ImportStatus, type Transaction } from '@portfolio/shared';

export interface IngestStore {
  getImport(userId: string, importId: string): Promise<ImportStatus | null>;
  /** PENDING|PROCESSING -> PROCESSING. Returns false when the import is already terminal. */
  markProcessing(userId: string, importId: string): Promise<boolean>;
  markFailed(userId: string, importId: string, rowCount: number, errors: { row: number; message: string }[]): Promise<void>;
  markCompleted(userId: string, importId: string, rowCount: number, importedCount: number): Promise<void>;
  portfolioExists(userId: string, portfolioId: string): Promise<boolean>;
  /** Transactions of every portfolio of the user. */
  listTransactions(userId: string): Promise<Transaction[]>;
  putTransactions(txns: Transaction[]): Promise<void>;
  registerUser(userId: string): Promise<void>;
  trackTickers(tickers: { symbol: string; currency: string }[]): Promise<void>;
}

/** IngestStore on an ItemStore: the import status machine and the transaction writes of the ingestion job. */
export class ItemIngestStore implements IngestStore {
  constructor(private readonly store: ItemStore) {}

  async getImport(userId: string, importId: string): Promise<ImportStatus | null> {
    const item = await this.store.get(keys.import(userId, importId), { consistent: true });
    return item ? fromItem<ImportStatus>(item) : null;
  }

  async markProcessing(userId: string, importId: string): Promise<boolean> {
    const updated = await this.store.update(
      keys.import(userId, importId),
      { set: { status: 'PROCESSING', updatedAt: new Date().toISOString() } },
      { condition: cond.and(cond.exists, cond.oneOf('status', ['PENDING', 'PROCESSING'])) },
    );
    return updated !== undefined;
  }

  async markFailed(userId: string, importId: string, rowCount: number, errors: { row: number; message: string }[]): Promise<void> {
    await this.store.update(keys.import(userId, importId), {
      set: { status: 'FAILED', rowCount, importedCount: 0, errors, updatedAt: new Date().toISOString() },
    });
  }

  async markCompleted(userId: string, importId: string, rowCount: number, importedCount: number): Promise<void> {
    await this.store.update(keys.import(userId, importId), {
      set: { status: 'COMPLETED', rowCount, importedCount, updatedAt: new Date().toISOString() },
      remove: ['errors'],
    });
  }

  async portfolioExists(userId: string, portfolioId: string): Promise<boolean> {
    return (await this.store.get(keys.portfolio(userId, portfolioId), { consistent: true })) !== undefined;
  }

  listTransactions(userId: string): Promise<Transaction[]> {
    return listTransactions(this.store, userId);
  }

  /**
   * Chunked, retried writes of the store; puts are idempotent (deterministic keys). The first failure stops the import,
   * which is redelivered as a whole.
   */
  putTransactions(txns: Transaction[]): Promise<void> {
    return putTransactions(this.store, txns);
  }

  registerUser(userId: string): Promise<void> {
    return registerUser(this.store, userId, new Date().toISOString());
  }

  trackTickers(tickers: { symbol: string; currency: string }[]): Promise<void> {
    return trackTickers(this.store, tickers, new Date().toISOString());
  }
}
