import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { Transaction } from '@portfolio/shared';
import { createHandler } from './app.js';
import { EventBridgePublisher } from './events.js';
import { S3ObjectReader } from './objects.js';
import { DynamoIngestStore } from './store.js';
import { eventBridgeBody, s3NotificationBody, sqsEvent } from './testing/fakes.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ebMock = mockClient(EventBridgeClient);

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const store = new DynamoIngestStore(doc, 'tbl', async () => {});
const s3 = new S3Client({ region: 'eu-west-1' });
const body = (text: string) => ({ transformToString: async () => text }) as never;

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ebMock.reset();
});

const txns = (n: number): Transaction[] =>
  Array.from({ length: n }, (_, i) => ({ id: `imp-${i + 1}`, userId: 'u', portfolioId: 'p1', date: '2025-01-01', type: 'BUY', symbol: 'A', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: 'x', importId: 'imp' }));

describe('DynamoIngestStore', () => {
  it('writes in chunks of 25 and retries UnprocessedItems', async () => {
    let first = true;
    ddbMock.on(BatchWriteCommand).callsFake((input) => {
      const reqs = input.RequestItems.tbl;
      if (first) {
        first = false;
        return { UnprocessedItems: { tbl: reqs.slice(20) } };
      }
      return { UnprocessedItems: {} };
    });
    await store.putTransactions(txns(60));
    const calls = ddbMock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.tbl!.length);
    expect(calls).toEqual([25, 5, 25, 10]);
    const item = ddbMock.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.tbl![0]!.PutRequest!.Item;
    expect(item).toMatchObject({ PK: 'USER#u', SK: 'TXN#p1#2025-01-01#imp-1', entityType: 'TRANSACTION', importId: 'imp', portfolioId: 'p1' });
  });

  it('gives up after repeated UnprocessedItems so the message is retried', async () => {
    ddbMock.on(BatchWriteCommand).callsFake((input) => ({ UnprocessedItems: input.RequestItems }));
    await expect(store.putTransactions(txns(3))).rejects.toThrow(/unprocessed/);
  });

  it('markProcessing returns false when the condition fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'nope', $metadata: {} }));
    expect(await store.markProcessing('u', 'i')).toBe(false);
  });
});

describe('S3ObjectReader', () => {
  const reader = new S3ObjectReader(s3);
  it('rejects objects larger than the limit without reading the body', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 2_000_000, Body: body('x') });
    expect(await reader.readText('b', 'k', 1024 * 1024)).toEqual({ ok: false, reason: expect.stringContaining('too large') });
  });
  it('maps NoSuchKey to a permanent failure', async () => {
    s3Mock.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'gone', $metadata: {} }));
    expect(await reader.readText('b', 'k', 10)).toEqual({ ok: false, reason: 'Uploaded file not found' });
  });
});

describe('handler with AWS SDK clients (mocked)', () => {
  const handler = createHandler(() => ({
    store,
    reader: new S3ObjectReader(s3),
    events: new EventBridgePublisher(new EventBridgeClient({ region: 'eu-west-1' }), 'bus'),
    now: () => new Date('2026-06-15T12:00:00.000Z'),
  }));
  const pending = { PK: 'USER#demo', SK: 'IMPORT#i1', importId: 'i1', userId: 'demo', portfolioId: 'default', fileName: 'f.csv', status: 'PENDING', createdAt: 'x', updatedAt: 'x' };

  it('imports end-to-end and publishes from portfolio.ingest', async () => {
    ddbMock.on(GetCommand).resolves({ Item: pending });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 80, Body: body('date,type,symbol,quantity,price,fee,currency\n2025-01-02,BUY,AAPL,1,100,0,USD\n') });
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });

    const res = await handler(sqsEvent(s3NotificationBody('bucket', 'imports/demo/i1.csv')));
    expect(res.batchItemFailures).toEqual([]);
    expect(s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'bucket', Key: 'imports/demo/i1.csv' });
    const entry = ebMock.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry).toMatchObject({ Source: 'portfolio.ingest', DetailType: 'TransactionsChanged', EventBusName: 'bus' });
    expect(JSON.parse(entry.Detail!)).toEqual({ userId: 'demo', portfolioId: 'default', symbols: ['AAPL'], reason: 'IMPORTED', importId: 'i1' });
    expect(ddbMock.commandCalls(GetCommand).map((c) => c.args[0].input.Key)).toEqual([
      { PK: 'USER#demo', SK: 'IMPORT#i1' },
      { PK: 'USER#demo', SK: 'PORTFOLIO#default' },
    ]);
    const written = ddbMock.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.tbl![0]!.PutRequest!.Item;
    expect(written).toMatchObject({ SK: 'TXN#default#2025-01-02#i1-1', portfolioId: 'default' });
    const statuses = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input.ExpressionAttributeValues?.[':completed'] ?? c.args[0].input.ExpressionAttributeValues?.[':processing']).filter(Boolean);
    expect(statuses).toEqual(['PROCESSING', 'COMPLETED']);
  });

  it('turns DynamoDB throttling into a batch item failure without marking the import FAILED', async () => {
    const throttle = Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
    ddbMock.on(GetCommand).resolves({ Item: pending });
    ddbMock
      .on(GetCommand, { Key: { PK: 'USER#demo', SK: 'PORTFOLIO#default' } })
      .resolvesOnce({ Item: { PK: 'USER#demo' } })
      .rejectsOnce(throttle);
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 80, Body: body('date,type,symbol,quantity,price,fee,currency\n2025-01-02,BUY,AAPL,1,100,0,USD\n') });
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });

    const res = await handler(sqsEvent(eventBridgeBody('bucket', 'imports/demo/i1.csv'), eventBridgeBody('bucket', 'imports/demo/i1.csv')));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    const failedUpdates = ddbMock.commandCalls(UpdateCommand).filter((c) => c.args[0].input.ExpressionAttributeValues?.[':failed']);
    expect(failedUpdates).toHaveLength(0);
  });

  it('retries when PutEvents fails (import stays PROCESSING)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: pending });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 80, Body: body('date,type,symbol,quantity,price,fee,currency\n2025-01-02,BUY,AAPL,1,100,0,USD\n') });
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
    const res = await handler(sqsEvent(eventBridgeBody('bucket', 'imports/demo/i1.csv')));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    const completed = ddbMock.commandCalls(UpdateCommand).filter((c) => c.args[0].input.ExpressionAttributeValues?.[':completed']);
    expect(completed).toHaveLength(0);
  });
});
