import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { MAX_OBJECT_BYTES, S3ObjectReader } from './objects.js';

const s3Mock = mockClient(S3Client);
const reader = new S3ObjectReader(new S3Client({ region: 'eu-west-1' }));

/** A Node stream shaped like the SDK's streaming body (Readable + transformToString). */
function streamBody(text: string) {
  const stream = Readable.from([Buffer.from(text, 'utf-8')]);
  return Object.assign(stream, {
    transformToString: async (encoding: BufferEncoding = 'utf-8') => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString(encoding);
    },
  });
}

beforeEach(() => s3Mock.reset());

describe('S3ObjectReader', () => {
  it('reads the object as UTF-8 text from the requested bucket/key', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 9, Body: streamBody('date,€\n') as never });
    expect(await reader.readText('b', 'imports/u/i.csv', MAX_OBJECT_BYTES)).toEqual({ ok: true, content: 'date,€\n' });
    expect(s3Mock.commandCalls(GetObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'b', Key: 'imports/u/i.csv' });
  });

  it('accepts an object exactly at the size limit', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 4, Body: streamBody('abcd') as never });
    expect(await reader.readText('b', 'k', 4)).toEqual({ ok: true, content: 'abcd' });
  });

  it('rejects oversized objects by ContentLength and destroys the unread stream', async () => {
    const body = streamBody('x'.repeat(20));
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 20, Body: body as never });
    expect(await reader.readText('b', 'k', 10)).toEqual({ ok: false, reason: 'File too large: 20 bytes (max 10)' });
    expect(body.destroyed).toBe(true);
  });

  it('rejects oversized objects whose body has no destroy method, or no body at all', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 20, Body: { transformToString: async () => 'x' } as never });
    expect(await reader.readText('b', 'k', 10)).toMatchObject({ ok: false });
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 20 });
    expect(await reader.readText('b', 'k', 10)).toMatchObject({ ok: false });
  });

  it('enforces the limit on the decoded bytes when ContentLength is missing or wrong', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: streamBody('ééééé') as never });
    expect(await reader.readText('b', 'k', 9)).toEqual({ ok: false, reason: 'File too large (max 9 bytes)' });
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 1, Body: streamBody('abcdef') as never });
    expect(await reader.readText('b', 'k', 5)).toEqual({ ok: false, reason: 'File too large (max 5 bytes)' });
  });

  it('treats a missing body as an empty file', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 0 });
    expect(await reader.readText('b', 'k', 10)).toEqual({ ok: true, content: '' });
  });

  it('maps NoSuchKey (instance or by name) to a permanent failure', async () => {
    s3Mock.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'gone', $metadata: {} }));
    expect(await reader.readText('b', 'k', 10)).toEqual({ ok: false, reason: 'Uploaded file not found' });
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));
    expect(await reader.readText('b', 'k', 10)).toEqual({ ok: false, reason: 'Uploaded file not found' });
  });

  it('rethrows transient errors so the message is retried', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('slow down'), { name: 'SlowDown' }));
    await expect(reader.readText('b', 'k', 10)).rejects.toThrow('slow down');
  });

  it('rethrows errors raised while reading the body stream', async () => {
    s3Mock.on(GetObjectCommand).resolves({ ContentLength: 3, Body: { transformToString: async () => Promise.reject(new Error('socket hang up')) } as never });
    await expect(reader.readText('b', 'k', 10)).rejects.toThrow('socket hang up');
  });
});
