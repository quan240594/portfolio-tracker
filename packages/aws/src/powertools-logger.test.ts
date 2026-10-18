import { Logger as Powertools } from '@aws-lambda-powertools/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adaptPowertools, createPowertoolsLogger } from './powertools-logger.js';
import { awsClientConfig, createDocClient } from './clients.js';

afterEach(() => vi.restoreAllMocks());

describe('adaptPowertools', () => {
  it('forwards messages with and without fields, keys and children', () => {
    const powertools = new Powertools({ serviceName: 't', logLevel: 'SILENT' });
    const info = vi.spyOn(powertools, 'info');
    const error = vi.spyOn(powertools, 'error');
    vi.spyOn(powertools, 'debug');
    vi.spyOn(powertools, 'warn');
    const append = vi.spyOn(powertools, 'appendKeys');
    const remove = vi.spyOn(powertools, 'removeKeys');
    const child = new Powertools({ serviceName: 'child', logLevel: 'SILENT' });
    const createChild = vi.spyOn(powertools, 'createChild').mockReturnValue(child);
    const childInfo = vi.spyOn(child, 'info');

    const logger = adaptPowertools(powertools);
    logger.debug('d');
    logger.info('hello');
    logger.warn('w', { a: 1 });
    logger.error('bad', { error: new Error('x') });
    logger.appendKeys({ requestId: 'r' });
    logger.removeKeys(['requestId']);
    logger.createChild({ persistentKeys: { userId: 'u' } }).info('from child', { n: 1 });
    logger.createChild().info('plain');

    expect(info).toHaveBeenCalledWith('hello');
    expect(error).toHaveBeenCalledWith('bad', { error: expect.any(Error) });
    expect(append).toHaveBeenCalledWith({ requestId: 'r' });
    expect(remove).toHaveBeenCalledWith(['requestId']);
    expect(createChild).toHaveBeenNthCalledWith(1, { persistentKeys: { userId: 'u' } });
    expect(createChild).toHaveBeenNthCalledWith(2, {});
    expect(childInfo).toHaveBeenCalledWith('from child', { n: 1 });
  });
});

describe('createPowertoolsLogger', () => {
  it('reads the level from LOG_LEVEL (default INFO)', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const debugAndInfo = (env: Record<string, string | undefined>) => {
      const logger = createPowertoolsLogger('svc', env);
      logger.debug('d');
      logger.info('i');
    };
    debugAndInfo({});
    debugAndInfo({ LOG_LEVEL: 'silent' });
    debugAndInfo({ LOG_LEVEL: 'debug' });
    expect(write.mock.calls.length + log.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('defaults to process.env', () => {
    expect(createPowertoolsLogger('svc')).toBeDefined();
  });
});

describe('clients', () => {
  it('only sets an endpoint when one is given', () => {
    expect(awsClientConfig({ region: 'eu-west-1' })).toEqual({ region: 'eu-west-1' });
    expect(awsClientConfig({ region: 'eu-west-1', endpointUrl: 'http://localhost:4566' })).toEqual({ region: 'eu-west-1', endpoint: 'http://localhost:4566' });
  });

  it('creates a document client that drops undefined values', () => {
    const doc = createDocClient({ region: 'eu-west-1' });
    expect(doc.config.translateConfig?.marshallOptions?.removeUndefinedValues).toBe(true);
  });
});
