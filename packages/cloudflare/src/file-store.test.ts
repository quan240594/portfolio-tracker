import { runFileStoreContract } from '@portfolio/platform/testing';
import { describe, expect, it } from 'vitest';
import { SqlJsStorage, TestClock } from '../test/sqljs-storage.js';
import { MAX_FILE_BYTES, SqlFileStore, uploadTokenFromUrl, type SqlFileStoreOptions } from './file-store.js';
import type { SqlUsage } from './sql.js';

const BASE = 'https://tracker.test';
const bytes = (text: string) => new TextEncoder().encode(text);

const setup = async (options: Partial<SqlFileStoreOptions> = {}) => {
  const storage = await SqlJsStorage.create();
  const clock = new TestClock();
  const store = new SqlFileStore(storage, { uploadBaseUrl: BASE, now: clock.now, ...options });
  const upload = async (key: string, content: Uint8Array | string = 'a,b\n1,2\n', expiresInSeconds = 300) => {
    const target = await store.createUpload({ key, contentType: 'text/csv', expiresInSeconds });
    return { target, token: uploadTokenFromUrl(target.url)!, content: typeof content === 'string' ? bytes(content) : content };
  };
  return { storage, clock, store, upload };
};

runFileStoreContract('SqlFileStore (SQLite in Node)', async () => {
  const { store } = await setup();
  return {
    store,
    upload: async (target, content) => {
      const result = await store.acceptUpload(uploadTokenFromUrl(target.url)!, bytes(content));
      if (!result.ok) throw new Error(result.reason);
    },
  };
});

describe('uploadTokenFromUrl', () => {
  it('takes the last segment of the upload path', () => {
    expect(uploadTokenFromUrl('https://x.test/api/uploads/abc-DEF_123')).toBe('abc-DEF_123');
    expect(uploadTokenFromUrl('/api/uploads/abc')).toBe('abc');
  });

  it('rejects other paths', () => {
    expect(uploadTokenFromUrl('https://x.test/api/other/abc')).toBeUndefined();
    expect(uploadTokenFromUrl('https://x.test/api/uploads/')).toBeUndefined();
    expect(uploadTokenFromUrl('https://x.test/api/uploads/a/b')).toBeUndefined();
  });
});

