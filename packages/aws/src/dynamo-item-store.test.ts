import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cond, encodeCursor, UnprocessedItemsError } from '@portfolio/platform';
import { BATCH_WRITE_SIZE, DynamoItemStore } from './dynamo-item-store.js';

const ddb = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const sleep = vi.fn(() => Promise.resolve());
const store = new DynamoItemStore(doc, 'tbl', { sleep, random: () => 0.5 });
const conditionFailure = () => new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
const input = (call: { args: [{ input: unknown }] } | undefined) => call!.args[0].input as Record<string, unknown>;

beforeEach(() => {
  ddb.reset();
  sleep.mockClear();
});

describe('get', () => {
  it('reads one item, consistently on request', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'p', SK: 's', v: 1 } });
    expect(await store.get({ PK: 'p', SK: 's' })).toEqual({ PK: 'p', SK: 's', v: 1 });
    await store.get({ PK: 'p', SK: 's' }, { consistent: true });
    const [first, second] = ddb.commandCalls(GetCommand).map((c) => c.args[0].input);
    expect(first).toEqual({ TableName: 'tbl', Key: { PK: 'p', SK: 's' } });
    expect(second).toEqual({ TableName: 'tbl', Key: { PK: 'p', SK: 's' }, ConsistentRead: true });
  });

  it('resolves undefined for a missing item', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await store.get({ PK: 'p', SK: 's' })).toBeUndefined();
  });
});

describe('getMany', () => {
  it('requests the keys in chunks of 100 and retries unprocessed keys with backoff', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => ({ PK: 'p', SK: `k${i}` }));
    ddb
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { tbl: [{ PK: 'p', SK: 'k0' }] }, UnprocessedKeys: { tbl: { Keys: [{ PK: 'p', SK: 'k1' }] } } })
      .resolvesOnce({ Responses: { tbl: [{ PK: 'p', SK: 'k1' }] } })
      .resolves({ Responses: { tbl: [{ PK: 'p', SK: 'k100' }] } });
    const found = await store.getMany(keys);
    expect(found.map((i) => i.SK).sort((a, b) => a.localeCompare(b))).toEqual(['k0', 'k1', 'k100']);
    const calls = ddb.commandCalls(BatchGetCommand).map((c) => (c.args[0].input.RequestItems!.tbl as { Keys: unknown[] }).Keys.length);
    expect(calls.sort((a, b) => a - b)).toEqual([1, 50, 100]);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('tolerates responses without items and gives up after repeated unprocessed keys', async () => {
    ddb.on(BatchGetCommand).resolves({});
    expect(await store.getMany([{ PK: 'p', SK: 'a' }])).toEqual([]);
    ddb.reset();
    ddb.on(BatchGetCommand).resolves({ UnprocessedKeys: { tbl: { Keys: [{ PK: 'p', SK: 'a' }] } } });
    await expect(store.getMany([{ PK: 'p', SK: 'a' }])).rejects.toThrow('BatchGet: unprocessed keys remain after retries');
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(9);
    expect(sleep).toHaveBeenLastCalledWith(2000);
  });
});

describe('put', () => {
  it('writes the item, with no condition by default', async () => {
    ddb.on(PutCommand).resolves({});
    expect(await store.put({ PK: 'p', SK: 's', v: 1 })).toBe(true);
    expect(input(ddb.commandCalls(PutCommand)[0])).toEqual({ TableName: 'tbl', Item: { PK: 'p', SK: 's', v: 1 } });
  });

  it('translates conditions and reports a failed one as false', async () => {
    ddb.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionFailure());
    expect(await store.put({ PK: 'p', SK: 's' }, { condition: cond.notExists })).toBe(true);
    expect(await store.put({ PK: 'p', SK: 's' }, { condition: cond.exists })).toBe(false);
    const [first, second] = ddb.commandCalls(PutCommand).map((c) => c.args[0].input);
    expect(first).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)' });
    expect(first).not.toHaveProperty('ExpressionAttributeNames');
    expect(second).toMatchObject({ ConditionExpression: 'attribute_exists(PK)' });
  });

  it('rethrows any other error', async () => {
    ddb.on(PutCommand).rejects(new Error('throttled'));
    await expect(store.put({ PK: 'p', SK: 's' })).rejects.toThrow('throttled');
  });
});

