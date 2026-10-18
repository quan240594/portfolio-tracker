import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  assertValidPatch,
  decodeCursor,
  encodeCursor,
  UnprocessedItemsError,
  type BatchOp,
  type Condition,
  type Item,
  type ItemKey,
  type ItemPage,
  type ItemPatch,
  type ItemQuery,
  type ItemStore,
  type ReadOptions,
  type WriteOptions,
} from '@portfolio/platform';
import { drain, retryAttempts, sequentially } from '@portfolio/shared';

/** BatchWriteItem accepts at most 25 requests, BatchGetItem at most 100 keys. */
export const BATCH_WRITE_SIZE = 25;
export const BATCH_GET_SIZE = 100;
const MAX_GET_ATTEMPTS = 9;

export interface BatchRetryOptions {
  /** Attempts per chunk of unprocessed items before `UnprocessedItemsError`. Default 8. */
  maxAttempts?: number;
  /** Exponential backoff (50 ms, 100 ms, ...) is capped at this many milliseconds. Default 5000. */
  maxDelayMs?: number;
  /** Scales every delay by a random factor in [0.5, 1) so concurrent writers do not retry in lockstep. Default true. */
  jitter?: boolean;
}

export interface DynamoItemStoreOptions extends BatchRetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1) for the jitter. */
  random?: () => number;
}

const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isConditionFailure = (err: unknown) => (err as Error | undefined)?.name === 'ConditionalCheckFailedException';

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Collects the `#name` / `:value` placeholders of one expression. */
class Expression {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private count = 0;

  name(attr: string): string {
    const placeholder = `#n${this.count++}`;
    this.names[placeholder] = attr;
    return placeholder;
  }

  value(value: unknown): string {
    const placeholder = `:v${this.count++}`;
    this.values[placeholder] = value;
    return placeholder;
  }

  condition(condition: Condition): string {
    switch (condition.kind) {
      case 'exists':
        return 'attribute_exists(PK)';
      case 'notExists':
        return 'attribute_not_exists(PK)';
      case 'attrMissing':
        return `attribute_not_exists(${this.name(condition.attr)})`;
      case 'compare': {
        const op = { eq: '=', ne: '<>', lt: '<' }[condition.op];
        return `${this.name(condition.attr)} ${op} ${this.value(condition.value)}`;
      }
      case 'in':
        return `${this.name(condition.attr)} IN (${condition.values.map((v) => this.value(v)).join(', ')})`;
      case 'and':
      case 'or': {
        const joiner = condition.kind === 'and' ? ' AND ' : ' OR ';
        return `(${condition.conditions.map((c) => this.condition(c)).join(joiner)})`;
      }
    }
  }

  /** The expression attributes of the command; empty maps are omitted (DynamoDB rejects them). */
  attributes(): { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
    return {
      ...(Object.keys(this.names).length > 0 ? { ExpressionAttributeNames: this.names } : {}),
      ...(Object.keys(this.values).length > 0 ? { ExpressionAttributeValues: this.values } : {}),
    };
  }
}

type WriteRequest = { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } };

