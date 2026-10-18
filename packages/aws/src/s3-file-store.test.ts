import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { createPresignS3Client, S3FileStore } from './s3-file-store.js';

const s3Mock = mockClient(S3Client);
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const body = (text: string) => ({ transformToString: () => Promise.resolve(text) }) as never;
const store = new S3FileStore(new S3Client({ region: 'eu-west-1' }), 'bucket');

beforeEach(() => s3Mock.reset());

describe('S3FileStore.createUpload', () => {
  const request = { key: 'imports/u/i.csv', contentType: 'text/csv', expiresInSeconds: 300 };

  it('presigns a PUT for the key with the requested expiry', async () => {
    const files = new S3FileStore(createPresignS3Client({ region: 'eu-west-1', credentials }), 'bucket');
    const target = await files.createUpload(request);
    const url = new URL(target.url);
    expect(target).toMatchObject({ method: 'PUT', headers: { 'content-type': 'text/csv' }, expiresInSeconds: 300 });
    expect(url.hostname).toBe('bucket.s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/imports/u/i.csv');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    // A checksum of the empty presign-time body would make S3 reject the real upload.
    expect([...url.searchParams.keys()].filter((k) => k.toLowerCase().includes('checksum'))).toEqual([]);
  });

  it('uses path-style URLs against a custom endpoint (LocalStack)', async () => {
    const files = new S3FileStore(createPresignS3Client({ region: 'eu-west-1', credentials, endpoint: 'http://localhost:4566' }), 'bucket');
    const url = new URL((await files.createUpload(request)).url);
    expect(`${url.origin}${url.pathname}`).toBe('http://localhost:4566/bucket/imports/u/i.csv');
  });
});

describe('S3FileStore.readText', () => {
  it('reads the object of the key as UTF-8 text', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 3, Body: body('a,b') });
    expect(await store.readText('imports/u/i.csv', 1024)).toEqual({ ok: true, content: 'a,b' });
    expect(s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'bucket', Key: 'imports/u/i.csv' });
  });

  it('treats an empty body as an empty file', async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    expect(await store.readText('k', 10)).toEqual({ ok: true, content: '' });
  });

  it('refuses an object whose size exceeds the limit without reading it, and releases the stream', async () => {
    const destroy = vi.fn();
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 11, Body: { destroy } as never });
    expect(await store.readText('k', 10)).toEqual({ ok: false, reason: 'File too large: 11 bytes (max 10)' });
    expect(destroy).toHaveBeenCalled();
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 11 });
    expect(await store.readText('k', 10)).toMatchObject({ ok: false });
  });

  it('measures the decoded text when the reported size is wrong', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 1, Body: body('€€€€') });
    expect(await store.readText('k', 10)).toEqual({ ok: false, reason: 'File too large (max 10 bytes)' });
  });

  it('reports a missing object as a permanent problem (by class or by name) and rethrows other errors', async () => {
    s3Mock.on(GetObjectCommand).rejectsOnce(new NoSuchKey({ message: 'x', $metadata: {} })).rejectsOnce(Object.assign(new Error('x'), { name: 'NoSuchKey' })).rejects(new Error('denied'));
    expect(await store.readText('k', 10)).toEqual({ ok: false, reason: 'Uploaded file not found' });
    expect(await store.readText('k', 10)).toEqual({ ok: false, reason: 'Uploaded file not found' });
    await expect(store.readText('k', 10)).rejects.toThrow('denied');
  });
});

describe('S3FileStore.delete', () => {
  it('deletes the object', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await store.delete('imports/u/i.csv');
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'bucket', Key: 'imports/u/i.csv' });
  });
});
