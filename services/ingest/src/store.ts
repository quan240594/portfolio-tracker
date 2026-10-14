import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ENTITY, keys, type ImportStatus, type Transaction } from '@portfolio/shared';
import { drain, paginate, retryAttempts, sequentially } from './async.js';

export interface IngestStore {
  getImport(userId: string, importId: string): Promise<ImportStatus | null>;
  /** PENDING|PROCESSING -> PROCESSING. Returns false when the import is already terminal. */
  markProcessing(userId: string, importId: string): Promise<boolean>;
  markFailed(userId: string, importId: string, rowCount: number, errors: { row: number; message: string }[]): Promise<void>;
  markCompleted(userId: string, importId: string, rowCount: number, importedCount: number): Promise<void>;
  listTransactions(userId: string): Promise<Transaction[]>;
  putTransactions(txns: Transaction[]): Promise<void>;
  registerUser(userId: string): Promise<void>;
  trackTickers(tickers: { symbol: string; currency: string }[]): Promise<void>;
}

const KEY_ATTRS = new Set(['PK', 'SK', 'entityType']);
const fromItem = <T>(item: Record<string, unknown>): T =>
  Object.fromEntries(Object.entries(item).filter(([k]) => !KEY_ATTRS.has(k))) as T;

/** Uniform float in [0, 1) from the CSPRNG; used for backoff jitter. */
const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

export const BATCH_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 8;

export class DynamoIngestStore implements IngestStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly random: () => number = secureRandom,
  ) {}

  async getImport(userId: string, importId: string): Promise<ImportStatus | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.import(userId, importId), ConsistentRead: true }),
    );
    return res.Item ? fromItem<ImportStatus>(res.Item) : null;
  }

  async markProcessing(userId: string, importId: string): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.import(userId, importId),
          UpdateExpression: 'SET #s = :processing, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND #s IN (:pending, :processing)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':processing': 'PROCESSING', ':pending': 'PENDING', ':now': new Date().toISOString() },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || (err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async markFailed(userId: string, importId: string, rowCount: number, errors: { row: number; message: string }[]): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.import(userId, importId),
        UpdateExpression: 'SET #s = :failed, rowCount = :rc, importedCount = :zero, #e = :errors, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status', '#e': 'errors' },
        ExpressionAttributeValues: { ':failed': 'FAILED', ':rc': rowCount, ':zero': 0, ':errors': errors, ':now': new Date().toISOString() },
      }),
    );
  }

  async markCompleted(userId: string, importId: string, rowCount: number, importedCount: number): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.import(userId, importId),
        UpdateExpression: 'SET #s = :completed, rowCount = :rc, importedCount = :ic, updatedAt = :now REMOVE #e',
        ExpressionAttributeNames: { '#s': 'status', '#e': 'errors' },
        ExpressionAttributeValues: { ':completed': 'COMPLETED', ':rc': rowCount, ':ic': importedCount, ':now': new Date().toISOString() },
      }),
    );
  }

  async listTransactions(userId: string): Promise<Transaction[]> {
    const pages = paginate<Record<string, unknown>[], Record<string, unknown>>(async (ExclusiveStartKey) => {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': keys.user(userId).PK, ':sk': keys.transactionPrefix },
          ExclusiveStartKey,
        }),
      );
      return { page: res.Items ?? [], next: res.LastEvaluatedKey };
    });
    const out: Transaction[] = [];
    for await (const items of pages) out.push(...items.map((i) => fromItem<Transaction>(i)));
    return out;
  }

  /**
   * BatchWrite in chunks of 25, retrying UnprocessedItems with exponential backoff. Puts are idempotent (deterministic keys).
   * Chunks are written one at a time so throttling is absorbed by the per-chunk backoff and the first failure stops the import.
   */
  async putTransactions(txns: Transaction[]): Promise<void> {
    const chunks: unknown[][] = [];
    for (let i = 0; i < txns.length; i += BATCH_SIZE) {
      chunks.push(
        txns.slice(i, i + BATCH_SIZE).map((t) => ({
          PutRequest: { Item: { ...keys.transaction(t.userId, t.date, t.id), entityType: ENTITY.transaction, ...t } },
        })),
      );
    }
    await drain(sequentially(chunks, (items) => this.writeBatch(items)));
  }

  private async writeBatch(items: unknown[]): Promise<void> {
    let pending = items;
    const attempts = retryAttempts(
      async () => {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending as never } }));
        return res.UnprocessedItems?.[this.tableName] ?? [];
      },
      {
        maxAttempts: MAX_BATCH_ATTEMPTS,
        delayMs: (retry) => Math.min(50 * 2 ** retry, 5000) * (0.5 + this.random() / 2),
        sleep: this.sleep,
      },
    );
    for await (const unprocessed of attempts) {
      if (unprocessed.length === 0) return;
      pending = unprocessed;
    }
    const err = new Error(`BatchWrite: ${pending.length} unprocessed items after ${MAX_BATCH_ATTEMPTS} attempts`);
    err.name = 'UnprocessedItemsError';
    throw err;
  }

  async registerUser(userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.userRegistry(userId),
        UpdateExpression: 'SET entityType = :t, userId = :u, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
        ExpressionAttributeValues: { ':t': ENTITY.user, ':u': userId, ':now': now },
      }),
    );
  }

  async trackTickers(tickers: { symbol: string; currency: string }[]): Promise<void> {
    const now = new Date().toISOString();
    await Promise.all(
      tickers.map((t) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: keys.trackedTicker(t.symbol),
            UpdateExpression:
              'SET entityType = :t, symbol = :s, currency = if_not_exists(currency, :c), updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
            ExpressionAttributeValues: { ':t': ENTITY.trackedTicker, ':s': t.symbol, ':c': t.currency, ':now': now },
          }),
        ),
      ),
    );
  }
}
