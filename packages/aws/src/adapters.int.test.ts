import { afterAll, beforeAll, describe, expect } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { runFileStoreContract, runItemStoreContract, runSecretStoreContract } from '@portfolio/platform/testing';
import { createDocClient } from './clients.js';
import { DynamoItemStore } from './dynamo-item-store.js';
import { createPresignS3Client, S3FileStore } from './s3-file-store.js';
import { SecretsManagerSecretStore } from './secrets-manager-secret-store.js';
import { LOCALSTACK_ENDPOINT, localAwsConfig, localStackAvailable } from './testing/localstack.js';

const available = await localStackAvailable();
const runId = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
const TABLE = `portfolio-tracker-it-contract-${runId}`;
const BUCKET = `portfolio-tracker-it-contract-${runId}`;

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

/** The ports against the real AWS SDK clients (LocalStack): the same contract suites the in-memory implementations pass. */
describe.skipIf(!available)('AWS adapters against LocalStack', () => {
  const ddb = new DynamoDBClient(localAwsConfig);
  const s3 = new S3Client({ ...localAwsConfig, forcePathStyle: true });

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await ddb.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
    const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET })).catch(() => ({ Contents: [] }));
    await Promise.all(Contents.map((o) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key }))));
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
  });

  runItemStoreContract('DynamoItemStore', () => new DynamoItemStore(createDocClient({ region: 'eu-west-1', endpointUrl: LOCALSTACK_ENDPOINT }), TABLE));

  runSecretStoreContract('SecretsManagerSecretStore', () => new SecretsManagerSecretStore(new SecretsManagerClient(localAwsConfig)));

  runFileStoreContract('S3FileStore', () => ({
    store: new S3FileStore(createPresignS3Client(localAwsConfig), BUCKET),
    upload: async (target, content) => {
      const res = await fetch(target.url, { method: target.method, headers: target.headers, body: content });
      expect(res.ok).toBe(true);
    },
  }));
});
