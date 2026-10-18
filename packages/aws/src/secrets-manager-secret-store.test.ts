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
import { SecretsManagerSecretStore } from './secrets-manager-secret-store.js';

const sm = mockClient(SecretsManagerClient);
const client = new SecretsManagerClient({ region: 'eu-west-1' });
const store = new SecretsManagerSecretStore(client, 'Test secret');
const notFound = () => new ResourceNotFoundException({ message: 'nope', $metadata: {} });

beforeEach(() => sm.reset());

describe('SecretsManagerSecretStore', () => {
  it('reads the secret string, an empty one when the secret has no string, and null when it does not exist', async () => {
    sm.on(GetSecretValueCommand).resolvesOnce({ SecretString: 'v' }).resolvesOnce({}).rejectsOnce(notFound());
    expect(await store.get('/a/b')).toBe('v');
    expect(await store.get('/a/b')).toBe('');
    expect(await store.get('/a/b')).toBeNull();
    expect(sm.commandCalls(GetSecretValueCommand)[0]!.args[0].input).toEqual({ SecretId: '/a/b' });
  });

  it('recognises a not-found error by name too, and rethrows any other error', async () => {
    sm.on(GetSecretValueCommand).rejectsOnce(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' })).rejects(new Error('denied'));
    expect(await store.get('n')).toBeNull();
    await expect(store.get('n')).rejects.toThrow('denied');
  });

  it('replaces the value of an existing secret without creating one', async () => {
    sm.on(PutSecretValueCommand).resolves({});
    await store.put('/a/b', 'v');
    expect(sm.commandCalls(PutSecretValueCommand)[0]!.args[0].input).toEqual({ SecretId: '/a/b', SecretString: 'v' });
    expect(sm.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('creates the secret when it does not exist yet', async () => {
    sm.on(PutSecretValueCommand).rejects(notFound());
    sm.on(CreateSecretCommand).resolves({});
    await store.put('/a/b', 'v');
    expect(sm.commandCalls(CreateSecretCommand)[0]!.args[0].input).toEqual({ Name: '/a/b', SecretString: 'v', Description: 'Test secret' });
  });

  it('rethrows other write errors', async () => {
    sm.on(PutSecretValueCommand).rejects(new Error('denied'));
    await expect(store.put('n', 'v')).rejects.toThrow('denied');
  });

  it('force-deletes without a recovery window and ignores a missing secret', async () => {
    sm.on(DeleteSecretCommand).resolvesOnce({}).rejectsOnce(notFound()).rejects(new Error('denied'));
    await store.delete('/a/b');
    await store.delete('/a/b');
    await expect(store.delete('/a/b')).rejects.toThrow('denied');
    expect(sm.commandCalls(DeleteSecretCommand)[0]!.args[0].input).toEqual({ SecretId: '/a/b', ForceDeleteWithoutRecovery: true });
  });

  it('has a default description', async () => {
    sm.on(PutSecretValueCommand).rejects(notFound());
    sm.on(CreateSecretCommand).resolves({});
    await new SecretsManagerSecretStore(client).put('n', 'v');
    expect(sm.commandCalls(CreateSecretCommand)[0]!.args[0].input.Description).toBe('Portfolio tracker secret');
  });
});
