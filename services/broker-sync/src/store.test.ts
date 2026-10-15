import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BrokerSyncState, Transaction } from '@portfolio/shared';
import { DynamoBrokerStore } from './store.js';

const ddb = mockClient(DynamoDBDocumentClient);
const doc = () => DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const store = () => new DynamoBrokerStore(doc(), 'tbl', () => Promise.resolve(), () => 0.5);
const conditionFailed = () => new ConditionalCheckFailedException({ message: 'x', $metadata: {} });

const state: BrokerSyncState = {
  userId: 'u1',
  portfolioId: 'p1',
  broker: 'trading212',
  environment: 'live',
  status: 'CONNECTED',
  connectedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const txn = (id: string): Transaction => ({ id, userId: 'u1', portfolioId: 'p1', date: '2026-01-02', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1, fee: 0, currency: 'USD', createdAt: '2026-01-02T10:00:00.000Z' });

beforeEach(() => ddb.reset());

describe('DynamoBrokerStore state', () => {
  it('reads a state with a consistent read and strips the key attributes', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'USER#u1', SK: 'BROKER#trading212#p1', entityType: 'BROKER_STATE', ...state } });
    expect(await store().getState('u1', 'p1')).toEqual(state);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({ Key: { PK: 'USER#u1', SK: 'BROKER#trading212#p1' }, ConsistentRead: true });
    ddb.on(GetCommand).resolves({});
    expect(await store().getState('u1', 'p1')).toBeNull();
  });

  it('creates and saves states under the broker key', async () => {
    ddb.on(PutCommand).resolves({});
    await store().createState(state);
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({ TableName: 'tbl', Item: { PK: 'USER#u1', SK: 'BROKER#trading212#p1', entityType: 'BROKER_STATE', status: 'CONNECTED' } });
    await store().saveState(state);
    expect(ddb.commandCalls(PutCommand)[1]!.args[0].input.ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('does not resurrect a state that was deleted meanwhile, but surfaces other failures', async () => {
    ddb.on(PutCommand).rejects(conditionFailed());
    await expect(store().saveState(state)).resolves.toBeUndefined();
    ddb.on(PutCommand).rejects(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    await expect(store().saveState(state)).resolves.toBeUndefined();
    ddb.on(PutCommand).rejects(new Error('throttled'));
    await expect(store().saveState(state)).rejects.toThrow('throttled');
  });

  it('takes the run lock conditionally', async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await store().beginRun('u1', 'p1', 'now', 'stale')).toBe(true);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toContain('attribute_exists(PK)');
    expect(input.ExpressionAttributeValues).toEqual({ ':running': 'RUNNING', ':now': 'now', ':stale': 'stale' });
    ddb.on(UpdateCommand).rejects(conditionFailed());
    expect(await store().beginRun('u1', 'p1', 'now', 'stale')).toBe(false);
    ddb.on(UpdateCommand).rejects(new Error('boom'));
    await expect(store().beginRun('u1', 'p1', 'now', 'stale')).rejects.toThrow('boom');
  });

  it('lists the states of a user and the registered users (paginated)', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: 'USER#u1', SK: 'BROKER#trading212#p1', ...state }], LastEvaluatedKey: { PK: 'x', SK: 'y' } })
      .resolvesOnce({ Items: [{ PK: 'USER#u1', SK: 'BROKER#trading212#p2', ...state, portfolioId: 'p2' }] });
    const states = await store().listStates('u1');
    expect(states.map((s) => s.portfolioId)).toEqual(['p1', 'p2']);
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'x', SK: 'y' });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'USER#u1', ':sk': 'BROKER#trading212#' });

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [{ userId: 'u1' }, { userId: 'u2' }] });
    expect(await store().listUserIds()).toEqual(['u1', 'u2']);
    ddb.reset();
    ddb.on(QueryCommand).resolves({});
    expect(await store().listUserIds()).toEqual([]);
  });

  it('deletes all states of a user and reports how many', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ ...state }, { ...state, portfolioId: 'p2' }] });
    ddb.on(DeleteCommand).resolves({});
    expect(await store().deleteStates('u1')).toBe(2);
    expect(ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key)).toEqual([
      { PK: 'USER#u1', SK: 'BROKER#trading212#p1' },
      { PK: 'USER#u1', SK: 'BROKER#trading212#p2' },
    ]);
  });
});

