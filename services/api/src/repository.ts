import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ENTITY,
  keys,
  type DividendEvent,
  type EodPrice,
  type FxDay,
  type FxRates,
  type ImportStatus,
  type InstrumentProfile,
  type Portfolio,
  type Quote,
  type Transaction,
} from '@portfolio/shared';

/** Data access used by the route handlers. Implemented by DynamoRepository and by in-memory fakes in tests. */
export interface Repository {
  /** All portfolios of the user (unsorted). */
  listPortfolios(userId: string): Promise<Portfolio[]>;
  getPortfolio(userId: string, portfolioId: string): Promise<Portfolio | null>;
  /** Create-only put; resolves false when the portfolio already exists (e.g. a concurrent default creation). */
  createPortfolio(portfolio: Portfolio): Promise<boolean>;
  /** Renames an existing portfolio; resolves null when it does not exist. */
  renamePortfolio(userId: string, portfolioId: string, name: string, updatedAt: string): Promise<Portfolio | null>;
  deletePortfolio(userId: string, portfolioId: string): Promise<void>;
  /** Transactions of one portfolio, or of all portfolios when `portfolioId` is omitted. */
  listTransactions(userId: string, portfolioId?: string): Promise<Transaction[]>;
  /** Looks a transaction up by id across all portfolios of the user. */
  findTransaction(userId: string, id: string): Promise<Transaction | null>;
  putTransaction(txn: Transaction): Promise<void>;
  deleteTransaction(txn: Transaction): Promise<void>;
  /** Batch delete (chunks of 25, retrying unprocessed items). */
  deleteTransactions(txns: readonly Transaction[]): Promise<void>;
  getQuotes(symbols: string[]): Promise<Record<string, Quote>>;
  getProfiles(symbols: string[]): Promise<Record<string, InstrumentProfile>>;
  getFx(base: string): Promise<FxRates | null>;
  /** Daily ECB fixings for `base` between `from` and `to` (inclusive, YYYY-MM-DD), oldest first. */
  getFxHistory(base: string, from: string, to: string): Promise<FxDay[]>;
  getEod(symbol: string, from: string, to: string): Promise<EodPrice[]>;
  getDividendEvents(symbol: string): Promise<DividendEvent[]>;
  registerUser(userId: string): Promise<void>;
  trackTickers(tickers: { symbol: string; currency: string }[]): Promise<void>;
  putImport(status: ImportStatus): Promise<void>;
  getImport(userId: string, importId: string): Promise<ImportStatus | null>;
}

const KEY_ATTRS = new Set(['PK', 'SK', 'entityType']);

/** Strips the single-table key attributes from an item. */
export function fromItem<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isConditionalCheckFailure = (err: unknown) => (err as Error | undefined)?.name === 'ConditionalCheckFailedException';

export const BATCH_WRITE_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 9;