describe('update', () => {
  it('builds SET / if_not_exists / REMOVE with placeholders for every attribute name', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { PK: 'p', SK: 's', name: 'n' } });
    const updated = await store.update({ PK: 'p', SK: 's' }, { set: { name: 'n' }, setIfAbsent: { createdAt: 't' }, remove: ['errors'] });
    expect(updated).toEqual({ PK: 'p', SK: 's', name: 'n' });
    expect(input(ddb.commandCalls(UpdateCommand)[0])).toEqual({
      TableName: 'tbl',
      Key: { PK: 'p', SK: 's' },
      UpdateExpression: 'SET #n0 = :v1, #n2 = if_not_exists(#n2, :v3) REMOVE #n4',
      ExpressionAttributeNames: { '#n0': 'name', '#n2': 'createdAt', '#n4': 'errors' },
      ExpressionAttributeValues: { ':v1': 'n', ':v3': 't' },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('supports REMOVE-only and SET-only patches', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.update({ PK: 'p', SK: 's' }, { remove: ['a'] });
    await store.update({ PK: 'p', SK: 's' }, { set: { a: 1 } });
    const [removeOnly, setOnly] = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(removeOnly).toMatchObject({ UpdateExpression: 'REMOVE #n0' });
    expect(removeOnly).not.toHaveProperty('ExpressionAttributeValues');
    expect(setOnly).toMatchObject({ UpdateExpression: 'SET #n0 = :v1' });
  });

  it('compiles a compound condition and resolves undefined when it fails', async () => {
    ddb.on(UpdateCommand).rejects(conditionFailure());
    const guard = cond.and(cond.exists, cond.or(cond.ne('status', 'RUNNING'), cond.attrMissing('runStartedAt'), cond.lt('runStartedAt', 'stale')), cond.oneOf('k', ['a', 'b']), cond.eq('x', 1));
    expect(await store.update({ PK: 'p', SK: 's' }, { set: { status: 'RUNNING' } }, { condition: guard })).toBeUndefined();
    expect(input(ddb.commandCalls(UpdateCommand)[0])).toMatchObject({
      ConditionExpression: '(attribute_exists(PK) AND (#n2 <> :v3 OR attribute_not_exists(#n4) OR #n5 < :v6) AND #n7 IN (:v8, :v9) AND #n10 = :v11)',
      ExpressionAttributeNames: { '#n2': 'status', '#n4': 'runStartedAt', '#n5': 'runStartedAt', '#n7': 'k', '#n10': 'x' },
      ExpressionAttributeValues: expect.objectContaining({ ':v3': 'RUNNING', ':v6': 'stale', ':v8': 'a', ':v9': 'b', ':v11': 1 }),
    });
  });

  it('rejects invalid patches before calling DynamoDB and rethrows other errors', async () => {
    await expect(store.update({ PK: 'p', SK: 's' }, {})).rejects.toThrow('at least one attribute');
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    ddb.on(UpdateCommand).rejects(new Error('boom'));
    await expect(store.update({ PK: 'p', SK: 's' }, { set: { a: 1 } })).rejects.toThrow('boom');
  });
});

describe('delete', () => {
  it('deletes by key, optionally guarded', async () => {
    ddb.on(DeleteCommand).resolvesOnce({}).resolvesOnce({}).rejectsOnce(conditionFailure());
    expect(await store.delete({ PK: 'p', SK: 's' })).toBe(true);
    expect(await store.delete({ PK: 'p', SK: 's' }, { condition: cond.exists })).toBe(true);
    expect(await store.delete({ PK: 'p', SK: 's' }, { condition: cond.exists })).toBe(false);
    const [plain, guarded] = ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input);
    expect(plain).toEqual({ TableName: 'tbl', Key: { PK: 'p', SK: 's' } });
    expect(guarded).toMatchObject({ ConditionExpression: 'attribute_exists(PK)' });
  });

  it('rethrows any other error', async () => {
    ddb.on(DeleteCommand).rejects(new Error('boom'));
    await expect(store.delete({ PK: 'p', SK: 's' })).rejects.toThrow('boom');
  });
});

