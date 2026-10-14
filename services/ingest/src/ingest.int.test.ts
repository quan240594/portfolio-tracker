import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutBucketNotificationConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CreateEventBusCommand, DeleteEventBusCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ENTITY, importObjectKey, keys } from '@portfolio/shared';
import type { SQSEvent } from 'aws-lambda';
import { createHandler } from './app.js';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';
import { LOCALSTACK_ENDPOINT, localAwsConfig, localStackAvailable } from './testing/localstack.js';

const available = await localStackAvailable();
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TABLE = `portfolio-tracker-it-${runId}`;
const BUCKET = `portfolio-tracker-imports-it-${runId}`;
const BUS = `portfolio-tracker-it-${runId}`;
const QUEUE = `portfolio-tracker-ingest-it-${runId}`;
const USER = 'it-user';
const PORTFOLIO = 'it-portfolio';

describe.skipIf(!available)('ingest against LocalStack (S3 notification -> SQS -> handler)', () => {
  const ddb = new DynamoDBClient(localAwsConfig);
  const doc = DynamoDBDocumentClient.from(ddb);
  const s3 = new S3Client({ ...localAwsConfig, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const sqs = new SQSClient(localAwsConfig);
  const eb = new EventBridgeClient(localAwsConfig);
  let queueUrl = '';
  const handler = createHandler(() =>
    createAwsDeps(loadConfig({ TABLE_NAME: TABLE, IMPORT_BUCKET: BUCKET, EVENT_BUS_NAME: BUS, AWS_ENDPOINT_URL: LOCALSTACK_ENDPOINT, AWS_REGION: 'eu-west-1' })),
  );

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    await ddb.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      }),
    );
    await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: TABLE });
    await eb.send(new CreateEventBusCommand({ Name: BUS }));
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: QUEUE }))).QueueUrl!;
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' } }));
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: BUCKET,
        NotificationConfiguration: {
          QueueConfigurations: [
            { QueueArn: Attributes!.QueueArn!, Events: ['s3:ObjectCreated:*'], Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'imports/' }] } } },
          ],
        },
      }),
    );
  });

  afterAll(async () => {
    const objs = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET })).catch(() => ({ Contents: [] }));
    for (const o of objs.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key! }));
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => {});
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
    await eb.send(new DeleteEventBusCommand({ Name: BUS })).catch(() => {});
    await ddb.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => {});
  });

  async function createImport(importId: string, portfolioId = PORTFOLIO) {
    const ts = new Date().toISOString();
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...keys.portfolio(USER, PORTFOLIO), entityType: ENTITY.portfolio, portfolioId: PORTFOLIO, userId: USER, name: 'IT', createdAt: ts, updatedAt: ts },
      }),
    );
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...keys.import(USER, importId), entityType: ENTITY.import, importId, userId: USER, portfolioId, fileName: 'x.csv', status: 'PENDING', createdAt: ts, updatedAt: ts },
      }),
    );
  }

  async function receiveFor(key: string): Promise<Message[]> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 5 }));
      const mine = Messages.filter((m) => m.Body?.includes(key.split('/').pop()!));
      if (mine.length) return mine;
    }
    throw new Error(`No S3 notification received for ${key}`);
  }

  const toEvent = (messages: Message[]): SQSEvent =>
    ({ Records: messages.map((m) => ({ messageId: m.MessageId!, receiptHandle: m.ReceiptHandle!, body: m.Body! })) }) as SQSEvent;

  const userTransactions = async () =>
    (
      await doc.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': keys.user(USER).PK, ':sk': keys.transactionPrefix },
        }),
      )
    ).Items ?? [];

  const getImport = async (importId: string) =>
    (await doc.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND SK = :sk', ExpressionAttributeValues: { ':pk': keys.user(USER).PK, ':sk': keys.import(USER, importId).SK } }))).Items?.[0];

  it('uploads via presigned URL, receives the S3 notification and writes the transactions', async () => {
    const importId = `ok-${runId}`;
    await createImport(importId);
    const key = importObjectKey(USER, importId);
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'text/csv' }), { expiresIn: 300 });
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Date,Type,Symbol,Quantity,Price,Fee,Currency,Note\n2025-01-02,BUY,AAPL,10,150,1,USD,\n2025-02-03,SELL,AAPL,4,160,1,USD,trim\n2025-03-01,BUY,ASML.AS,2,650,2,EUR,\n',
    });
    expect(put.status).toBe(200);

    const messages = await receiveFor(key);
    expect(JSON.parse(messages[0]!.Body!).Records[0].s3.object.key).toBe(key);
    const res = await handler(toEvent(messages));
    expect(res.batchItemFailures).toEqual([]);

    expect(await getImport(importId)).toMatchObject({ status: 'COMPLETED', rowCount: 3, importedCount: 3 });
    const txns = await userTransactions();
    expect(txns.map((t) => t.id).sort()).toEqual([`${importId}-1`, `${importId}-2`, `${importId}-3`]);
    expect(txns.every((t) => t.portfolioId === PORTFOLIO && String(t.SK).startsWith(keys.portfolioTransactionPrefix(PORTFOLIO)))).toBe(true);

    // Redelivery is a no-op.
    expect((await handler(toEvent(messages))).batchItemFailures).toEqual([]);
    expect(await userTransactions()).toHaveLength(3);
  });

  it('marks an import FAILED and writes nothing when a row oversells', async () => {
    const importId = `bad-${runId}`;
    await createImport(importId);
    const key = importObjectKey(USER, importId);
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'text/csv', Body: 'date,type,symbol,quantity,price,fee,currency\n2025-04-01,BUY,MSFT,1,400,0,USD\n2025-04-02,SELL,MSFT,5,400,0,USD\n' }),
    );
    const res = await handler(toEvent(await receiveFor(key)));
    expect(res.batchItemFailures).toEqual([]);
    const imp = await getImport(importId);
    expect(imp).toMatchObject({ status: 'FAILED', importedCount: 0 });
    expect(imp!.errors[0]).toMatchObject({ row: 2 });
    expect((await userTransactions()).filter((t) => t.symbol === 'MSFT')).toHaveLength(0);
  });

  it('marks an import FAILED when its portfolio does not exist', async () => {
    const importId = `noportfolio-${runId}`;
    await createImport(importId, 'missing-portfolio');
    const key = importObjectKey(USER, importId);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'text/csv', Body: 'date,type,symbol,quantity,price,fee,currency\n2025-04-01,BUY,SAP.DE,1,200,0,EUR\n' }));
    expect((await handler(toEvent(await receiveFor(key)))).batchItemFailures).toEqual([]);
    expect(await getImport(importId)).toMatchObject({ status: 'FAILED', errors: [{ row: 0, message: 'Portfolio missing-portfolio not found' }] });
  });
});
