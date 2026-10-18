import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { utf8ByteLength, type FileStore, type ReadResult, type UploadRequest, type UploadTarget } from '@portfolio/platform';

/**
 * S3 client suitable for presigning browser uploads:
 *  - `requestChecksumCalculation: 'WHEN_REQUIRED'` stops the SDK from embedding a CRC32 of the (empty) presign-time
 *    body in the URL, which would make S3 reject the real upload.
 *  - path-style addressing when a custom endpoint (LocalStack) is used, so the URL is reachable from the browser.
 */
export function createPresignS3Client(config: S3ClientConfig & { endpoint?: string }): S3Client {
  return new S3Client({ ...config, forcePathStyle: Boolean(config.endpoint), requestChecksumCalculation: 'WHEN_REQUIRED' });
}

/** FileStore on one S3 bucket: presigned PUT URLs for uploads, GetObject/DeleteObject for the ingestion job. */
export class S3FileStore implements FileStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async createUpload({ key, contentType, expiresInSeconds }: UploadRequest): Promise<UploadTarget> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    const url = await getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
    return { url, method: 'PUT', headers: { 'content-type': contentType }, expiresInSeconds };
  }

  async readText(key: string, maxBytes: number): Promise<ReadResult> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const size = res.ContentLength ?? 0;
      if (size > maxBytes) {
        (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
        return { ok: false, reason: `File too large: ${size} bytes (max ${maxBytes})` };
      }
      const content = (await res.Body?.transformToString('utf-8')) ?? '';
      if (utf8ByteLength(content) > maxBytes) return { ok: false, reason: `File too large (max ${maxBytes} bytes)` };
      return { ok: true, content };
    } catch (err) {
      if (err instanceof NoSuchKey || (err as Error).name === 'NoSuchKey') return { ok: false, reason: 'Uploaded file not found' };
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
