import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ENTITY, keys, type ImportStatus, type Transaction } from '@portfolio/shared';

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

export const BATCH_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 8;

export class DynamoIngestStore implements IngestStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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
    const out: Transaction[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': keys.user(userId).PK, ':sk': keys.transactionPrefix },
          ExclusiveStartKey,
        }),
      );
      out.push(...(res.Items ?? []).map((i) => fromItem<Transaction>(i)));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  /** BatchWrite in chunks of 25, retrying UnprocessedItems with exponential backoff. Puts are idempotent (deterministic keys). */
  async putTransactions(txns: Transaction[]): Promise<void> {
    for (let i = 0; i < txns.length; i += BATCH_SIZE) {
      let pending: unknown[] = txns.slice(i, i + BATCH_SIZE).map((t) => ({
        PutRequest: { Item: { ...keys.transaction(t.userId, t.date, t.id), entityType: ENTITY.transaction, ...t } },
      }));
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt >= MAX_BATCH_ATTEMPTS) {
          const err = new Error(`BatchWrite: ${pending.length} unprocessed items after ${attempt} attempts`);
          err.name = 'UnprocessedItemsError';
          throw err;
        }
        if (attempt > 0) await this.sleep(Math.min(50 * 2 ** attempt, 5000) * (0.5 + Math.random() / 2));
        const res = await this.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.tableName]: pending as never } }),
        );
        pending = res.UnprocessedItems?.[this.tableName] ?? [];
      }
    }
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
    for (const t of tickers) {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.trackedTicker(t.symbol),
          UpdateExpression:
            'SET entityType = :t, symbol = :s, currency = if_not_exists(currency, :c), updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
          ExpressionAttributeValues: { ':t': ENTITY.trackedTicker, ':s': t.symbol, ':c': t.currency, ':now': now },
        }),
      );
    }
  }
}