export class DynamoRepository implements Repository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async queryAll(
    input: Omit<QueryCommandInput, 'TableName'>,
    ExclusiveStartKey?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const res = await this.doc.send(new QueryCommand({ ...input, TableName: this.tableName, ExclusiveStartKey }));
    const items = (res.Items ?? []) as Record<string, unknown>[];
    // Pages depend on the previous page's cursor, so they are fetched sequentially.
    return res.LastEvaluatedKey ? [...items, ...(await this.queryAll(input, res.LastEvaluatedKey))] : items;
  }

  private async batchGet(keyList: { PK: string; SK: string }[]): Promise<Record<string, unknown>[]> {
    const parts = await Promise.all(chunk(keyList, 100).map((part) => this.batchGetChunk(part)));
    return parts.flat();
  }

  /** Retries unprocessed keys with exponential backoff; each retry depends on the previous response. */
  private async batchGetChunk(pending: Record<string, unknown>[], attempt = 0): Promise<Record<string, unknown>[]> {
    if (attempt > 8) throw new Error('BatchGet: unprocessed keys remain after retries');
    if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2000));
    const res = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: pending } } }));
    const out = (res.Responses?.[this.tableName] ?? []) as Record<string, unknown>[];
    const unprocessed = res.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, unknown>[] | undefined;
    return unprocessed && unprocessed.length > 0 ? [...out, ...(await this.batchGetChunk(unprocessed, attempt + 1))] : out;
  }

  private async batchWrite(requests: Record<string, unknown>[]): Promise<void> {
    for (const part of chunk(requests, BATCH_WRITE_SIZE)) {
      let pending: Record<string, unknown>[] | undefined = part;
      for (let attempt = 0; pending && pending.length > 0; attempt++) {
        if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error('BatchWrite: unprocessed items remain after retries');
        if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2000));
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending as never } }));
        pending = res.UnprocessedItems?.[this.tableName] as Record<string, unknown>[] | undefined;
      }
    }
  }

  async listPortfolios(userId: string): Promise<Portfolio[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.user(userId).PK, ':sk': keys.portfolioPrefix },
      ConsistentRead: true,
    });
    return items.map((i) => fromItem<Portfolio>(i));
  }

  async getPortfolio(userId: string, portfolioId: string): Promise<Portfolio | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.portfolio(userId, portfolioId), ConsistentRead: true }),
    );
    return res.Item ? fromItem<Portfolio>(res.Item) : null;
  }

  async createPortfolio(portfolio: Portfolio): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...keys.portfolio(portfolio.userId, portfolio.portfolioId), entityType: ENTITY.portfolio, ...portfolio },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) return false;
      throw err;
    }
  }

  async renamePortfolio(userId: string, portfolioId: string, name: string, updatedAt: string): Promise<Portfolio | null> {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.portfolio(userId, portfolioId),
          UpdateExpression: 'SET #n = :name, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#n': 'name' },
          ExpressionAttributeValues: { ':name': name, ':now': updatedAt },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return fromItem<Portfolio>(res.Attributes ?? {});
    } catch (err) {
      if (isConditionalCheckFailure(err)) return null;
      throw err;
    }
  }

  async deletePortfolio(userId: string, portfolioId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: keys.portfolio(userId, portfolioId) }));
  }

  async listTransactions(userId: string, portfolioId?: string): Promise<Transaction[]> {
    const prefix = portfolioId === undefined ? keys.transactionPrefix : keys.portfolioTransactionPrefix(portfolioId);
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.user(userId).PK, ':sk': prefix },
    });
    return items.map((i) => fromItem<Transaction>(i));
  }

  async findTransaction(userId: string, id: string): Promise<Transaction | null> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: { ':pk': keys.user(userId).PK, ':sk': keys.transactionPrefix, ':id': id },
    });
    return items[0] ? fromItem<Transaction>(items[0]) : null;
  }

  async putTransaction(txn: Transaction): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.transaction(txn.userId, txn.portfolioId, txn.date, txn.id), entityType: ENTITY.transaction, ...txn },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  async deleteTransaction(txn: Transaction): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: keys.transaction(txn.userId, txn.portfolioId, txn.date, txn.id) }),
    );
  }

  async deleteTransactions(txns: readonly Transaction[]): Promise<void> {
    await this.batchWrite(
      txns.map((t) => ({ DeleteRequest: { Key: keys.transaction(t.userId, t.portfolioId, t.date, t.id) } })),
    );
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const items = await this.batchGet(symbols.map((s) => keys.quote(s)));
    return Object.fromEntries(items.map((i) => [String(i.symbol), fromItem<Quote>(i)]));
  }

  async getProfiles(symbols: string[]): Promise<Record<string, InstrumentProfile>> {
    const items = await this.batchGet(symbols.map((s) => keys.profile(s)));
    return Object.fromEntries(items.map((i) => [String(i.symbol), fromItem<InstrumentProfile>(i)]));
  }

  async getFx(base: string): Promise<FxRates | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: keys.fx(base) }));
    return res.Item ? fromItem<FxRates>(res.Item) : null;
  }

  async getFxHistory(base: string, from: string, to: string): Promise<FxDay[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': keys.fxDay(base, from).PK,
        ':from': keys.fxDay(base, from).SK,
        ':to': keys.fxDay(base, to).SK,
      },
    });
    return items.map((i) => ({
      base: typeof i.base === 'string' ? i.base : base,
      date: typeof i.date === 'string' ? i.date : String(i.SK).slice(keys.fxDayPrefix.length),
      rates: (i.rates ?? {}) as FxDay['rates'],
    }));
  }

  async getEod(symbol: string, from: string, to: string): Promise<EodPrice[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': keys.tickerPk(symbol),
        ':from': keys.eod(symbol, from).SK,
        ':to': keys.eod(symbol, to).SK,
      },
    });
    return items.map((i) => fromItem<EodPrice>(i));
  }

  async getDividendEvents(symbol: string): Promise<DividendEvent[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.tickerPk(symbol), ':sk': keys.dividendPrefix },
    });
    return items.map((i) => fromItem<DividendEvent>(i));
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

  async putImport(status: ImportStatus): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.import(status.userId, status.importId), entityType: ENTITY.import, ...status },
      }),
    );
  }

  async getImport(userId: string, importId: string): Promise<ImportStatus | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: keys.import(userId, importId), ConsistentRead: true }),
    );
    return res.Item ? fromItem<ImportStatus>(res.Item) : null;
  }
}
