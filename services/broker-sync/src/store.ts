import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  BROKER_ENTITY,
  ENTITY,
  brokerKeys,
  drain,
  fromItem,
  keys,
  paginate,
  registerUserUpdate,
  retryAttempts,
  sequentially,
  trackTickerUpdates,
  transactionItem,
  type BrokerSyncState,
  type Portfolio,
  type Transaction,
} from '@portfolio/shared';

/** Persistence used by the sync run and the API's broker endpoints. */
export interface BrokerStore {
  getState(userId: string, portfolioId: string): Promise<BrokerSyncState | null>;
  listStates(userId: string): Promise<BrokerSyncState[]>;
  listUserIds(): Promise<string[]>;
  /** Creates or replaces the state (connect). */
  createState(state: BrokerSyncState): Promise<void>;
  /** Overwrites an existing state; a no-op when it was deleted meanwhile (disconnect during a run). */
  saveState(state: BrokerSyncState): Promise<void>;
  /** Not RUNNING (or RUNNING since before `staleBefore`) -> RUNNING. False when another run is active or the state is gone. */
  beginRun(userId: string, portfolioId: string, now: string, staleBefore: string): Promise<boolean>;
  deleteStates(userId: string): Promise<number>;
  listTransactions(userId: string): Promise<Transaction[]>;
  putTransactions(txns: readonly Transaction[]): Promise<void>;
  registerUser(userId: string): Promise<void>;
  trackTickers(tickers: readonly { symbol: string; currency: string }[]): Promise<void>;
  /** Latest ECB rates (units per 1 EUR) written by the prices service; empty when unavailable. */
  getFxRates(): Promise<Record<string, number>>;
  /** Local CLI convenience: creates the portfolio when it does not exist. */
  ensurePortfolio(userId: string, portfolioId: string, name: string, now: string): Promise<void>;
}

const BATCH_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 8;
const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
const isConditionFailure = (err: unknown) =>
  err instanceof ConditionalCheckFailedException || (err as Error)?.name === 'ConditionalCheckFailedException';

const stateItem = (state: BrokerSyncState) => ({
  ...brokerKeys.state(state.userId, state.portfolioId),
  entityType: BROKER_ENTITY,
  ...state,
});

export class DynamoBrokerStore implements BrokerStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly random: () => number = secureRandom,
  ) {}

  async getState(userId: string, portfolioId: string): Promise<BrokerSyncState | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: brokerKeys.state(userId, portfolioId), ConsistentRead: true }),
    );
    return res.Item ? fromItem<BrokerSyncState>(res.Item) : null;
  }

  async listStates(userId: string): Promise<BrokerSyncState[]> {
    const items = await this.queryPrefix(keys.user(userId).PK, brokerKeys.statePrefix);
    return items.map((i) => fromItem<BrokerSyncState>(i));
  }

  async listUserIds(): Promise<string[]> {
    const items = await this.queryPrefix('USERS', 'USER#');
    return items.map((i) => String(i.userId));
  }

  async createState(state: BrokerSyncState): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: stateItem(state) }));
  }

  async saveState(state: BrokerSyncState): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({ TableName: this.tableName, Item: stateItem(state), ConditionExpression: 'attribute_exists(PK)' }),
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  async beginRun(userId: string, portfolioId: string, now: string, staleBefore: string): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: brokerKeys.state(userId, portfolioId),
          UpdateExpression: 'SET #s = :running, runStartedAt = :now, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK) AND (#s <> :running OR attribute_not_exists(runStartedAt) OR runStartedAt < :stale)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':running': 'RUNNING', ':now': now, ':stale': staleBefore },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  async deleteStates(userId: string): Promise<number> {
    const states = await this.listStates(userId);
    await Promise.all(
      states.map((s) => this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: brokerKeys.state(userId, s.portfolioId) }))),
    );
    return states.length;
  }

  async listTransactions(userId: string): Promise<Transaction[]> {
    const items = await this.queryPrefix(keys.user(userId).PK, keys.transactionPrefix);
    return items.map((i) => fromItem<Transaction>(i));
  }

  /** BatchWrite in chunks of 25, retrying unprocessed items with backoff. Puts are idempotent (deterministic keys). */
  async putTransactions(txns: readonly Transaction[]): Promise<void> {
    const chunks: unknown[][] = [];
    for (let i = 0; i < txns.length; i += BATCH_SIZE) {
      chunks.push(txns.slice(i, i + BATCH_SIZE).map((t) => ({ PutRequest: { Item: transactionItem(t) } })));
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
    throw new Error(`BatchWrite: ${pending.length} unprocessed items after ${MAX_BATCH_ATTEMPTS} attempts`);
  }

  async registerUser(userId: string): Promise<void> {
    await this.doc.send(new UpdateCommand(registerUserUpdate(this.tableName, userId, new Date().toISOString())));
  }

  async trackTickers(tickers: readonly { symbol: string; currency: string }[]): Promise<void> {
    const updates = trackTickerUpdates(this.tableName, tickers, new Date().toISOString());
    await Promise.all(updates.map((input) => this.doc.send(new UpdateCommand(input))));
  }

  async getFxRates(): Promise<Record<string, number>> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: keys.fx('EUR') }));
    const rates: unknown = res.Item?.rates;
    return rates && typeof rates === 'object' ? (rates as Record<string, number>) : {};
  }

  async ensurePortfolio(userId: string, portfolioId: string, name: string, now: string): Promise<void> {
    const item: Portfolio = { portfolioId, userId, name, createdAt: now, updatedAt: now };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...keys.portfolio(userId, portfolioId), entityType: ENTITY.portfolio, ...item },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  private async queryPrefix(pk: string, skPrefix: string): Promise<Record<string, unknown>[]> {
    const pages = paginate<Record<string, unknown>[], Record<string, unknown>>(async (ExclusiveStartKey) => {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
          ExclusiveStartKey,
        }),
      );
      return { page: res.Items ?? [], next: res.LastEvaluatedKey };
    });
    const out: Record<string, unknown>[] = [];
    for await (const items of pages) out.push(...items);
    return out;
  }
}
