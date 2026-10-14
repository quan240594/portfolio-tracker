import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  LocalCredentialSource,
  SecretsManagerCredentialStore,
  loadLocalCredentials,
  parseEnvFile,
  type LocalCredentialDeps,
} from './credentials.js';
import { BrokerError } from './errors.js';

const sm = mockClient(SecretsManagerClient);
const notFound = () => new ResourceNotFoundException({ message: 'nope', $metadata: {} });
const creds = { apiKey: 'KEY', apiSecret: 'SECRET', environment: 'live' as const };

beforeEach(() => sm.reset());

describe('SecretsManagerCredentialStore', () => {
  const store = () => new SecretsManagerCredentialStore(new SecretsManagerClient({ region: 'eu-west-1' }), '/pt/dev/broker/trading212/');

  it('reads the secret of the user under the prefix', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ apiKey: ' KEY ', apiSecret: 'SECRET' }) });
    await expect(store().get('user-1')).resolves.toEqual({ apiKey: 'KEY', apiSecret: 'SECRET', environment: 'live' });
    expect(sm.commandCalls(GetSecretValueCommand)[0]!.args[0].input.SecretId).toBe('/pt/dev/broker/trading212/user-1');
  });

  it('returns null when no secret exists', async () => {
    sm.on(GetSecretValueCommand).rejects(notFound());
    await expect(store().get('user-1')).resolves.toBeNull();
    sm.on(GetSecretValueCommand).rejects(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }));
    await expect(store().get('user-1')).resolves.toBeNull();
  });

  it('rethrows other AWS errors', async () => {
    sm.on(GetSecretValueCommand).rejects(new Error('AccessDenied'));
    await expect(store().get('u')).rejects.toThrow('AccessDenied');
  });

  it('rejects malformed secrets without echoing their content', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: 'not-json KEY SECRET' });
    const notJson = (await store().get('u').catch((e: unknown) => e)) as BrokerError;
    expect(notJson).toMatchObject({ code: 'NO_CREDENTIALS' });
    expect(notJson.message).not.toContain('SECRET');
    sm.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ apiKey: 'only' }) });
    await expect(store().get('u')).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
    sm.on(GetSecretValueCommand).resolves({});
    await expect(store().get('u')).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
  });

  it('refuses user ids that cannot be part of a secret name', async () => {
    await expect(store().get('../other')).rejects.toThrow('User id cannot be used in a secret name');
    await expect(store().put('a/b', creds)).rejects.toThrow();
  });

  it('puts a new secret version, creating the secret on first use', async () => {
    sm.on(PutSecretValueCommand).resolves({});
    await store().put('u', creds);
    expect(JSON.parse(sm.commandCalls(PutSecretValueCommand)[0]!.args[0].input.SecretString!)).toEqual(creds);
    expect(sm.commandCalls(CreateSecretCommand)).toHaveLength(0);

    sm.reset();
    sm.on(PutSecretValueCommand).rejects(notFound());
    sm.on(CreateSecretCommand).resolves({});
    await store().put('u', creds);
    expect(sm.commandCalls(CreateSecretCommand)[0]!.args[0].input).toMatchObject({ Name: '/pt/dev/broker/trading212/u' });
  });

  it('rethrows other errors while writing', async () => {
    sm.on(PutSecretValueCommand).rejects(new Error('Throttled'));
    await expect(store().put('u', creds)).rejects.toThrow('Throttled');
  });

  it('deletes without recovery and ignores a missing secret', async () => {
    sm.on(DeleteSecretCommand).resolves({});
    await store().delete('u');
    expect(sm.commandCalls(DeleteSecretCommand)[0]!.args[0].input).toMatchObject({ SecretId: '/pt/dev/broker/trading212/u', ForceDeleteWithoutRecovery: true });
    sm.on(DeleteSecretCommand).rejects(notFound());
    await expect(store().delete('u')).resolves.toBeUndefined();
    sm.on(DeleteSecretCommand).rejects(new Error('denied'));
    await expect(store().delete('u')).rejects.toThrow('denied');
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=value lines, strips quotes and ignores comments and junk', () => {
    expect(parseEnvFile('# c\nA=1\n  B = "two words" \r\nC=\'x\'\nnot a line\n9X=1\nD=')).toEqual({ A: '1', B: 'two words', C: 'x', D: '' });
  });
});