describe('query', () => {
  const sortKeyConditions = [
    [{ beginsWith: 'EOD#' }, 'PK = :v0 AND begins_with(SK, :v1)', { ':v0': 'p', ':v1': 'EOD#' }],
    [{ between: ['a', 'b'] as const }, 'PK = :v0 AND SK BETWEEN :v1 AND :v2', { ':v0': 'p', ':v1': 'a', ':v2': 'b' }],
    [{ gte: 'a' }, 'PK = :v0 AND SK >= :v1', { ':v0': 'p', ':v1': 'a' }],
    [{ lte: 'b' }, 'PK = :v0 AND SK <= :v1', { ':v0': 'p', ':v1': 'b' }],
    [undefined, 'PK = :v0', { ':v0': 'p' }],
  ] as const;

  it.each(sortKeyConditions)('builds the key condition for %j', async (sk, expression, values) => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'p', SK: 'x' }] });
    expect(await store.query({ pk: 'p', sk })).toEqual({ items: [{ PK: 'p', SK: 'x' }] });
    expect(input(ddb.commandCalls(QueryCommand)[0])).toEqual({ TableName: 'tbl', KeyConditionExpression: expression, ExpressionAttributeValues: values });
  });

  it('passes consistency, direction, page size and decodes/encodes the cursor', async () => {
    ddb.on(QueryCommand).resolves({ LastEvaluatedKey: { PK: 'p', SK: 'next' } });
    const page = await store.query({ pk: 'p', consistent: true, reverse: true, limit: 2, cursor: encodeCursor({ PK: 'p', SK: 'prev' }) });
    expect(page).toEqual({ items: [], cursor: encodeCursor({ PK: 'p', SK: 'next' }) });
    expect(input(ddb.commandCalls(QueryCommand)[0])).toMatchObject({ ConsistentRead: true, ScanIndexForward: false, Limit: 2, ExclusiveStartKey: { PK: 'p', SK: 'prev' } });
  });
});

describe('batchWrite', () => {
  const puts = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'put' as const, item: { PK: 'p', SK: `k${i}` } }));

  it('writes puts and deletes in chunks of 25, one chunk after another', async () => {
    ddb.on(BatchWriteCommand).resolves({});
    await store.batchWrite([...puts(BATCH_WRITE_SIZE), { type: 'delete', key: { PK: 'p', SK: 'gone', extra: 'ignored' } as never }]);
    const calls = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.tbl);
    expect(calls.map((c) => c!.length)).toEqual([25, 1]);
    expect(calls[1]).toEqual([{ DeleteRequest: { Key: { PK: 'p', SK: 'gone' } } }]);
    expect(calls[0]![0]).toEqual({ PutRequest: { Item: { PK: 'p', SK: 'k0' } } });
  });

  it('does nothing for an empty batch', async () => {
    await store.batchWrite([]);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('retries only the unprocessed items with jittered exponential backoff, ignoring other tables', async () => {
    const left = { PutRequest: { Item: { PK: 'p', SK: 'k1' } } };
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { tbl: [left], other: [left] } })
      .resolvesOnce({ UnprocessedItems: { tbl: [left] } })
      .resolvesOnce({});
    await store.batchWrite(puts(2));
    const sent = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.tbl!.length);
    expect(sent).toEqual([2, 1, 1]);
    expect(sleep.mock.calls).toEqual([[75], [150]]);
  });

  it('rejects with UnprocessedItemsError once the attempts are used up', async () => {
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { tbl: [{ PutRequest: { Item: { PK: 'p', SK: 'k0' } } }] } });
    const error = await store.batchWrite(puts(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessedItemsError);
    expect(error).toMatchObject({ name: 'UnprocessedItemsError', message: 'BatchWrite: 1 unprocessed items after 8 attempts' });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(8);
  });

  it('honours custom retry options (attempts, delay cap, no jitter)', async () => {
    const custom = new DynamoItemStore(doc, 'tbl', { maxAttempts: 4, maxDelayMs: 100, jitter: false, sleep });
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { tbl: [{ PutRequest: { Item: { PK: 'p', SK: 'k0' } } }] } });
    await expect(custom.batchWrite(puts(1))).rejects.toThrow('after 4 attempts');
    expect(sleep.mock.calls).toEqual([[100], [100], [100]]);
  });

  it('defaults to a CSPRNG for the jitter and real timers for the delay', async () => {
    const defaults = new DynamoItemStore(doc, 'tbl');
    ddb.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: { tbl: [{ PutRequest: { Item: { PK: 'p', SK: 'k0' } } }] } }).resolves({});
    vi.useFakeTimers();
    const done = defaults.batchWrite(puts(1));
    await vi.advanceTimersByTimeAsync(100);
    await done;
    vi.useRealTimers();
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });
});
