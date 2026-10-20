import { describe, expect, it } from 'vitest';
import { MAX_LOGO_BYTES, sha256Hex } from './image.js';
import { DuckDuckGoSource, GoogleFaviconSource, LogoDevSource, createLogoSources, type LogoFetchOptions } from './sources.js';
import { fakeFetch, hangingResponse, htmlBytes, imageResponse, jpegBytes, pngBytes } from '../testing/logo-fixtures.js';

const options = (fetch: typeof globalThis.fetch, extra: Partial<LogoFetchOptions> = {}): LogoFetchOptions => ({ fetch, timeoutMs: 1000, ...extra });
const google = new GoogleFaviconSource();

describe('the keyless sources', () => {
  it('asks Google for a 128 px favicon of the domain and returns a valid png', async () => {
    const fetch = fakeFetch({ 'google.com/s2/favicons': () => imageResponse(pngBytes(128, 128), 'image/png') });
    const result = await google.fetchLogo('example.com', options(fetch));
    expect(result).toMatchObject({ ok: true, source: 'google', logo: { contentType: 'image/png', width: 128 } });
    expect(fetch.calls).toEqual(['https://www.google.com/s2/favicons?domain=example.com&sz=128']);
  });

  it('asks DuckDuckGo for the icon of the domain and reads PNG data under an icon content type', async () => {
    const fetch = fakeFetch({ 'icons.duckduckgo.com/ip3/example.com.ico': () => imageResponse(pngBytes(64, 64), 'image/x-icon') });
    const result = await new DuckDuckGoSource().fetchLogo('example.com', options(fetch));
    expect(result).toMatchObject({ ok: true, source: 'duckduckgo', logo: { contentType: 'image/png' } });
  });

  it('puts the token only in the logodev request, size and not-found behaviour included', async () => {
    const fetch = fakeFetch({ 'img.logo.dev/example.com': () => imageResponse(jpegBytes(128, 128), 'image/jpeg') });
    const result = await new LogoDevSource('pk_test').fetchLogo('example.com', options(fetch));
    expect(result).toMatchObject({ ok: true, source: 'logodev', logo: { contentType: 'image/jpeg' } });
    expect(fetch.calls).toEqual(['https://img.logo.dev/example.com?token=pk_test&size=128&format=png&fallback=404']);
  });

  it('encodes the domain it puts in a URL', async () => {
    const fetch = fakeFetch({});
    await google.fetchLogo('a b.com/../x', options(fetch));
    expect(fetch.calls[0]).toContain('domain=a%20b.com%2F..%2Fx');
  });
});

describe('what a source refuses', () => {
  const result = (route: () => Response | Promise<Response>, extra: Partial<LogoFetchOptions> = {}) => google.fetchLogo('example.com', options(fakeFetch({ favicons: route }), extra));

  it('a 404 is not-found and other failures are http errors', async () => {
    expect(await result(() => new Response('', { status: 404 }))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await result(() => new Response('', { status: 410 }))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await result(() => new Response('', { status: 503 }))).toMatchObject({ ok: false, reason: 'http-error' });
    expect(await result(() => new Response('', { status: 429 }))).toMatchObject({ ok: false, reason: 'http-error' });
  });

  it('a page of html, even under an image type, is refused', async () => {
    expect(await result(() => imageResponse(htmlBytes(), 'text/html; charset=utf-8'))).toMatchObject({ ok: false, reason: 'content-type' });
    expect(await result(() => imageResponse(htmlBytes(), 'image/png'))).toMatchObject({ ok: false, reason: 'not-an-image' });
  });

  it('a wrong type is refused', async () => {
    expect(await result(() => imageResponse(pngBytes(), 'application/octet-stream'))).toMatchObject({ ok: false, reason: 'content-type' });
    expect(await result(() => imageResponse(pngBytes(), 'image/gif'))).toMatchObject({ ok: false, reason: 'content-type' });
  });

  it('an oversize body is refused from its declared length and, without one, while reading', async () => {
    const big = pngBytes(128, 128, MAX_LOGO_BYTES + 100);
    expect(await result(() => imageResponse(big, 'image/png', { 'content-length': String(big.length) }))).toMatchObject({ ok: false, reason: 'too-large' });
    const streamed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(big.subarray(0, 30_000));
          controller.enqueue(big.subarray(30_000));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    );
    expect(await result(() => streamed)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await result(() => imageResponse(big, 'image/png'), { maxBytes: 10 })).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('a response without a body is empty', async () => {
    expect(await result(() => new Response(null, { status: 200, headers: { 'content-type': 'image/png' } }))).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('the generic default icon is refused by size and by the hash of its exact bytes', async () => {
    expect(await result(() => imageResponse(pngBytes(16, 16), 'image/png'))).toMatchObject({ ok: false, reason: 'too-small' });
    const globe = pngBytes(64, 64, 3);
    const placeholderHashes = new Set([await sha256Hex(globe)]);
    expect(await result(() => imageResponse(globe, 'image/png'), { placeholderHashes })).toMatchObject({ ok: false, reason: 'placeholder' });
    expect(await result(() => imageResponse(pngBytes(16, 16), 'image/png'), { minPixels: 8 })).toMatchObject({ ok: true });
  });

  it('a request that does not answer in time is a timeout, and a broken connection a network error', async () => {
    const source = google.fetchLogo('example.com', options(fakeFetch({ favicons: hangingResponse }), { timeoutMs: 10 }));
    expect(await source).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await result(() => Promise.reject(new TypeError('connection reset')))).toMatchObject({ ok: false, reason: 'network' });
  });

  it('a body that stalls is cut off by the same deadline', async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { headers: { 'content-type': 'image/png' } });
    expect(await google.fetchLogo('example.com', options(fakeFetch({ favicons: () => stalled }), { timeoutMs: 10 }))).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('createLogoSources', () => {
  it('builds the sources in the configured order and skips logodev without a token', () => {
    expect(createLogoSources(['logodev', 'google', 'duckduckgo']).map((source) => source.name)).toEqual(['google', 'duckduckgo']);
    expect(createLogoSources(['logodev', 'google', 'duckduckgo'], 'pk_x').map((source) => source.name)).toEqual(['logodev', 'google', 'duckduckgo']);
    expect(createLogoSources(['duckduckgo', 'google'], '').map((source) => source.name)).toEqual(['duckduckgo', 'google']);
    expect(createLogoSources(['logodev'], '')).toEqual([]);
    expect(createLogoSources([])).toEqual([]);
  });
});
