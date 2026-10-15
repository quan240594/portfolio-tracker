import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { PutEventsCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { awsCommon, createAwsDeps, createDocClient } from './clients.js';
import { loadConfig } from './config.js';
import { Trading212Client } from './t212/client.js';

const ddb = mockClient(DynamoDBDocumentClient);
const eb = mockClient(EventBridgeClient);
const sm = mockClient(SecretsManagerClient);

beforeEach(() => {
  ddb.reset();
  eb.reset();
  sm.reset();
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
});

describe('createAwsDeps', () => {
  it('wires the store, publisher and secrets to the configured resources', async () => {
    const config = loadConfig({ TABLE_NAME: 'tbl', EVENT_BUS_NAME: 'bus', BROKER_SECRET_PREFIX: '/p/t', T212_SYMBOL_OVERRIDES: '{"A":"B"}' });
    const deps = createAwsDeps(config);
    expect(deps.symbolOverrides).toEqual({ A: 'B' });
    expect(deps.now()).toBeInstanceOf(Date);

    ddb.on(GetCommand).resolves({});
    await deps.store.getState('u', 'p');
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.TableName).toBe('tbl');

    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    await deps.events.transactionsChanged({ userId: 'u', portfolioId: 'p', symbols: ['A'], reason: 'IMPORTED' });
    expect(eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!.EventBusName).toBe('bus');

    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ apiKey: 'k', apiSecret: 's', environment: 'demo' }) });
    expect(await deps.credentials.get('u')).toEqual({ apiKey: 'k', apiSecret: 's', environment: 'demo' });
    expect(sm.commandCalls(GetSecretValueCommand)[0]!.args[0].input.SecretId).toBe('/p/t/u');

    expect(deps.createApi({ apiKey: 'k', apiSecret: 's', environment: 'live' })).toBeInstanceOf(Trading212Client);
  });

  it('points every client at a custom endpoint (LocalStack)', async () => {
    const config = loadConfig({ AWS_ENDPOINT_URL: 'http://localhost:4573', AWS_REGION: 'eu-central-1' });
    expect(awsCommon(config)).toEqual({ region: 'eu-central-1', endpoint: 'http://localhost:4573' });
    expect(awsCommon(loadConfig({}))).toEqual({ region: 'eu-west-1' });
    ddb.on(GetCommand).resolves({});
    await new (await import('./store.js')).DynamoBrokerStore(createDocClient(config), 't').getState('u', 'p');
    const get = ddb.commandCalls(GetCommand)[0]!;
    const clientConfig = (get.thisValue as { config: { endpoint: () => Promise<{ hostname: string; port?: number }> } }).config;
    expect(await clientConfig.endpoint()).toMatchObject({ hostname: 'localhost', port: 4573 });
  });
});