/** ItemStore on a DynamoDB table with string keys `PK` + `SK` (see infra/terraform/dynamodb.tf). */
export class DynamoItemStore implements ItemStore {
  private readonly retry: Required<BatchRetryOptions>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    options: DynamoItemStoreOptions = {},
  ) {
    this.retry = { maxAttempts: options.maxAttempts ?? 8, maxDelayMs: options.maxDelayMs ?? 5000, jitter: options.jitter ?? true };
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? secureRandom;
  }

  async get(key: ItemKey, options?: ReadOptions): Promise<Item | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: key.PK, SK: key.SK }, ...(options?.consistent ? { ConsistentRead: true } : {}) }),
    );
    return res.Item as Item | undefined;
  }

  async getMany(keys: readonly ItemKey[]): Promise<Item[]> {
    const parts = await Promise.all(chunk(keys, BATCH_GET_SIZE).map((part) => this.getChunk(part.map(({ PK, SK }) => ({ PK, SK })))));
    return parts.flat();
  }

  /** Retries unprocessed keys with exponential backoff; each retry depends on the previous response. */
  private async getChunk(pending: Record<string, unknown>[], attempt = 0): Promise<Item[]> {
    if (attempt >= MAX_GET_ATTEMPTS) throw new Error('BatchGet: unprocessed keys remain after retries');
    if (attempt > 0) await this.sleep(Math.min(50 * 2 ** attempt, 2000));
    const res = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: pending } } }));
    const found = (res.Responses?.[this.tableName] ?? []) as Item[];
    const unprocessed = res.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, unknown>[] | undefined;
    return unprocessed && unprocessed.length > 0 ? [...found, ...(await this.getChunk(unprocessed, attempt + 1))] : found;
  }

  async put(item: Item, options?: WriteOptions): Promise<boolean> {
    const expression = new Expression();
    const guard = options?.condition ? expression.condition(options.condition) : undefined;
    try {
      await this.doc.send(
        new PutCommand({ TableName: this.tableName, Item: item, ...(guard ? { ConditionExpression: guard, ...expression.attributes() } : {}) }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  async update(key: ItemKey, patch: ItemPatch, options?: WriteOptions): Promise<Item | undefined> {
    assertValidPatch(patch);
    const expression = new Expression();
    const sets = [
      ...Object.entries(patch.set ?? {}).map(([attr, value]) => `${expression.name(attr)} = ${expression.value(value)}`),
      ...Object.entries(patch.setIfAbsent ?? {}).map(([attr, value]) => {
        const name = expression.name(attr);
        return `${name} = if_not_exists(${name}, ${expression.value(value)})`;
      }),
    ];
    const removes = (patch.remove ?? []).map((attr) => expression.name(attr));
    const updateExpression = [sets.length > 0 ? `SET ${sets.join(', ')}` : '', removes.length > 0 ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' ');
    const guard = options?.condition ? expression.condition(options.condition) : undefined;
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: key.PK, SK: key.SK },
          UpdateExpression: updateExpression,
          ...(guard ? { ConditionExpression: guard } : {}),
          ...expression.attributes(),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes as Item;
    } catch (err) {
      if (isConditionFailure(err)) return undefined;
      throw err;
    }
  }

  async delete(key: ItemKey, options?: WriteOptions): Promise<boolean> {
    const expression = new Expression();
    const guard = options?.condition ? expression.condition(options.condition) : undefined;
    try {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tableName, Key: { PK: key.PK, SK: key.SK }, ...(guard ? { ConditionExpression: guard, ...expression.attributes() } : {}) }),
      );
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  async query(query: ItemQuery): Promise<ItemPage> {
    const expression = new Expression();
    const pk = expression.value(query.pk);
    const { sk } = query;
    let keyCondition = `PK = ${pk}`;
    if (sk && 'beginsWith' in sk) keyCondition += ` AND begins_with(SK, ${expression.value(sk.beginsWith)})`;
    else if (sk && 'between' in sk) keyCondition += ` AND SK BETWEEN ${expression.value(sk.between[0])} AND ${expression.value(sk.between[1])}`;
    else if (sk && 'gte' in sk) keyCondition += ` AND SK >= ${expression.value(sk.gte)}`;
    else if (sk) keyCondition += ` AND SK <= ${expression.value(sk.lte)}`;
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: expression.values,
        ...(query.consistent ? { ConsistentRead: true } : {}),
        ...(query.reverse ? { ScanIndexForward: false } : {}),
        ...(query.limit === undefined ? {} : { Limit: query.limit }),
        ...(query.cursor === undefined ? {} : { ExclusiveStartKey: decodeCursor<Record<string, unknown>>(query.cursor) }),
      }),
    );
    const items = (res.Items ?? []) as Item[];
    return res.LastEvaluatedKey ? { items, cursor: encodeCursor(res.LastEvaluatedKey) } : { items };
  }

  /** Writes the operations in batches of 25, one batch after another, retrying unprocessed items with backoff. */
  async batchWrite(operations: readonly BatchOp[]): Promise<void> {
    const requests = operations.map((op): WriteRequest => (op.type === 'put' ? { PutRequest: { Item: op.item } } : { DeleteRequest: { Key: { PK: op.key.PK, SK: op.key.SK } } }));
    await drain(sequentially(chunk(requests, BATCH_WRITE_SIZE), (part) => this.writeBatch(part)));
  }

  private async writeBatch(requests: WriteRequest[]): Promise<void> {
    const { maxAttempts, maxDelayMs, jitter } = this.retry;
    let pending = requests;
    const attempts = retryAttempts(
      async () => {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending as never } }));
        return (res.UnprocessedItems?.[this.tableName] ?? []) as WriteRequest[];
      },
      {
        maxAttempts,
        delayMs: (retry) => Math.min(50 * 2 ** retry, maxDelayMs) * (jitter ? 0.5 + this.random() / 2 : 1),
        sleep: this.sleep,
      },
    );
    for await (const unprocessed of attempts) {
      if (unprocessed.length === 0) return;
      pending = unprocessed;
    }
    throw new UnprocessedItemsError(pending.length, maxAttempts);
  }
}
