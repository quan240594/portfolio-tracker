import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Transaction } from '@portfolio/shared';
import { BATCH_SIZE, DynamoIngestStore } from './store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const NOW = '2026-06-15T12:00:00.000Z';

const txn = (i: number): Transaction => ({
  id: `imp-${i}`,
  userId: 'u',
  date: '2025-01-01',
  type: 'BUY',
  symbol: 'A',
  quantity: 1,
  price: 1,
  fee: 0,
  currency: 'EUR',
  createdAt: 'x',
  importId: 'imp',
});
const txns = (n: number) => Array.from({ length: n }, (_, i) => txn(i + 1));
const updates = () => ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);

beforeEach(() => {
  ddbMock.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DynamoIngestStore.getImport', () => {
  const store = new DynamoIngestStore(doc, 'tbl');

  it('reads the IMPORT item consistently and strips key attributes', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'USER#u', SK: 'IMPORT#i', entityType: 'IMPORT', importId: 'i', userId: 'u', status: 'PENDING' } });
    expect(await store.getImport('u', 'i')).toEqual({ importId: 'i', userId: 'u', status: 'PENDING' });
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input).toEqual({ TableName: 'tbl', Key: { PK: 'USER#u', SK: 'IMPORT#i' }, ConsistentRead: true });
  });

  it('returns null when the item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await store.getImport('u', 'i')).toBeNull();
  });
});

describe('DynamoIngestStore.markProcessing', () => {
  const store = new DynamoIngestStore(doc, 'tbl');

  it('conditionally moves PENDING/PROCESSING to PROCESSING', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    expect(await store.markProcessing('u', 'i')).toBe(true);
    expect(updates()[0]).toMatchObject({
      Key: { PK: 'USER#u', SK: 'IMPORT#i' },
      ConditionExpression: 'attribute_exists(PK) AND #s IN (:pending, :processing)',
      ExpressionAttributeValues: { ':processing': 'PROCESSING', ':pending': 'PENDING', ':now': NOW },
    });
  });

  it('returns false for a ConditionalCheckFailed error identified only by name', async () => {
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' }));
    expect(await store.markProcessing('u', 'i')).toBe(false);
  });

  it('returns false for a ConditionalCheckFailedException instance', async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'nope', $metadata: {} }));
    expect(await store.markProcessing('u', 'i')).toBe(false);
  });

  it('rethrows other errors (e.g. throttling) so the message is retried', async () => {
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' }));
    await expect(store.markProcessing('u', 'i')).rejects.toThrow('slow down');
  });
});

describe('DynamoIngestStore status updates', () => {
  const store = new DynamoIngestStore(doc, 'tbl');
  beforeEach(() => ddbMock.on(UpdateCommand).resolves({}));

  it('markFailed stores the errors with importedCount 0', async () => {
    const errors = [{ row: 2, message: 'bad' }];
    await store.markFailed('u', 'i', 7, errors);
    expect(updates()[0]).toMatchObject({
      TableName: 'tbl',
      Key: { PK: 'USER#u', SK: 'IMPORT#i' },
      ExpressionAttributeValues: { ':failed': 'FAILED', ':rc': 7, ':zero': 0, ':errors': errors, ':now': NOW },
    });
  });

  it('markCompleted stores the counts and removes previous errors', async () => {
    await store.markCompleted('u', 'i', 7, 6);
    const input = updates()[0]!;
    expect(input.UpdateExpression).toMatch(/REMOVE #e$/);
    expect(input.ExpressionAttributeValues).toEqual({ ':completed': 'COMPLETED', ':rc': 7, ':ic': 6, ':now': NOW });
  });

  it('registerUser upserts the registry item keeping the original createdAt', async () => {
    await store.registerUser('u');
    expect(updates()[0]).toMatchObject({
      Key: { PK: 'USERS', SK: 'USER#u' },
      UpdateExpression: expect.stringContaining('createdAt = if_not_exists(createdAt, :now)'),
      ExpressionAttributeValues: { ':t': 'USER', ':u': 'u', ':now': NOW },
    });
  });

  it('trackTickers upserts one item per ticker without overwriting an existing currency', async () => {
    await store.trackTickers([
      { symbol: 'AAPL', currency: 'USD' },
      { symbol: 'ASML.AS', currency: 'EUR' },
    ]);
    const inputs = updates();
    expect(inputs.map((i) => i.Key)).toEqual([
      { PK: 'TRACKED', SK: 'TICKER#AAPL' },
      { PK: 'TRACKED', SK: 'TICKER#ASML.AS' },
    ]);
    expect(inputs[1]).toMatchObject({
      UpdateExpression: expect.stringContaining('currency = if_not_exists(currency, :c)'),
      ExpressionAttributeValues: { ':t': 'TRACKED_TICKER', ':s': 'ASML.AS', ':c': 'EUR', ':now': NOW },
    });
  });

  it('trackTickers with no tickers makes no calls', async () => {
    await store.trackTickers([]);
    expect(updates()).toHaveLength(0);
  });
});

describe('DynamoIngestStore.listTransactions', () => {
  const store = new DynamoIngestStore(doc, 'tbl');

  it('follows LastEvaluatedKey across pages and strips key attributes', async () => {
    const lek = { PK: 'USER#u', SK: 'TXN#2025-01-01#a' };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: 'USER#u', SK: 'TXN#2025-01-01#a', entityType: 'TRANSACTION', id: 'a' }], LastEvaluatedKey: lek })
      .resolvesOnce({ Items: [{ PK: 'USER#u', SK: 'TXN#2025-01-02#b', entityType: 'TRANSACTION', id: 'b' }] });
    expect(await store.listTransactions('u')).toEqual([{ id: 'a' }, { id: 'b' }]);
    const inputs = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(inputs[0]).toMatchObject({ ExpressionAttributeValues: { ':pk': 'USER#u', ':sk': 'TXN#' }, ExclusiveStartKey: undefined });
    expect(inputs[1]!.ExclusiveStartKey).toEqual(lek);
  });

  it('handles a page without Items', async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await store.listTransactions('u')).toEqual([]);
  });
});

