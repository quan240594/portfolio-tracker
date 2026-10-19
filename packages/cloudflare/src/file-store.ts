import { bytesToBase64, utf8ByteLength, type FileStore, type ReadResult, type UploadRequest, type UploadTarget } from '@portfolio/platform';
import { settle } from './settle.js';
import { MeteredSql, type SqlStorageHost, type UsageOptions } from './sql.js';

/** Largest file the store keeps: a SQLite row/blob is capped at 2 MB, so 1.5 MiB leaves room for the other columns. */
export const MAX_FILE_BYTES = 1_572_864;

/** Path the Worker serves uploads on (`PUT <origin>/api/uploads/<token>`). The token is the last path segment. */
export const UPLOAD_PATH_PREFIX = '/api/uploads/';

export const FILES_SCHEMAS = [
  'CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, data BLOB NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS uploads (token TEXT PRIMARY KEY, key TEXT NOT NULL, content_type TEXT NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID',
] as const;

type UploadRow = { key: string; content_type: string; expires_at: number };
type FileRow = { size: number; data: ArrayBuffer | null };

export interface SqlFileStoreOptions extends UsageOptions {
  /**
   * Origin the browser reaches the Worker on (for example `https://tracker.example.workers.dev`), used to build the
   * upload URL. A function lets the Durable Object answer with the origin of the request it is serving.
   */
  uploadBaseUrl: string | (() => string);
  now?: () => Date;
  /** Largest accepted upload; at most `MAX_FILE_BYTES`. */
  maxFileBytes?: number;
}

/** Why `acceptUpload` stored nothing; `status` is the HTTP status the Worker answers with. */
export type AcceptUploadResult =
  | { ok: true; key: string; size: number }
  | { ok: false; status: 404 | 410 | 413; reason: string };

const toBytes = (body: Uint8Array | ArrayBuffer): Uint8Array => (body instanceof Uint8Array ? body : new Uint8Array(body));

/** A tight ArrayBuffer of the bytes (SQLite blobs bind as ArrayBuffer, never as a view onto a larger buffer). */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end--;
  return text.slice(0, end);
}

const newToken = (): string =>
  bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/** The upload token of an upload URL made by `createUpload`: the last path segment, or undefined for any other path. */
export function uploadTokenFromUrl(url: string): string | undefined {
  const { pathname } = new URL(url, 'https://upload.invalid');
  if (!pathname.startsWith(UPLOAD_PATH_PREFIX)) return undefined;
  const token = pathname.slice(UPLOAD_PATH_PREFIX.length);
  return token === '' || token.includes('/') ? undefined : token;
}

/**
 * FileStore that keeps small files (the CSV imports, at most 1 MiB in the web app) as blobs in the SQLite database of the
 * Durable Object. There is no object storage on the free plan, so there is no presigned URL either; the equivalent is:
 *
 * 1. `createUpload` stores a random, single-use, expiring token for the key and returns
 *    `PUT <uploadBaseUrl>/api/uploads/<token>` with the `content-type` header, like the S3 presigned URL it replaces.
 * 2. The Worker serves that route WITHOUT sign-in (the token is the credential, like a presigned URL), reads the request
 *    body (rejecting a `content-length` above `MAX_FILE_BYTES` before buffering it) and forwards it to the Hub Durable
 *    Object, which calls `acceptUpload(token, bytes)`. The Worker answers 204 for `ok: true` and `result.status`
 *    (404 unknown token, 410 expired, 413 too large) with `result.reason` otherwise.
 * 3. `readText` / `delete` work as on S3. `readText` never loads a blob that is over the limit.
 *
 * Objects over `MAX_FILE_BYTES` are rejected with a clear error instead of failing on SQLite's row cap.
 */
export class SqlFileStore implements FileStore {
  private readonly db: MeteredSql;
  private readonly now: () => Date;
  private readonly maxFileBytes: number;

