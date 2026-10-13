import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

type ClientConfig = { region: () => Promise<string>; endpoint?: () => Promise<{ hostname: string; port?: number; protocol: string }> };
const clientConfig = (thisValue: unknown) => (thisValue as { config: ClientConfig }).config;

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  // Static credentials so presigning never touches a real credential chain.
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createAwsDeps', () => {
  it('wires repository, publisher and signer to the configured resources (AWS)', async () => {
    const config = loadConfig({ TABLE_NAME: 'tbl', EVENT_BUS_NAME: 'bus', IMPORT_BUCKET: 'bkt', AWS_REGION: 'eu-central-1' });
    const deps = createAwsDeps(config);
    expect(deps.config).toBe(config);

    ddbMock.on(GetCommand).resolves({ Item: { PK: 'FX#EUR', SK: 'LATEST', base: 'EUR', rates: {}, asOf: 'x' } });
    expect(await deps.repo.getFx('EUR')).toEqual({ base: 'EUR', rates: {}, asOf: 'x' });
    const get = ddbMock.commandCalls(GetCommand)[0]!;
    expect(get.args[0].input.TableName).toBe('tbl');
    const ddbConfig = clientConfig(get.thisValue);
    expect(await ddbConfig.region()).toBe('eu-central-1');

    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    await deps.events.transactionsChanged({ userId: 'u', portfolioId: 'default', symbols: ['A'], reason: 'CREATED' });
    const put = ebMock.commandCalls(PutEventsCommand)[0]!;
    expect(put.args[0].input.Entries![0]!.EventBusName).toBe('bus');
    expect(await clientConfig(put.thisValue).region()).toBe('eu-central-1');

    const url = new URL(await deps.signer.signCsvUpload('imports/u/i.csv', 60));
    expect(url.hostname).toBe('bkt.s3.eu-central-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('points every client at a custom endpoint when configured (LocalStack)', async () => {
    const deps = createAwsDeps(
      loadConfig({ AWS_ENDPOINT_URL: 'http://localhost:4566', AWS_REGION: 'eu-west-1', IMPORT_BUCKET: 'bkt' }),
    );
    ddbMock.on(GetCommand).resolves({});
    expect(await deps.repo.getFx('EUR')).toBeNull();
    const ddbEndpoint = await clientConfig(ddbMock.commandCalls(GetCommand)[0]!.thisValue).endpoint!();
    expect(ddbEndpoint).toMatchObject({ hostname: 'localhost', port: 4566, protocol: 'http:' });

    ebMock.on(PutEventsCommand).resolves({});
    await deps.events.transactionsChanged({ userId: 'u', portfolioId: 'default', symbols: [], reason: 'DELETED' });
    const ebEndpoint = await clientConfig(ebMock.commandCalls(PutEventsCommand)[0]!.thisValue).endpoint!();
    expect(ebEndpoint).toMatchObject({ hostname: 'localhost', port: 4566 });

    const url = new URL(await deps.signer.signCsvUpload('imports/u/i.csv', 300));
    expect(`${url.origin}${url.pathname}`).toBe('http://localhost:4566/bkt/imports/u/i.csv');
  });

  it('provides a real clock and random UUIDs', () => {
    const deps = createAwsDeps(loadConfig({}));
    const before = Date.now();
    const now = deps.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    const a = deps.uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deps.uuid()).not.toBe(a);
  });
});
