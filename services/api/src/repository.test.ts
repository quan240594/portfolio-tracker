import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ImportStatus, Transaction } from '@portfolio/shared';
import { DynamoRepository, fromItem } from './repository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const repo = new DynamoRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' })), 'tbl');

const txn: Transaction = {
  id: 'i',
  userId: 'u',
  date: '2025-01-01',
  type: 'BUY',
  symbol: 'A',
  quantity: 1,
  price: 1,
  fee: 0,
  currency: 'EUR',
  createdAt: 'x',
};

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fromItem', () => {
  it('strips PK, SK and entityType but keeps everything else', () => {
    expect(fromItem({ PK: 'a', SK: 'b', entityType: 'c', id: 1, nested: { PK: 'kept' } })).toEqual({ id: 1, nested: { PK: 'kept' } });
  });
});

describe('DynamoRepository queries', () => {
  it('follows LastEvaluatedKey across several pages and tolerates pages without Items', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', id: '1' }], LastEvaluatedKey: { PK: 'k1' } })
      .resolvesOnce({ LastEvaluatedKey: { PK: 'k2' } })
      .resolvesOnce({ Items: [{ PK: 'p', SK: 's', id: '2' }] });
    expect(await repo.listTransactions('u')).toEqual([{ id: '1' }, { id: '2' }]);
    const starts = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input.ExclusiveStartKey);
    expect(starts).toEqual([undefined, { PK: 'k1' }, { PK: 'k2' }]);
  });

  it('findTransaction filters by id and returns the first match without keys', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'USER#u', SK: 'TXN#2025-01-01#i', entityType: 'TRANSACTION', ...txn }] });
    expect(await repo.findTransaction('u', 'i')).toEqual(txn);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      TableName: 'tbl',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: { ':pk': 'USER#u', ':sk': 'TXN#', ':id': 'i' },
    });
  });

  it('findTransaction returns null when nothing matches (even across filtered-out pages)', async () => {
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'k' } }).resolvesOnce({ Items: [] });
    expect(await repo.findTransaction('u', 'missing')).toBeNull();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('getDividendEvents queries the ticker partition by DIV# prefix', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ PK: 'TICKER#AAPL', SK: 'DIV#2025-02-01', entityType: 'DIVIDEND', symbol: 'AAPL', exDate: '2025-02-01', amount: 0.25, currency: 'USD' }],
    });
    expect(await repo.getDividendEvents('AAPL')).toEqual([{ symbol: 'AAPL', exDate: '2025-02-01', amount: 0.25, currency: 'USD' }]);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'TICKER#AAPL', ':sk': 'DIV#' });
  });

  it('getEod strips keys from the returned prices', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'TICKER#A', SK: 'EOD#2025-01-02', entityType: 'EOD', symbol: 'A', date: '2025-01-02', close: 3 }] });
    expect(await repo.getEod('A', '2025-01-01', '2025-01-31')).toEqual([{ symbol: 'A', date: '2025-01-02', close: 3 }]);
  });
});

describe('DynamoRepository BatchGet', () => {
  it('getProfiles requests PROFILE keys and indexes results by symbol', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { tbl: [{ PK: 'TICKER#A', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'A', name: 'Alpha' }] },
    });
    expect(await repo.getProfiles(['A', 'B'])).toEqual({ A: { symbol: 'A', name: 'Alpha' } });
    expect(ddbMock.commandCalls(BatchGetCommand)[0]!.args[0].input.RequestItems).toEqual({
      tbl: { Keys: [{ PK: 'TICKER#A', SK: 'PROFILE' }, { PK: 'TICKER#B', SK: 'PROFILE' }] },
    });
  });

  it('returns an empty map when the response has no Responses', async () => {
    ddbMock.on(BatchGetCommand).resolves({});
    expect(await repo.getQuotes(['A'])).toEqual({});
  });

  it('does not call DynamoDB for an empty symbol list', async () => {
    expect(await repo.getQuotes([])).toEqual({});
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('splits more than 100 keys into chunks of at most 100', async () => {
    ddbMock.on(BatchGetCommand).callsFake((input: { RequestItems: Record<string, { Keys: { PK: string }[] }> }) => ({
      Responses: { tbl: input.RequestItems.tbl!.Keys.map((k) => ({ ...k, SK: 'QUOTE#LATEST', symbol: k.PK.slice(7) })) },
    }));
    const symbols = Array.from({ length: 250 }, (_, i) => `S${i}`);
    const quotes = await repo.getQuotes(symbols);
    expect(Object.keys(quotes)).toHaveLength(250);
    expect(quotes.S249).toEqual({ symbol: 'S249' });
    const sizes = ddbMock.commandCalls(BatchGetCommand).map((c) => c.args[0].input.RequestItems!.tbl!.Keys!.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('retries only the unprocessed keys with exponential backoff', async () => {
    vi.useFakeTimers();
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { tbl: [{ PK: 'TICKER#A', SK: 'QUOTE#LATEST', symbol: 'A', price: 1 }] },
        UnprocessedKeys: { tbl: { Keys: [{ PK: 'TICKER#B', SK: 'QUOTE#LATEST' }] } },
      })
      .resolvesOnce({ UnprocessedKeys: { tbl: { Keys: [{ PK: 'TICKER#B', SK: 'QUOTE#LATEST' }] } } })
      .resolvesOnce({ Responses: { tbl: [{ PK: 'TICKER#B', SK: 'QUOTE#LATEST', symbol: 'B', price: 2 }] }, UnprocessedKeys: {} });
    const promise = repo.getQuotes(['A', 'B']);
    await vi.advanceTimersByTimeAsync(99);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(1); // first retry waits 100ms
    await vi.advanceTimersByTimeAsync(1);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200); // second retry waits 200ms
    expect(await promise).toEqual({ A: { symbol: 'A', price: 1 }, B: { symbol: 'B', price: 2 } });
    const calls = ddbMock.commandCalls(BatchGetCommand);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.args[0].input.RequestItems!.tbl!.Keys).toEqual([{ PK: 'TICKER#B', SK: 'QUOTE#LATEST' }]);
  });

  it('gives up after 9 attempts when keys stay unprocessed', async () => {
    vi.useFakeTimers();
    ddbMock.on(BatchGetCommand).resolves({ UnprocessedKeys: { tbl: { Keys: [{ PK: 'TICKER#A', SK: 'QUOTE#LATEST' }] } } });
    const promise = repo.getQuotes(['A']);
    const assertion = expect(promise).rejects.toThrow('BatchGet: unprocessed keys remain after retries');
    await vi.runAllTimersAsync();
    await assertion;
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(9);
  });
});

