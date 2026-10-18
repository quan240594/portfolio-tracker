import { describe, expect, it } from 'vitest';
import type { FileStore, UploadTarget } from '../file-store.js';

export interface FileStoreHarness {
  store: FileStore;
  /** Plays the browser: sends `content` to the upload target the way a client would (HTTP PUT, or a direct write). */
  upload(target: UploadTarget, content: string): Promise<void>;
}

type Factory = () => FileStoreHarness | Promise<FileStoreHarness>;

/** Behaviour every FileStore adapter must have. Keys are namespaced per run. */
export function runFileStoreContract(name: string, create: Factory): void {
  describe(`FileStore contract: ${name}`, () => {
    const ns = crypto.randomUUID();
    let counter = 0;
    const key = () => `contract/${ns}/file-${++counter}.csv`;
    const request = (k: string) => ({ key: k, contentType: 'text/csv', expiresInSeconds: 300 });

    it('creates an upload target that carries the content type and expiry', async () => {
      const { store } = await create();
      const target = await store.createUpload(request(key()));
      expect(target.method).toBe('PUT');
      expect(target.url).toMatch(/^https?:\/\/|^memory:\/\//);
      expect(target.expiresInSeconds).toBe(300);
      expect(target.headers['content-type']).toBe('text/csv');
    });

    it('reads back what the client uploaded', async () => {
      const { store, upload } = await create();
      const k = key();
      await upload(await store.createUpload(request(k)), 'date,symbol\n2026-01-01,AAPL\n');
      expect(await store.readText(k, 1024)).toEqual({ ok: true, content: 'date,symbol\n2026-01-01,AAPL\n' });
    });

    it('measures the size in bytes, not characters', async () => {
      const { store, upload } = await create();
      const k = key();
      await upload(await store.createUpload(request(k)), '€€€€€');
      expect(await store.readText(k, 15)).toMatchObject({ ok: true });
      expect(await store.readText(k, 14)).toMatchObject({ ok: false });
    });

    it('reports a missing file as a permanent problem, not an error', async () => {
      const { store } = await create();
      const result = await store.readText(key(), 1024);
      expect(result).toMatchObject({ ok: false });
      expect((result as { reason: string }).reason).toMatch(/not found/i);
    });

    it('reports a file over the limit as a permanent problem', async () => {
      const { store, upload } = await create();
      const k = key();
      await upload(await store.createUpload(request(k)), 'x'.repeat(100));
      const result = await store.readText(k, 10);
      expect(result).toMatchObject({ ok: false });
      expect((result as { reason: string }).reason).toMatch(/too large/i);
    });

    it('deletes a file; deleting a missing one is a no-op', async () => {
      const { store, upload } = await create();
      const k = key();
      await upload(await store.createUpload(request(k)), 'a');
      await store.delete(k);
      expect(await store.readText(k, 10)).toMatchObject({ ok: false });
      await expect(store.delete(k)).resolves.toBeUndefined();
    });
  });
}
