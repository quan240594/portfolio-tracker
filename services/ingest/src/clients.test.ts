import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createAwsDeps } from './clients.js';
import type { Config } from './config.js';
import { EventBridgePublisher } from './events.js';
import { S3ObjectReader } from './objects.js';
import { DynamoIngestStore } from './store.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ebMock = mockClient(EventBridgeClient);
const base: Config = { tableName: 'tbl', eventBusName: 'bus', importBucket: 'bkt', region: 'eu-central-1' };
const s3Of = (deps: ReturnType<typeof createAwsDeps>) => (deps.reader as unknown as { s3: S3Client }).s3;

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ebMock.reset();
});

describe('createAwsDeps', () => {
  it('wires the AWS adapters to the configured table, bus and region', async () => {
    const deps = createAwsDeps(base);
    expect(deps.store).toBeInstanceOf(DynamoIngestStore);
    expect(deps.reader).toBeInstanceOf(S3ObjectReader);
    expect(deps.events).toBeInstanceOf(EventBridgePublisher);

    ddbMock.on(GetCommand).resolves({});
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 0 });
    ebMock.on(PutEventsCommand).resolves({});
    await deps.store.getImport('u', 'i');
    await deps.reader.readText('bkt', 'k', 10);
    await deps.events.transactionsChanged({ userId: 'u', symbols: [], reason: 'IMPORTED' });
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input.TableName).toBe('tbl');
    expect(ebMock.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!.EventBusName).toBe('bus');

    const s3 = s3Of(deps);
    expect(await s3.config.region()).toBe('eu-central-1');
    expect(s3.config.forcePathStyle).toBe(false);
    expect(deps.now()).toBeInstanceOf(Date);
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('points every client at a custom endpoint with path-style S3 (LocalStack)', async () => {
    const deps = createAwsDeps({ ...base, endpointUrl: 'http://localhost:4566' });
    const s3 = s3Of(deps);
    expect(s3.config.forcePathStyle).toBe(true);
    expect(await s3.config.endpoint!()).toMatchObject({ hostname: 'localhost', port: 4566, protocol: 'http:' });
  });
});
