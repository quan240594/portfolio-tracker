import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface UploadUrlSigner {
  /** Returns a presigned PUT URL for `key`; the client must send `Content-Type: text/csv`. */
  signCsvUpload(key: string, expiresInSeconds: number): Promise<string>;
}

export class S3UploadUrlSigner implements UploadUrlSigner {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  signCsvUpload(key: string, expiresInSeconds: number): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: 'text/csv' });
    return getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }
}

/**
 * S3 client suitable for presigning browser uploads:
 *  - `requestChecksumCalculation: 'WHEN_REQUIRED'` stops the SDK from embedding a CRC32 of the (empty) presign-time
 *    body in the URL, which would make S3 reject the real upload.
 *  - path-style addressing when a custom endpoint (LocalStack) is used, so the URL is reachable from the browser.
 */
export function createPresignS3Client(config: S3ClientConfig & { endpoint?: string }): S3Client {
  return new S3Client({ ...config, forcePathStyle: Boolean(config.endpoint), requestChecksumCalculation: 'WHEN_REQUIRED' });
}
