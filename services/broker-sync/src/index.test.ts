import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.doUnmock('./clients.js');
});

describe('Lambda entry point', () => {
  it('builds the AWS dependencies once, lazily, from the environment', async () => {
    vi.stubEnv('TABLE_NAME', 'prod-table');
    vi.stubEnv('BROKER_SECRET_PREFIX', '/portfolio-tracker/prod/broker/trading212');
    const store = { listUserIds: vi.fn().mockResolvedValue([]) };
    const createAwsDeps = vi.fn((_config: unknown) => ({ store }));
    vi.doMock('./clients.js', () => ({ createAwsDeps }));
    const { handler } = await import('./index.js');
    expect(createAwsDeps).not.toHaveBeenCalled();
    await handler({ all: true });
    await handler({ all: true });
    expect(createAwsDeps).toHaveBeenCalledTimes(1);
    expect(createAwsDeps.mock.calls[0]![0]).toMatchObject({ tableName: 'prod-table', secretPrefix: '/portfolio-tracker/prod/broker/trading212' });
    expect(store.listUserIds).toHaveBeenCalledTimes(2);
  });
});

describe('library surface', () => {
  it('exposes what the API needs, without the AWS composition', async () => {
    const keys = Object.keys(await import('./lib.js'));
    expect(keys).toEqual(expect.arrayContaining(['createHandler', 'brokerSyncJob', 'syncJob', 'Trading212Client', 'SecretCredentialStore', 'ItemBrokerStore', 'BrokerError', 'MemoryBrokerStore']));
    expect(keys).not.toEqual(expect.arrayContaining(['createAwsDeps']));
    expect(keys).not.toContain('loadConfig');
  });

  it('keeps the AWS composition on its own entry', async () => {
    expect(Object.keys(await import('./aws.js'))).toEqual(expect.arrayContaining(['createAwsDeps', 'createCredentialStore', 'createItemStore', 'loadConfig']));
  });
});
