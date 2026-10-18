import { utf8ByteLength } from '../encoding.js';
import type { FileStore, ReadResult, UploadRequest, UploadTarget } from '../file-store.js';

/** In-memory FileStore (reference implementation and test double). `accept` plays the role of the client's upload. */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, string>();

  constructor(private readonly baseUrl = 'memory://files') {}

  createUpload({ key, contentType, expiresInSeconds }: UploadRequest): Promise<UploadTarget> {
    return Promise.resolve({
      url: `${this.baseUrl}/${key}?expires=${expiresInSeconds}`,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresInSeconds,
    });
  }

  /** Stores the body the client sent to `target` (the key is the path of the target URL). */
  accept(target: UploadTarget, content: string): void {
    const rest = target.url.slice(this.baseUrl.length + 1);
    this.files.set(rest.slice(0, rest.indexOf('?')), content);
  }

  readText(key: string, maxBytes: number): Promise<ReadResult> {
    const content = this.files.get(key);
    if (content === undefined) return Promise.resolve({ ok: false, reason: 'Uploaded file not found' });
    if (utf8ByteLength(content) > maxBytes) return Promise.resolve({ ok: false, reason: `File too large (max ${maxBytes} bytes)` });
    return Promise.resolve({ ok: true, content });
  }

  delete(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }
}
