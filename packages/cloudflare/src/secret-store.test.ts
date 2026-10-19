import { runSecretStoreContract } from '@portfolio/platform/testing';
import { describe, expect, it } from 'vitest';
import { SqlJsStorage } from '../test/sqljs-storage.js';
import { generateSecretsKey, SqlSecretStore } from './secret-store.js';
import type { SqlUsage } from './sql.js';

const KEY = generateSecretsKey();

runSecretStoreContract('SqlSecretStore (SQLite in Node)', async () => new SqlSecretStore(await SqlJsStorage.create(), KEY));

describe('generateSecretsKey', () => {
  it('makes distinct 32 byte base64 keys', () => {
    const [a, b] = [generateSecretsKey(), generateSecretsKey()];
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(32);
  });
});

describe('SqlSecretStore', () => {
  const PLAIN = '{"apiKey":"sk-live-0123456789"}';

  it('never stores the plaintext: the stored value is versioned, random and differs on every write', async () => {
    const storage = await SqlJsStorage.create();
    const store = new SqlSecretStore(storage, KEY);
    await store.put('broker', PLAIN);
    const first = storage.rows<{ name: string; value: string }>('SELECT name, value FROM secrets')[0]!;
    expect(first.name).toBe('broker');
    expect(first.value).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(first.value).not.toContain('sk-live');
    expect(atob(first.value.split('.')[2]!)).not.toContain('sk-live');
    await store.put('broker', PLAIN);
    const second = storage.rows<{ value: string }>('SELECT value FROM secrets')[0]!.value;
    expect(second).not.toBe(first.value);
    expect(first.value.split('.')[1]).not.toBe(second.split('.')[1]); // a new IV per write
    expect(await store.get('broker')).toBe(PLAIN);
  });

  it('uses a 12 byte IV and AES-GCM ciphertext with a 16 byte tag', async () => {
    const storage = await SqlJsStorage.create();
    await new SqlSecretStore(storage, KEY).put('a', 'x');
    const [, iv, ciphertext] = storage.rows<{ value: string }>('SELECT value FROM secrets')[0]!.value.split('.');
    expect(atob(iv!)).toHaveLength(12);
    expect(atob(ciphertext!)).toHaveLength(1 + 16);
  });

  it('cannot be read with another key', async () => {
    const storage = await SqlJsStorage.create();
    await new SqlSecretStore(storage, KEY).put('broker', PLAIN);
    const wrong = new SqlSecretStore(storage, generateSecretsKey());
    const failure = wrong.get('broker');
    await expect(failure).rejects.toThrow(/could not be decrypted/);
    await expect(failure).rejects.not.toThrow(/sk-live/);
  });

  it('detects a changed ciphertext and a ciphertext moved to another name', async () => {
    const storage = await SqlJsStorage.create();
    const store = new SqlSecretStore(storage, KEY);
    await store.put('a', 'value a');
    await store.put('b', 'value b');
    const [{ value: sealedA }] = storage.rows<{ value: string }>("SELECT value FROM secrets WHERE name = 'a'") as [{ value: string }];
    storage.rows("UPDATE secrets SET value = ? WHERE name = 'b'", sealedA);
    await expect(store.get('b')).rejects.toThrow(/could not be decrypted/);

    const [version, iv, ciphertext] = sealedA.split('.');
    const flipped = `${version}.${iv}.${ciphertext!.replace(/^./, ciphertext![0] === 'A' ? 'B' : 'A')}`;
    storage.rows("UPDATE secrets SET value = ? WHERE name = 'a'", flipped);
    await expect(store.get('a')).rejects.toThrow(/could not be decrypted/);
  });

  it('rejects stored values in an unknown format', async () => {
    const storage = await SqlJsStorage.create();
    const store = new SqlSecretStore(storage, KEY);
    const stored = ['plain text', 'v2.a.b', 'v1.a', 'v1.a.b.c', 'v1..'];
    stored.forEach((value, index) => storage.rows('INSERT INTO secrets (name, value) VALUES (?, ?)', `x${index}`, value));
    await Promise.all(stored.map((_, index) => expect(store.get(`x${index}`)).rejects.toThrow(/unknown format/)));
  });

  it('rejects a master key that is not base64 or too short, at construction', async () => {
    const storage = await SqlJsStorage.create();
    expect(() => new SqlSecretStore(storage, '***not base64***')).toThrow(/must be base64/);
    expect(() => new SqlSecretStore(storage, btoa('too short'))).toThrow(/at least 32/);
    expect(() => new SqlSecretStore(storage, '')).toThrow(/at least 32/);
  });

  it('accepts a key with surrounding whitespace', async () => {
    const storage = await SqlJsStorage.create();
    const store = new SqlSecretStore(storage, ` ${KEY}\n`);
    await store.put('a', 'b');
    expect(await new SqlSecretStore(storage, KEY).get('a')).toBe('b');
  });

  it('keeps unicode and empty values intact', async () => {
    const store = new SqlSecretStore(await SqlJsStorage.create(), KEY);
    await store.put('u', 'wachtwoord ✓ 日本語 😀');
    await store.put('e', '');
    expect(await store.get('u')).toBe('wachtwoord ✓ 日本語 😀');
    expect(await store.get('e')).toBe('');
  });

  it('reports the rows it reads and writes', async () => {
    const usage: SqlUsage[] = [];
    const store = new SqlSecretStore(await SqlJsStorage.create(), KEY, { onUsage: (delta) => usage.push(delta) });
    await store.put('a', 'b');
    await store.get('a');
    expect(usage.reduce((sum, delta) => sum + delta.rowsWritten, 0)).toBe(1);
    expect(usage.reduce((sum, delta) => sum + delta.rowsRead, 0)).toBe(1);
  });
});