describe('DynamoBrokerStore transactions', () => {
  it('lists every transaction of the user', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'USER#u1', SK: 'TXN#p1#2026-01-02#a', ...txn('a') }] });
    expect(await store().listTransactions('u1')).toEqual([txn('a')]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues![':sk']).toBe('TXN#');
  });

  it('writes in batches of 25 under the transaction keys', async () => {
    ddb.on(BatchWriteCommand).resolves({});
    await store().putTransactions(Array.from({ length: 51 }, (_, i) => txn(`t${i}`)));
    const calls = ddb.commandCalls(BatchWriteCommand);
    expect(calls.map((c) => c.args[0].input.RequestItems!.tbl!.length)).toEqual([25, 25, 1]);
    expect(calls[0]!.args[0].input.RequestItems!.tbl![0]).toMatchObject({ PutRequest: { Item: { PK: 'USER#u1', SK: 'TXN#p1#2026-01-02#t0', entityType: 'TRANSACTION' } } });
  });

  it('retries unprocessed items and eventually gives up', async () => {
    const unprocessed = { tbl: [{ PutRequest: { Item: { PK: 'a', SK: 'b' } } }] };
    ddb.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: unprocessed }).resolves({});
    await store().putTransactions([txn('a')]);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);

    ddb.reset();
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: unprocessed });
    await expect(store().putTransactions([txn('a')])).rejects.toThrow('BatchWrite: 1 unprocessed items after 8 attempts');
  });

  it('backs off with jitter between retries using real timers by default', async () => {
    vi.useFakeTimers();
    try {
      ddb.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: { tbl: [{ PutRequest: { Item: {} } }] } }).resolves({});
      const real = new DynamoBrokerStore(doc(), 'tbl');
      const done = real.putTransactions([txn('a')]);
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DynamoBrokerStore registry and fx', () => {
  it('registers the user and tracks tickers', async () => {
    ddb.on(UpdateCommand).resolves({});
    await store().registerUser('u1');
    await store().trackTickers([{ symbol: 'AAPL', currency: 'USD' }, { symbol: 'ASML.AS', currency: 'EUR' }]);
    const inputs = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.Key);
    expect(inputs).toEqual([{ PK: 'USERS', SK: 'USER#u1' }, { PK: 'TRACKED', SK: 'TICKER#AAPL' }, { PK: 'TRACKED', SK: 'TICKER#ASML.AS' }]);
  });

  it('reads the latest ECB rates and tolerates their absence', async () => {
    ddb.on(GetCommand).resolves({ Item: { rates: { USD: 1.1 } } });
    expect(await store().getFxRates()).toEqual({ USD: 1.1 });
    ddb.on(GetCommand).resolves({});
    expect(await store().getFxRates()).toEqual({});
  });

  it('creates the portfolio only when it does not exist', async () => {
    ddb.on(PutCommand).resolves({});
    await store().ensurePortfolio('u1', 'p1', 'Trading 212', 'now');
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      ConditionExpression: 'attribute_not_exists(PK)',
      Item: { PK: 'USER#u1', SK: 'PORTFOLIO#p1', entityType: 'PORTFOLIO', name: 'Trading 212' },
    });
    ddb.on(PutCommand).rejects(conditionFailed());
    await expect(store().ensurePortfolio('u1', 'p1', 'x', 'now')).resolves.toBeUndefined();
    ddb.on(PutCommand).rejects(new Error('boom'));
    await expect(store().ensurePortfolio('u1', 'p1', 'x', 'now')).rejects.toThrow('boom');
  });
});
