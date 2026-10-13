import { GetObjectCommand, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';

export const MAX_OBJECT_BYTES = 1024 * 1024;

export type ReadResult = { ok: true; content: string } | { ok: false; reason: string };

export interface ObjectReader {
  /** Reads a text object. Returns `ok:false` for permanent problems (missing, too large); throws on transient errors. */
  readText(bucket: string, key: string, maxBytes: number): Promise<ReadResult>;
}

export class S3ObjectReader implements ObjectReader {
  constructor(private readonly s3: S3Client) {}

  async readText(bucket: string, key: string, maxBytes: number): Promise<ReadResult> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const size = res.ContentLength ?? 0;
      if (size > maxBytes) {
        (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
        return { ok: false, reason: `File too large: ${size} bytes (max ${maxBytes})` };
      }
      const content = (await res.Body?.transformToString('utf-8')) ?? '';
      if (Buffer.byteLength(content) > maxBytes) return { ok: false, reason: `File too large (max ${maxBytes} bytes)` };
      return { ok: true, content };
    } catch (err) {
      if (err instanceof NoSuchKey || (err as Error).name === 'NoSuchKey') return { ok: false, reason: 'Uploaded file not found' };
      throw err;
    }
  }
}