describe('loadLocalCredentials', () => {
  const deps = (over: Partial<LocalCredentialDeps> & { file?: string } = {}): LocalCredentialDeps => ({
    env: {},
    cwd: '/repo/services/broker-sync',
    fileExists: (p) => p === '/repo/.env.trading212.local',
    readFile: () => over.file,
    ...over,
  });

  it('prefers the environment variables', () => {
    expect(loadLocalCredentials(deps({ env: { T212_API_KEY: ' k ', T212_API_SECRET: 's', T212_ENV: 'DEMO' } }))).toEqual({ apiKey: 'k', apiSecret: 's', environment: 'demo' });
  });

  it('finds .env.trading212.local in a parent directory and defaults to live', () => {
    expect(loadLocalCredentials(deps({ file: 'T212_API_KEY=k\nT212_API_SECRET=s\n' }))).toEqual({ apiKey: 'k', apiSecret: 's', environment: 'live' });
  });

  it('uses the file named by T212_ENV_FILE', () => {
    const read: string[] = [];
    const result = loadLocalCredentials({
      env: { T212_ENV_FILE: '/x/custom.env' },
      cwd: '/',
      fileExists: () => false,
      readFile: (p) => {
        read.push(p);
        return 'T212_API_KEY=k\nT212_API_SECRET=s\nT212_ENV=demo';
      },
    });
    expect(read).toEqual(['/x/custom.env']);
    expect(result.environment).toBe('demo');
  });

  it('says which value is empty and where, without printing values', () => {
    expect(() => loadLocalCredentials(deps({ file: 'T212_API_KEY=\nT212_API_SECRET=abc' }))).toThrow('T212_API_KEY is empty in .env.trading212.local');
    expect(() => loadLocalCredentials(deps({ file: 'T212_API_KEY=abc\nT212_API_SECRET=  ' }))).toThrow('T212_API_SECRET is empty in .env.trading212.local');
    expect(() => loadLocalCredentials(deps({ env: { T212_API_KEY: 'k' } }))).toThrow('T212_API_SECRET is empty in the environment');
  });

  it('explains missing files and invalid environments', () => {
    expect(() => loadLocalCredentials({ env: {}, cwd: '/nowhere', fileExists: () => false, readFile: () => undefined })).toThrow(/set T212_API_KEY\/T212_API_SECRET or point T212_ENV_FILE/);
    expect(() => loadLocalCredentials({ env: { T212_ENV_FILE: '/x/y.env' }, cwd: '/', fileExists: () => false, readFile: () => undefined })).toThrow('y.env does not exist');
    expect(() => loadLocalCredentials(deps({ file: 'T212_API_KEY=k\nT212_API_SECRET=s\nT212_ENV=moon' }))).toThrow('T212_ENV must be "live" or "demo"');
    expect(() => loadLocalCredentials(deps({ env: { T212_API_KEY: 'k', T212_API_SECRET: 's', T212_ENV: 'moon' } }))).toThrow(BrokerError);
  });

  it('source returns the credentials whatever the user and rejects errors', async () => {
    const source = new LocalCredentialSource(deps({ env: { T212_API_KEY: 'k', T212_API_SECRET: 's' } }));
    await expect(source.get()).resolves.toMatchObject({ apiKey: 'k' });
    await expect(new LocalCredentialSource(deps({ file: '' })).get()).rejects.toThrow('T212_API_KEY is empty');
  });
});
