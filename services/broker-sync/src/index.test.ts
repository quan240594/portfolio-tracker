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
  it('exposes what the API needs', async () => {
    const lib = await import('./lib.js');
    expect(Object.keys(lib)).toEqual(expect.arrayContaining(['createHandler', 'createAwsDeps', 'Trading212Client', 'SecretsManagerCredentialStore', 'DynamoBrokerStore', 'BrokerError', 'loadConfig', 'MemoryBrokerStore']));
  });
});

describe('logger', () => {
  it('defaults to INFO and honours LOG_LEVEL', async () => {
    vi.stubEnv('LOG_LEVEL', '');
    const quiet = await import('./logger.js');
    expect(quiet.logger).toBeDefined();
    vi.resetModules();
    vi.stubEnv('LOG_LEVEL', 'debug');
    expect((await import('./logger.js')).logger.getLevelName()).toBe('DEBUG');
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.LOG_LEVEL;
    expect((await import('./logger.js')).logger.getLevelName()).toBe('INFO');
  });
});