describe('DynamoIngestStore.putTransactions', () => {
  it('writes nothing for an empty list', async () => {
    await new DynamoIngestStore(doc, 'tbl', async () => {}).putTransactions([]);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('chunks by BATCH_SIZE and stores items with keys and entity type', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    const sleep = vi.fn(async (_ms: number) => {});
    await new DynamoIngestStore(doc, 'tbl', sleep).putTransactions(txns(2 * BATCH_SIZE + 1));
    const calls = ddbMock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.tbl!);
    expect(calls.map((c) => c.length)).toEqual([25, 25, 1]);
    expect(calls[2]![0]!.PutRequest!.Item).toEqual({ PK: 'USER#u', SK: 'TXN#2025-01-01#imp-51', entityType: 'TRANSACTION', ...txn(51) });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stores a broker fxRate on the transaction item', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    await new DynamoIngestStore(doc, 'tbl', async () => {}).putTransactions([{ ...txn(1), currency: 'USD', fxRate: 1.0842 }]);
    const item = ddbMock.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.tbl![0]!.PutRequest!.Item;
    expect(item).toMatchObject({ PK: 'USER#u', SK: 'TXN#2025-01-01#imp-1', entityType: 'TRANSACTION', currency: 'USD', fxRate: 1.0842 });
  });

  it('retries only the unprocessed items, ignoring other tables in the response', async () => {
    ddbMock
      .on(BatchWriteCommand)
      .callsFakeOnce((input) => ({ UnprocessedItems: { tbl: input.RequestItems.tbl.slice(1), other: [{}] } }))
      .resolves({ UnprocessedItems: { other: [{}] } });
    const sleep = vi.fn(async (_ms: number) => {});
    await new DynamoIngestStore(doc, 'tbl', sleep).putTransactions(txns(3));
    const sent = ddbMock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.tbl!.map((r) => r.PutRequest!.Item!.id));
    expect(sent).toEqual([['imp-1', 'imp-2', 'imp-3'], ['imp-2', 'imp-3']]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially (capped at 5s) and gives up after 8 attempts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    ddbMock.on(BatchWriteCommand).callsFake((input) => ({ UnprocessedItems: input.RequestItems }));
    const sleep = vi.fn(async (_ms: number) => {});
    const err = await new DynamoIngestStore(doc, 'tbl', sleep).putTransactions(txns(30)).catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'UnprocessedItemsError', message: 'BatchWrite: 25 unprocessed items after 8 attempts' });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(8);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400, 800, 1600, 3200, 5000]);
  });

  it('applies jitter of down to half the backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    ddbMock.on(BatchWriteCommand).callsFakeOnce((input) => ({ UnprocessedItems: input.RequestItems })).resolves({});
    const sleep = vi.fn(async (_ms: number) => {});
    await new DynamoIngestStore(doc, 'tbl', sleep).putTransactions(txns(1));
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('propagates BatchWrite errors', async () => {
    ddbMock.on(BatchWriteCommand).rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(new DynamoIngestStore(doc, 'tbl', async () => {}).putTransactions(txns(1))).rejects.toThrow('throttled');
  });

  it('waits with a real timer by default', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    ddbMock.on(BatchWriteCommand).callsFakeOnce((input) => ({ UnprocessedItems: input.RequestItems })).resolves({});
    let done = false;
    const p = new DynamoIngestStore(doc, 'tbl').putTransactions(txns(1)).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(49);
    expect(done).toBe(false);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });
});
