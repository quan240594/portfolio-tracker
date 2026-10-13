import { describe, expect, it, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoRepository } from './repository.js';
import { EventBridgePublisher } from './events.js';
import { createPresignS3Client, S3UploadUrlSigner } from './presigner.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const repo = new DynamoRepository(doc, 'tbl');

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
});

describe('DynamoRepository', () => {
  it('queries transactions with pagination and strips key attributes', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: 'USER#u', SK: 'TXN#2025-01-01#a', entityType: 'TRANSACTION', id: 'a' }], LastEvaluatedKey: { PK: 'x' } })
      .resolvesOnce({ Items: [{ PK: 'USER#u', SK: 'TXN#2025-01-02#b', entityType: 'TRANSACTION', id: 'b' }] });
    const txns = await repo.listTransactions('u');
    expect(txns).toEqual([{ id: 'a' }, { id: 'b' }]);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0]!.args[0].input).toMatchObject({
      TableName: 'tbl',
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'USER#u', ':sk': 'TXN#' },
    });
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'x' });
  });

  it('queries EOD between date bounds', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repo.getEod('AAPL', '2025-01-01', '2025-02-01');
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'TICKER#AAPL',
      ':from': 'EOD#2025-01-01',
      ':to': 'EOD#2025-02-01',
    });
  });

  it('BatchGets quotes and retries unprocessed keys', async () => {
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { tbl: [{ PK: 'TICKER#A', SK: 'QUOTE#LATEST', symbol: 'A', price: 1 }] },
        UnprocessedKeys: { tbl: { Keys: [{ PK: 'TICKER#B', SK: 'QUOTE#LATEST' }] } },
      })
      .resolvesOnce({ Responses: { tbl: [{ PK: 'TICKER#B', SK: 'QUOTE#LATEST', symbol: 'B', price: 2 }] } });
    const quotes = await repo.getQuotes(['A', 'B']);
    expect(Object.keys(quotes).sort()).toEqual(['A', 'B']);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(2);
  });

  it('writes transactions with single-table keys and a create-only condition', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repo.putTransaction({ id: 'i', userId: 'u', date: '2025-01-01', type: 'BUY', symbol: 'A', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: 'x' });
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      Item: { PK: 'USER#u', SK: 'TXN#2025-01-01#i', entityType: 'TRANSACTION', id: 'i' },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
  });

  it('upserts USERS and TRACKED registry items', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repo.registerUser('u');
    await repo.trackTickers([{ symbol: 'AAPL', currency: 'USD' }]);
    const keys = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input.Key);
    expect(keys).toEqual([{ PK: 'USERS', SK: 'USER#u' }, { PK: 'TRACKED', SK: 'TICKER#AAPL' }]);
  });
});

describe('EventBridgePublisher', () => {
  const publisher = new EventBridgePublisher(new EventBridgeClient({ region: 'eu-west-1' }), 'bus');

  it('publishes TransactionsChanged from portfolio.api', async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: '1' }] });
    await publisher.transactionsChanged({ userId: 'u', symbols: ['A'], reason: 'CREATED' });
    const entry = ebMock.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry).toMatchObject({ EventBusName: 'bus', Source: 'portfolio.api', DetailType: 'TransactionsChanged' });
    expect(JSON.parse(entry.Detail!)).toEqual({ userId: 'u', symbols: ['A'], reason: 'CREATED' });
  });

  it('throws when an entry fails', async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }] });
    await expect(publisher.transactionsChanged({ userId: 'u', symbols: [], reason: 'DELETED' })).rejects.toThrow(/ThrottlingException/);
  });
});

describe('S3UploadUrlSigner', () => {
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

  it('presigns a PUT for the import key with 300s expiry', async () => {
    const signer = new S3UploadUrlSigner(createPresignS3Client({ region: 'eu-west-1', credentials }), 'bucket');
    const url = new URL(await signer.signCsvUpload('imports/u/i.csv', 300));
    expect(url.hostname).toBe('bucket.s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/imports/u/i.csv');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    // A checksum of the empty presign-time body would make S3 reject the real upload.
    expect([...url.searchParams.keys()].filter((k) => k.toLowerCase().includes('checksum'))).toEqual([]);
  });

  it('uses path-style URLs against a custom endpoint (LocalStack)', async () => {
    const s3 = createPresignS3Client({ region: 'eu-west-1', credentials, endpoint: 'http://localhost:4566' });
    const url = new URL(await new S3UploadUrlSigner(s3, 'bucket').signCsvUpload('imports/u/i.csv', 300));
    expect(`${url.origin}${url.pathname}`).toBe('http://localhost:4566/bucket/imports/u/i.csv');
  });
});
