import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('falls back to local defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      tableName: 'portfolio-tracker-local',
      eventBusName: 'portfolio-tracker-local',
      importBucket: 'portfolio-tracker-imports-local',
      endpointUrl: undefined,
      region: 'eu-west-1',
    });
  });

  it('reads every setting from the environment', () => {
    expect(
      loadConfig({ TABLE_NAME: 't', EVENT_BUS_NAME: 'e', IMPORT_BUCKET: 'b', AWS_ENDPOINT_URL: 'http://localhost:4566', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'ap-south-1' }),
    ).toEqual({ tableName: 't', eventBusName: 'e', importBucket: 'b', endpointUrl: 'http://localhost:4566', region: 'us-east-1' });
  });

  it('uses AWS_DEFAULT_REGION when AWS_REGION is absent and treats an empty endpoint as unset', () => {
    expect(loadConfig({ AWS_DEFAULT_REGION: 'ap-south-1', AWS_ENDPOINT_URL: '' })).toMatchObject({ region: 'ap-south-1', endpointUrl: undefined });
  });

  it('reads process.env by default', () => {
    const prev = process.env.TABLE_NAME;
    process.env.TABLE_NAME = 'from-process-env';
    try {
      expect(loadConfig().tableName).toBe('from-process-env');
    } finally {
      if (prev === undefined) delete process.env.TABLE_NAME;
      else process.env.TABLE_NAME = prev;
    }
  });
});
