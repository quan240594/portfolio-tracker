import { describe, expect, it } from 'vitest';
import { AUTH_CONFIG, readAuthConfig } from './config';

const cognitoEnv = {
  VITE_AUTH_MODE: 'cognito',
  VITE_COGNITO_USER_POOL_ID: 'eu-west-1_AbCdEf123',
  VITE_COGNITO_CLIENT_ID: 'client-id',
  VITE_COGNITO_REGION: 'eu-west-1',
};

describe('readAuthConfig', () => {
  it('is off by default and in mock/demo mode, whatever else is configured', () => {
    expect(readAuthConfig({}, false)).toEqual({ mode: 'none' });
    expect(readAuthConfig({ VITE_AUTH_MODE: ' None ' }, false)).toEqual({ mode: 'none' });
    expect(readAuthConfig(cognitoEnv, true)).toEqual({ mode: 'none' });
  });

  it('reads the Cognito settings', () => {
    expect(readAuthConfig({ ...cognitoEnv, VITE_AUTH_MODE: ' Cognito ' }, false)).toEqual({
      mode: 'cognito',
      userPoolId: 'eu-west-1_AbCdEf123',
      clientId: 'client-id',
      region: 'eu-west-1',
    });
  });

  it('derives the region from the pool id when VITE_COGNITO_REGION is empty', () => {
    expect(readAuthConfig({ ...cognitoEnv, VITE_COGNITO_REGION: '' }, false)).toMatchObject({ region: 'eu-west-1' });
  });

  it('fails closed instead of starting without login when the configuration is incomplete or wrong', () => {
    expect(readAuthConfig({ VITE_AUTH_MODE: 'off' }, false)).toMatchObject({ mode: 'invalid', reason: expect.stringContaining('"off"') });
    expect(readAuthConfig({ VITE_AUTH_MODE: 'cognito' }, false)).toMatchObject({ mode: 'invalid' });
    expect(readAuthConfig({ ...cognitoEnv, VITE_COGNITO_CLIENT_ID: ' ' }, false)).toMatchObject({ mode: 'invalid' });
    expect(readAuthConfig({ ...cognitoEnv, VITE_COGNITO_REGION: 'mars' }, false)).toMatchObject({ mode: 'invalid', reason: expect.stringContaining('mars') });
  });

  it('the build used by the test suite has auth off', () => {
    expect(AUTH_CONFIG).toEqual({ mode: 'none' });
  });
});
