/**
 * FileStore: where uploaded CSV files live. The client uploads straight to the store through a short-lived target
 * (an S3 presigned URL on AWS, a signed Worker/R2 URL on Cloudflare); the ingestion job reads the file back.
 *
 * Implementations: S3 (`@portfolio/aws`), in-memory (`MemoryFileStore`).
 */
export interface UploadTarget {
  /** Where the client sends the file. */
  url: string;
  method: 'PUT';
  /** Headers the client must send with the upload. */
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface UploadRequest {
  key: string;
  contentType: string;
  expiresInSeconds: number;
}

/** `ok: false` is a permanent problem (missing, too large); transient errors are thrown. */
export type ReadResult = { ok: true; content: string } | { ok: false; reason: string };

export interface FileStore {
  createUpload(request: UploadRequest): Promise<UploadTarget>;
  /** Reads a text file of at most `maxBytes` bytes. */
  readText(key: string, maxBytes: number): Promise<ReadResult>;
  /** Removes the file; deleting a missing file is a no-op. */
  delete(key: string): Promise<void>;
}