describe('DynamoRepository single-item operations', () => {
  it('deleteTransaction deletes by the single-table key', async () => {
    ddbMock.on(DeleteCommand).resolves({});
    await repo.deleteTransaction(txn);
    expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input).toEqual({ TableName: 'tbl', Key: { PK: 'USER#u', SK: 'TXN#2025-01-01#i' } });
  });

  it('propagates conditional-check failures from putTransaction', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ConditionalCheckFailedException'));
    await expect(repo.putTransaction(txn)).rejects.toThrow('ConditionalCheckFailedException');
  });

  it('getFx returns the rates without keys, or null when absent', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: { PK: 'FX#EUR', SK: 'LATEST', entityType: 'FX', base: 'EUR', rates: { USD: 1.1 }, asOf: 't' } })
      .resolvesOnce({});
    expect(await repo.getFx('EUR')).toEqual({ base: 'EUR', rates: { USD: 1.1 }, asOf: 't' });
    expect(await repo.getFx('GBP')).toBeNull();
    expect(ddbMock.commandCalls(GetCommand).map((c) => c.args[0].input.Key)).toEqual([
      { PK: 'FX#EUR', SK: 'LATEST' },
      { PK: 'FX#GBP', SK: 'LATEST' },
    ]);
  });

  it('registerUser stamps timestamps and preserves createdAt', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05.000Z'), toFake: ['Date'] });
    ddbMock.on(UpdateCommand).resolves({});
    await repo.registerUser('u');
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
    expect(input.ExpressionAttributeValues).toEqual({ ':t': 'USER', ':u': 'u', ':now': '2026-01-02T03:04:05.000Z' });
  });

  it('trackTickers upserts one item per ticker without overwriting an existing currency', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repo.trackTickers([
      { symbol: 'A', currency: 'EUR' },
      { symbol: 'B', currency: 'USD' },
    ]);
    const inputs = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({
      TableName: 'tbl',
      Key: { PK: 'TRACKED', SK: 'TICKER#B' },
      ExpressionAttributeValues: { ':t': 'TRACKED_TICKER', ':s': 'B', ':c': 'USD' },
    });
    expect(inputs[1]!.UpdateExpression).toContain('currency = if_not_exists(currency, :c)');
  });

  it('trackTickers is a no-op for an empty list', async () => {
    await repo.trackTickers([]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  const status: ImportStatus = { importId: 'imp', userId: 'u', fileName: 'a.csv', status: 'PENDING', createdAt: 't', updatedAt: 't' };

  it('putImport stores the import under the user partition', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repo.putImport(status);
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input).toEqual({
      TableName: 'tbl',
      Item: { PK: 'USER#u', SK: 'IMPORT#imp', entityType: 'IMPORT', ...status },
    });
  });

  it('getImport uses a consistent read and returns null when missing', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: { PK: 'USER#u', SK: 'IMPORT#imp', entityType: 'IMPORT', ...status } })
      .resolvesOnce({});
    expect(await repo.getImport('u', 'imp')).toEqual(status);
    expect(await repo.getImport('u', 'nope')).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input).toEqual({
      TableName: 'tbl',
      Key: { PK: 'USER#u', SK: 'IMPORT#imp' },
      ConsistentRead: true,
    });
  });
});
