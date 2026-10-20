import { describe, expect, it } from 'vitest';
import { MAX_CLASSIFICATION_IMPORT_BYTES } from '@portfolio/shared';
import { MAX_API_BODY_BYTES, bodyLimitFor, declaresTooLarge, readBodyBounded } from './body.js';

const put = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request('https://x.test/', { method: 'PUT', body, headers });

describe('readBodyBounded', () => {
  it('reads a body within the limit, an empty one and a missing one', async () => {
    expect(new TextDecoder().decode(await readBodyBounded(put('abc'), 10))).toBe('abc');
    expect(await readBodyBounded(put(''), 10)).toHaveLength(0);
    expect(await readBodyBounded(new Request('https://x.test/'), 10)).toHaveLength(0);
  });

  it('accepts exactly the limit and refuses one byte more', async () => {
    expect(await readBodyBounded(put(new Uint8Array(10)), 10)).toHaveLength(10);
    expect(await readBodyBounded(put(new Uint8Array(11)), 10)).toBeUndefined();
  });

  it('joins chunks and stops at the limit without buffering the rest', async () => {
    const chunks = (count: number) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (count-- <= 0) controller.close();
          else controller.enqueue(new Uint8Array(4));
        },
      });
    const request = (stream: ReadableStream<Uint8Array>) => new Request('https://x.test/', { method: 'PUT', body: stream, duplex: 'half' } as RequestInit);
    expect(await readBodyBounded(request(chunks(3)), 12)).toHaveLength(12);
    expect(await readBodyBounded(request(chunks(1_000_000)), 12)).toBeUndefined();
  });

  it('refuses on the announced length before reading anything', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request('https://x.test/', { method: 'PUT', body: stream, headers: { 'content-length': '999' }, duplex: 'half' } as RequestInit);
    expect(await readBodyBounded(request, 10)).toBeUndefined();
    expect(pulled).toBe(false);
  });
});

describe('declaresTooLarge', () => {
  it('only trusts well-formed lengths', () => {
    expect(declaresTooLarge(put('x', { 'content-length': '11' }), 10)).toBe(true);
    expect(declaresTooLarge(put('x', { 'content-length': '10' }), 10)).toBe(false);
    expect(declaresTooLarge(put('x', { 'content-length': '-5' }), 10)).toBe(false);
    expect(declaresTooLarge(put('x', { 'content-length': 'abc' }), 10)).toBe(false);
    expect(declaresTooLarge(put('x'), 10)).toBe(false);
  });
});

describe('bodyLimitFor', () => {
  it('gives the classification import its own limit and every other path the API limit', () => {
    expect(bodyLimitFor('/api/classification/import')).toBe(MAX_CLASSIFICATION_IMPORT_BYTES);
    expect(bodyLimitFor('/api/classification/import/')).toBe(MAX_CLASSIFICATION_IMPORT_BYTES);
    expect(bodyLimitFor('/api/classification/FWRA.MI')).toBe(MAX_API_BODY_BYTES);
    expect(bodyLimitFor('/api/transactions')).toBe(MAX_API_BODY_BYTES);
  });
});