describe('SqlFileStore.createUpload', () => {
  it('returns a same-origin PUT target with an unguessable token', async () => {
    const { upload } = await setup();
    const [a, b] = [await upload('k1'), await upload('k2')];
    expect(a.target).toEqual({ url: `${BASE}/api/uploads/${a.token}`, method: 'PUT', headers: { 'content-type': 'text/csv' }, expiresInSeconds: 300 });
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('builds the URL from a base URL function and ignores trailing slashes', async () => {
    const { store } = await setup({ uploadBaseUrl: () => `${BASE}//` });
    expect((await store.createUpload({ key: 'k', contentType: 'text/csv', expiresInSeconds: 60 })).url.startsWith(`${BASE}/api/uploads/`)).toBe(true);
  });

  it('rejects an empty key and a non-positive expiry', async () => {
    const { store } = await setup();
    await expect(store.createUpload({ key: '', contentType: 'text/csv', expiresInSeconds: 60 })).rejects.toThrow('needs a key');
    await expect(store.createUpload({ key: 'k', contentType: 'text/csv', expiresInSeconds: 0 })).rejects.toThrow(RangeError);
  });

  it('drops expired tokens as new ones are made', async () => {
    const { storage, clock, upload } = await setup();
    await upload('old', 'x', 10);
    await upload('fresh', 'x', 1000);
    clock.advance(60_000);
    await upload('new');
    expect(storage.rows<{ key: string }>('SELECT key FROM uploads ORDER BY key').map((row) => row.key)).toEqual(['fresh', 'new']);
  });
});

describe('SqlFileStore.acceptUpload', () => {
  it('stores the file and consumes the token', async () => {
    const { store, upload } = await setup();
    const { token, content } = await upload('imports/u1/i1.csv');
    expect(await store.acceptUpload(token, content)).toEqual({ ok: true, key: 'imports/u1/i1.csv', size: content.length });
    expect(await store.readText('imports/u1/i1.csv', 1024)).toEqual({ ok: true, content: 'a,b\n1,2\n' });
    expect(await store.acceptUpload(token, content)).toMatchObject({ ok: false, status: 404 });
  });

  it('accepts an ArrayBuffer and a view onto a larger buffer', async () => {
    const { store, upload } = await setup();
    const first = await upload('one');
    expect((await store.acceptUpload(first.token, bytes('abc').buffer)).ok).toBe(true);
    const second = await upload('two');
    const view = new Uint8Array(bytes('xxabcxx').buffer, 2, 3);
    await store.acceptUpload(second.token, view);
    expect(await store.readText('two', 10)).toEqual({ ok: true, content: 'abc' });
  });

  it('replaces the file of the same key', async () => {
    const { store, upload } = await setup();
    const [first, second] = [await upload('k', 'one'), await upload('k', 'two!')];
    await store.acceptUpload(first.token, first.content);
    await store.acceptUpload(second.token, second.content);
    expect(await store.readText('k', 10)).toEqual({ ok: true, content: 'two!' });
  });

  it('rejects an unknown token with 404', async () => {
    const { store } = await setup();
    expect(await store.acceptUpload('nope', bytes('x'))).toEqual({ ok: false, status: 404, reason: 'Unknown upload token' });
  });

  it('rejects an expired token with 410 and forgets it', async () => {
    const { store, storage, clock, upload } = await setup();
    const { token, content } = await upload('k', 'x', 60);
    clock.advance(60_000);
    expect(await store.acceptUpload(token, content)).toMatchObject({ ok: false, status: 410 });
    expect(storage.rows('SELECT token FROM uploads')).toEqual([]);
    expect(await store.readText('k', 10)).toMatchObject({ ok: false });
  });

  it('accepts a token until the very last millisecond', async () => {
    const { store, clock, upload } = await setup();
    const { token, content } = await upload('k', 'x', 60);
    clock.advance(59_999);
    expect((await store.acceptUpload(token, content)).ok).toBe(true);
  });

  it('rejects a body over the limit with 413 and keeps the token usable', async () => {
    const { store, upload } = await setup({ maxFileBytes: 10 });
    const { token } = await upload('k');
    const refused = await store.acceptUpload(token, new Uint8Array(11));
    expect(refused).toEqual({ ok: false, status: 413, reason: 'File too large: 11 bytes (max 10)' });
    expect((await store.acceptUpload(token, new Uint8Array(10))).ok).toBe(true);
  });

  it('keeps 1.5 MiB as the largest object, below the 2 MB SQLite row cap', async () => {
    const { store, upload } = await setup();
    expect(MAX_FILE_BYTES).toBe(1.5 * 1024 * 1024);
    const { token } = await upload('big');
    expect(await store.acceptUpload(token, new Uint8Array(MAX_FILE_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
    const again = await upload('big');
    expect(await store.acceptUpload(again.token, new Uint8Array(MAX_FILE_BYTES))).toMatchObject({ ok: true, size: MAX_FILE_BYTES });
    expect(await store.readText('big', 1024)).toMatchObject({ ok: false, reason: expect.stringContaining('too large') as string });
  });

  it('rejects a maxFileBytes option over the cap or not a positive integer', async () => {
    const refused = [0, 1.5, MAX_FILE_BYTES + 1].map((maxFileBytes) => expect(setup({ maxFileBytes })).rejects.toThrow(RangeError));
    await Promise.all(refused);
  });
});

describe('SqlFileStore.readText', () => {
  it('keeps a byte order mark and decodes invalid UTF-8 like a text decoder', async () => {
    const { store, upload } = await setup();
    const bom = await upload('bom', new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
    await store.acceptUpload(bom.token, bom.content);
    expect(await store.readText('bom', 10)).toEqual({ ok: true, content: '\ufeffa' });
  });

  it('reports content that grows when decoded over the limit', async () => {
    const { store, upload } = await setup();
    const bad = await upload('bad', new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    await store.acceptUpload(bad.token, bad.content);
    expect(await store.readText('bad', 5)).toEqual({ ok: false, reason: 'File too large (max 5 bytes)' });
  });

  it('does not load a blob over the limit', async () => {
    const usage: SqlUsage[] = [];
    const { store, upload } = await setup({ onUsage: (delta) => usage.push(delta) });
    const { token, content } = await upload('k', 'x'.repeat(100));
    await store.acceptUpload(token, content);
    expect(await store.readText('k', 10)).toEqual({ ok: false, reason: 'File too large: 100 bytes (max 10)' });
    expect(usage.length).toBeGreaterThan(0);
  });
});
