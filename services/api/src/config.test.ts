import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_CURRENCY, DEMO_USER_ID } from '@portfolio/shared';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('falls back to local defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      tableName: 'portfolio-tracker-local',
      eventBusName: 'portfolio-tracker-local',
      importBucket: 'portfolio-tracker-imports-local',
      baseCurrency: 'EUR',
      authMode: 'cognito',
      demoUserId: DEMO_USER_ID,
      corsAllowedOrigin: '*',
      endpointUrl: undefined,
      region: 'eu-west-1',
    });
  });

  it('defaults the base currency to DEFAULT_BASE_CURRENCY (EUR), also for blank values', () => {
    expect(DEFAULT_BASE_CURRENCY).toBe('EUR');
    expect(loadConfig({}).baseCurrency).toBe(DEFAULT_BASE_CURRENCY);
    expect(loadConfig({ BASE_CURRENCY: '' }).baseCurrency).toBe('EUR');
    expect(loadConfig({ BASE_CURRENCY: '   ' }).baseCurrency).toBe('EUR');
    expect(loadConfig({ BASE_CURRENCY: ' gbp ' }).baseCurrency).toBe('GBP');
  });

  it('reads every setting from the environment and upper-cases the base currency', () => {
    expect(
      loadConfig({
        TABLE_NAME: 't',
        EVENT_BUS_NAME: 'bus',
        IMPORT_BUCKET: 'bucket',
        BASE_CURRENCY: 'usd',
        AUTH_MODE: 'demo',
        DEMO_USER_ID: 'alice',
        CORS_ALLOWED_ORIGIN: 'https://app.example',
        AWS_ENDPOINT_URL: 'http://localhost:4566',
        AWS_REGION: 'us-east-1',
        AWS_DEFAULT_REGION: 'ap-south-1',
      }),
    ).toEqual({
      tableName: 't',
      eventBusName: 'bus',
      importBucket: 'bucket',
      baseCurrency: 'USD',
      authMode: 'demo',
      demoUserId: 'alice',
      corsAllowedOrigin: 'https://app.example',
      endpointUrl: 'http://localhost:4566',
      region: 'us-east-1',
    });
  });

  it('treats empty DEMO_USER_ID / AWS_ENDPOINT_URL as unset and uses AWS_DEFAULT_REGION as region fallback', () => {
    const config = loadConfig({ DEMO_USER_ID: '', AWS_ENDPOINT_URL: '', AWS_DEFAULT_REGION: 'ap-south-1' });
    expect(config.demoUserId).toBe(DEMO_USER_ID);
    expect(config.endpointUrl).toBeUndefined();
    expect(config.region).toBe('ap-south-1');
  });

  it('fails closed: AUTH_MODE defaults to cognito and unknown values are rejected', () => {
    expect(loadConfig({}).authMode).toBe('cognito');
    expect(loadConfig({ AUTH_MODE: '' }).authMode).toBe('cognito');
    expect(loadConfig({ AUTH_MODE: 'demo' }).authMode).toBe('demo');
    expect(() => loadConfig({ AUTH_MODE: 'off' })).toThrow(/AUTH_MODE/);
  });

  it('reads process.env by default', () => {
    expect(loadConfig().tableName).toBe(process.env.TABLE_NAME ?? 'portfolio-tracker-local');
  });
});
