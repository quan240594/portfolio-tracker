import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryItemStore, MemorySecretStore, RecordingEventPublisher } from '@portfolio/platform';
import { loadConfig } from './config.js';
import { createAwsDeps, createCredentialStore, createItemStore } from './clients.js';
import { Trading212Client } from './t212/client.js';

const aws = vi.hoisted(() => ({
  createDynamoItemStore: vi.fn(),
  createEventBridgePublisher: vi.fn(),
  createSecretStore: vi.fn(),
}));
vi.mock('@portfolio/aws', () => aws);

const credentials = { apiKey: 'k', apiSecret: 's', environment: 'demo' } as const;

beforeEach(() => {
  aws.createDynamoItemStore.mockReset().mockImplementation(() => new MemoryItemStore());
  aws.createEventBridgePublisher.mockReset().mockImplementation(() => new RecordingEventPublisher());
  aws.createSecretStore.mockReset().mockImplementation(() => new MemorySecretStore());
});

describe('createAwsDeps', () => {
  it('wires the store, publisher and secrets to the configured resources', async () => {
    const config = loadConfig({ TABLE_NAME: 'tbl', EVENT_BUS_NAME: 'bus', BROKER_SECRET_PREFIX: '/p/t', T212_SYMBOL_OVERRIDES: '{"A":"B"}', AWS_ENDPOINT_URL: 'http://localhost:4573', AWS_REGION: 'eu-central-1' });
    const deps = createAwsDeps(config);
    expect(deps.symbolOverrides).toEqual({ A: 'B' });
    expect(deps.now()).toBeInstanceOf(Date);
    expect(deps.createApi(credentials)).toBeInstanceOf(Trading212Client);

    const connection = { region: 'eu-central-1', endpointUrl: 'http://localhost:4573' };
    expect(aws.createDynamoItemStore).toHaveBeenCalledWith(connection, 'tbl');
    expect(aws.createEventBridgePublisher).toHaveBeenCalledWith(connection, 'bus', 'portfolio.broker');
    expect(aws.createSecretStore).toHaveBeenCalledWith(connection, 'Trading 212 read-only API credentials');

    await deps.credentials.get('u');
    const secrets = aws.createSecretStore.mock.results[0]!.value as MemorySecretStore;
    await secrets.put('/p/t/u', JSON.stringify(credentials));
    expect(await deps.credentials.get('u')).toEqual(credentials);
  });

  it('exposes the table and the credentials separately, for the API', async () => {
    const config = loadConfig({ TABLE_NAME: 'tbl', BROKER_SECRET_PREFIX: '/p/t' });
    expect(createItemStore(config)).toBeInstanceOf(MemoryItemStore);
    expect(await createCredentialStore(config).get('nobody')).toBeNull();
    expect(aws.createDynamoItemStore).toHaveBeenCalledWith({ region: 'eu-west-1', endpointUrl: undefined }, 'tbl');
  });
});
