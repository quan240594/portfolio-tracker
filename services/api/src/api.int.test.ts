import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { CreateEventBusCommand, DeleteEventBusCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { importObjectKey } from '@portfolio/shared';
import { createHandler } from './app.js';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';
import { apiEvent } from './testing/fakes.js';
import { LOCALSTACK_ENDPOINT, localAwsConfig, localStackAvailable } from './testing/localstack.js';
import { seed } from '../scripts/seed.js';

const available = await localStackAvailable();
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Isolated resources so the suite never touches the shared developer table/bucket.
const TABLE = `portfolio-tracker-it-${runId}`;
const BUCKET = `portfolio-tracker-imports-it-${runId}`;
const BUS = `portfolio-tracker-it-${runId}`;

describe.skipIf(!available)('api against LocalStack', () => {
  const ddb = new DynamoDBClient(localAwsConfig);
  const s3 = new S3Client({ ...localAwsConfig, forcePathStyle: true });
  const eb = new EventBridgeClient(localAwsConfig);
  const config = loadConfig({
    TABLE_NAME: TABLE,
    IMPORT_BUCKET: BUCKET,
    EVENT_BUS_NAME: BUS,
    AWS_ENDPOINT_URL: LOCALSTACK_ENDPOINT,
    AWS_REGION: 'eu-west-1',
  });
  const handler = createHandler(() => createAwsDeps(config));
  const call = async (...args: Parameters<typeof apiEvent>) => {
    const res = await handler(apiEvent(...args));
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

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
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' } }));
    await eb.send(new CreateEventBusCommand({ Name: BUS }));
    await seed({ doc: DynamoDBDocumentClient.from(ddb), tableName: TABLE, userId: 'demo', log: () => {} });
  });

  afterAll(async () => {
    const objs = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET })).catch(() => ({ Contents: [] }));
    for (const o of objs.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key! }));
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => {});
    await eb.send(new DeleteEventBusCommand({ Name: BUS })).catch(() => {});
    await ddb.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => {});
  });

  it('seed is idempotent', async () => {
    const before = (await call('GET', '/transactions')).body.transactions.length;
    await seed({ doc: DynamoDBDocumentClient.from(ddb), tableName: TABLE, userId: 'demo', log: () => {} });
    expect((await call('GET', '/transactions')).body.transactions.length).toBe(before);
  });

  it('GET /portfolio returns a non-zero value for the seeded demo user', async () => {
    const { status, body } = await call('GET', '/portfolio');
    expect(status).toBe(200);
    expect(body.baseCurrency).toBe('EUR');
    expect(body.totalValue).toBeGreaterThan(0);
    expect(body.holdingsCount).toBe(6);
  });

  it('serves holdings, allocation, history and dividends from seeded data', async () => {
    const holdings = await call('GET', '/holdings');
    expect(holdings.body.holdings.every((h: { priceStale: boolean }) => !h.priceStale)).toBe(true);
    const alloc = await call('GET', '/allocation', { query: { by: 'currency' } });
    expect(alloc.body.slices.map((s: { key: string }) => s.key).sort()).toEqual(['EUR', 'USD']);
    const history = await call('GET', '/history', { query: { range: 'ALL' } });
    expect(history.status).toBe(200);
    expect(history.body.points.length).toBeGreaterThan(300);
    expect(history.body.points.length).toBeLessThanOrEqual(400);
    const dividends = await call('GET', '/dividends');
    expect(dividends.body.received.length).toBeGreaterThan(0);
    expect(dividends.body.upcoming.length).toBeGreaterThan(0);
  });

  it('creates and deletes a transaction', async () => {
    const created = await call('POST', '/transactions', { body: { date: '2026-01-05', type: 'BUY', symbol: 'SAP.DE', quantity: 1, price: 200, currency: 'EUR' } });
    expect(created.status).toBe(201);
    const oversell = await call('POST', '/transactions', { body: { date: '2026-01-06', type: 'SELL', symbol: 'SAP.DE', quantity: 2, price: 200, currency: 'EUR' } });
    expect(oversell.status).toBe(422);
    expect((await call('DELETE', `/transactions/${created.body.id}`)).status).toBe(204);
    expect((await call('DELETE', `/transactions/${created.body.id}`)).status).toBe(404);
  });

  it('issues a presigned URL that accepts a CSV upload', async () => {
    const created = await call('POST', '/imports', { body: { fileName: 'trades.csv' } });
    expect(created.status).toBe(201);
    const put = await fetch(created.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: 'date,type,symbol,quantity,price,fee,currency\n2026-01-02,BUY,AAPL,1,200,0,USD\n',
    });
    expect(put.status).toBe(200);
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: importObjectKey('demo', created.body.importId) }));
    expect(head.ContentType).toBe('text/csv');
    const status = await call('GET', `/imports/${created.body.importId}`);
    expect(status.body).toMatchObject({ status: 'PENDING', fileName: 'trades.csv' });
  });
});
