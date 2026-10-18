import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@portfolio/platform';
import type { BrokerError } from './errors.js';
import { SecretCredentialStore } from './credentials.js';

const creds = { apiKey: 'KEY', apiSecret: 'SECRET', environment: 'live' as const };

describe('SecretCredentialStore', () => {
  const setup = () => {
    const secrets = new MemorySecretStore();
    return { secrets, store: new SecretCredentialStore(secrets, '/pt/dev/broker/trading212/') };
  };

  it('reads the secret of the user under the prefix, trimmed and with the live default', async () => {
    const { secrets, store } = setup();
    await secrets.put('/pt/dev/broker/trading212/user-1', JSON.stringify({ apiKey: ' KEY ', apiSecret: 'SECRET' }));
    await expect(store.get('user-1')).resolves.toEqual(creds);
  });

  it('returns null when no secret exists', async () => {
    await expect(setup().store.get('user-1')).resolves.toBeNull();
  });

  it('rejects malformed secrets without echoing their content', async () => {
    const { secrets, store } = setup();
    const name = '/pt/dev/broker/trading212/u';
    await secrets.put(name, 'not-json KEY SECRET');
    const notJson = (await store.get('u').catch((e: unknown) => e)) as BrokerError;
    expect(notJson).toMatchObject({ code: 'NO_CREDENTIALS' });
    expect(notJson.message).not.toContain('SECRET');
    await secrets.put(name, JSON.stringify({ apiKey: 'only' }));
    await expect(store.get('u')).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
    await secrets.put(name, '');
    await expect(store.get('u')).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
  });

  it('refuses user ids that cannot be part of a secret name', async () => {
    const { store } = setup();
    await expect(store.get('../other')).rejects.toThrow('User id cannot be used in a secret name');
    await expect(store.put('a/b', creds)).rejects.toThrow();
    await expect(store.delete('a/b')).rejects.toThrow();
  });

  it('stores the credentials as JSON under the user name, replaces and deletes them', async () => {
    const { secrets, store } = setup();
    await store.put('u', creds);
    expect(secrets.names()).toEqual(['/pt/dev/broker/trading212/u']);
    expect(JSON.parse((await secrets.get('/pt/dev/broker/trading212/u'))!)).toEqual(creds);
    await store.put('u', { ...creds, environment: 'demo' });
    expect(await store.get('u')).toEqual({ ...creds, environment: 'demo' });
    await store.delete('u');
    expect(await store.get('u')).toBeNull();
    await expect(store.delete('u')).resolves.toBeUndefined();
  });
});
