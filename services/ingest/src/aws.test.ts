import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createHandler } from './app.js';
import { createAwsDeps } from './clients.js';
import { eventBridgeBody, s3NotificationBody, sqsEvent } from './testing/fakes.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ebMock = mockClient(EventBridgeClient);

const body = (text: string) => ({ transformToString: async () => text }) as never;
const CSV = 'date,type,symbol,quantity,price,fee,currency\n2025-01-02,BUY,AAPL,1,100,0,USD\n';

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ebMock.reset();
});

/** The whole ingestion through the real AWS adapters, with the SDK clients mocked. */
describe('handler with the AWS adapters (SDK clients mocked)', () => {
  const handler = createHandler(() => createAwsDeps({ tableName: 'tbl', eventBusName: 'bus', importBucket: 'bucket', region: 'eu-west-1' }));
  const pending = { PK: 'USER#demo', SK: 'IMPORT#i1', importId: 'i1', userId: 'demo', portfolioId: 'default', fileName: 'f.csv', status: 'PENDING', createdAt: 'x', updatedAt: 'x' };
  const statusWrites = () =>
    ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => Object.values(c.args[0].input.ExpressionAttributeValues ?? {}).find((v) => ['PROCESSING', 'COMPLETED', 'FAILED'].includes(String(v))))
      .filter(Boolean);

  function stubHappyPath() {
    ddbMock.on(GetCommand).resolves({ Item: pending });
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 80, Body: body(CSV) });
  }

  it('imports end-to-end and publishes from portfolio.ingest', async () => {
    stubHappyPath();
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
    expect(statusWrites()).toEqual(['PROCESSING', 'COMPLETED']);
  });

  it('turns DynamoDB throttling into a batch item failure without marking the import FAILED', async () => {
    const throttle = Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
    stubHappyPath();
    ddbMock
      .on(GetCommand, { Key: { PK: 'USER#demo', SK: 'PORTFOLIO#default' } })
      .resolvesOnce({ Item: { PK: 'USER#demo' } })
      .rejectsOnce(throttle);
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });

    const res = await handler(sqsEvent(eventBridgeBody('bucket', 'imports/demo/i1.csv'), eventBridgeBody('bucket', 'imports/demo/i1.csv')));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    expect(statusWrites()).not.toContain('FAILED');
  });

  it('retries when PutEvents fails (import stays PROCESSING)', async () => {
    stubHappyPath();
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
    const res = await handler(sqsEvent(eventBridgeBody('bucket', 'imports/demo/i1.csv')));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(statusWrites()).not.toContain('COMPLETED');
  });
});