  constructor(
    private readonly storage: SqlStorageHost,
    private readonly options: SqlFileStoreOptions,
  ) {
    const { maxFileBytes = MAX_FILE_BYTES } = options;
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
      throw new RangeError(`maxFileBytes must be between 1 and ${MAX_FILE_BYTES}`);
    }
    this.maxFileBytes = maxFileBytes;
    this.now = options.now ?? (() => new Date());
    this.db = new MeteredSql(storage.sql, options.onUsage);
    for (const schema of FILES_SCHEMAS) this.db.rows(schema);
  }

  createUpload({ key, contentType, expiresInSeconds }: UploadRequest): Promise<UploadTarget> {
    return settle(() => {
      if (key === '') throw new Error('An upload needs a key');
      if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new RangeError('expiresInSeconds must be positive');
      const nowMs = this.now().getTime();
      const token = newToken();
      this.storage.transactionSync(() => {
        // Expired tokens are garbage: drop them as new ones are made, so the table stays as small as the open uploads.
        this.db.rows('DELETE FROM uploads WHERE expires_at <= ?', nowMs);
        this.db.rows('INSERT INTO uploads (token, key, content_type, expires_at) VALUES (?, ?, ?, ?)', token, key, contentType, nowMs + expiresInSeconds * 1000);
      });
      const { uploadBaseUrl } = this.options;
      const base = withoutTrailingSlashes(typeof uploadBaseUrl === 'function' ? uploadBaseUrl() : uploadBaseUrl);
      return { url: `${base}${UPLOAD_PATH_PREFIX}${token}`, method: 'PUT' as const, headers: { 'content-type': contentType }, expiresInSeconds };
    });
  }

  /**
   * Stores the body the client sent to an upload URL. Called by the Hub Durable Object for the Worker's upload route.
   * The token is consumed by a successful upload; a failed one (too large) leaves it usable until it expires.
   */
  acceptUpload(token: string, body: Uint8Array | ArrayBuffer): Promise<AcceptUploadResult> {
    return settle(() => {
      const bytes = toBytes(body);
      const nowMs = this.now().getTime();
      return this.storage.transactionSync((): AcceptUploadResult => {
        const upload = this.db.first<UploadRow>('SELECT key, content_type, expires_at FROM uploads WHERE token = ?', token);
        if (!upload) return { ok: false, status: 404, reason: 'Unknown upload token' };
        if (upload.expires_at <= nowMs) {
          this.db.rows('DELETE FROM uploads WHERE token = ?', token);
          return { ok: false, status: 410, reason: 'The upload link has expired' };
        }
        if (bytes.byteLength > this.maxFileBytes) {
          return { ok: false, status: 413, reason: `File too large: ${bytes.byteLength} bytes (max ${this.maxFileBytes})` };
        }
        this.db.rows(
          'INSERT INTO files (key, size, content_type, data) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, data = excluded.data',
          upload.key,
          bytes.byteLength,
          upload.content_type,
          toArrayBuffer(bytes),
        );
        this.db.rows('DELETE FROM uploads WHERE token = ?', token);
        return { ok: true, key: upload.key, size: bytes.byteLength };
      });
    });
  }

  readText(key: string, maxBytes: number): Promise<ReadResult> {
    return settle((): ReadResult => {
      // The CASE keeps an over-limit blob out of the result: only its size is read.
      const row = this.db.first<FileRow>('SELECT size, CASE WHEN size <= ? THEN data END AS data FROM files WHERE key = ?', maxBytes, key);
      if (!row) return { ok: false, reason: 'Uploaded file not found' };
      if (row.size > maxBytes || row.data === null) return { ok: false, reason: `File too large: ${row.size} bytes (max ${maxBytes})` };
      // `ignoreBOM` keeps a leading byte order mark, like S3's `transformToString`.
      const content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(row.data);
      // A text file's size in bytes is that of its stored bytes; the check stays in the port's own unit.
      return utf8ByteLength(content) > maxBytes ? { ok: false, reason: `File too large (max ${maxBytes} bytes)` } : { ok: true, content };
    });
  }

  delete(key: string): Promise<void> {
    return settle(() => {
      this.db.rows('DELETE FROM files WHERE key = ?', key);
    });
  }
}
