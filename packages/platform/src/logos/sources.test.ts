import { describe, expect, it } from 'vitest';
import { MAX_LOGO_BYTES, sha256Hex } from './image.js';
import { DEFAULT_T212_LOGO_BASE, DuckDuckGoSource, GoogleFaviconSource, LogoDevSource, Trading212LogoSource, createLogoSources, normalizeT212LogoBase, type LogoFetchOptions } from './sources.js';
import { fakeFetch, hangingResponse, htmlBytes, imageResponse, jpegBytes, pngBytes } from '../testing/logo-fixtures.js';

const options = (fetch: typeof globalThis.fetch, extra: Partial<LogoFetchOptions> = {}): LogoFetchOptions => ({ fetch, timeoutMs: 1000, ...extra });
const google = new GoogleFaviconSource();

describe('the keyless sources', () => {
  it('asks Google for a 128 px favicon of the domain and returns a valid png', async () => {
    const fetch = fakeFetch({ 'google.com/s2/favicons': () => imageResponse(pngBytes(128, 128), 'image/png') });
    const result = await google.fetchLogo({ domain: 'example.com' }, options(fetch));
    expect(result).toMatchObject({ ok: true, source: 'google', logo: { contentType: 'image/png', width: 128 } });
    expect(fetch.calls).toEqual(['https://www.google.com/s2/favicons?domain=example.com&sz=128']);
  });

  it('asks DuckDuckGo for the icon of the domain and reads PNG data under an icon content type', async () => {
    const fetch = fakeFetch({ 'icons.duckduckgo.com/ip3/example.com.ico': () => imageResponse(pngBytes(64, 64), 'image/x-icon') });
    const result = await new DuckDuckGoSource().fetchLogo({ domain: 'example.com' }, options(fetch));
    expect(result).toMatchObject({ ok: true, source: 'duckduckgo', logo: { contentType: 'image/png' } });
  });

  it('puts the token only in the logodev request, size and not-found behaviour included', async () => {
    const fetch = fakeFetch({ 'img.logo.dev/example.com': () => imageResponse(jpegBytes(128, 128), 'image/jpeg') });
    const result = await new LogoDevSource('pk_test').fetchLogo({ domain: 'example.com' }, options(fetch));
    expect(result).toMatchObject({ ok: true, source: 'logodev', logo: { contentType: 'image/jpeg' } });
    expect(fetch.calls).toEqual(['https://img.logo.dev/example.com?token=pk_test&size=128&format=png&fallback=404']);
  });

  it('encodes the domain it puts in a URL', async () => {
    const fetch = fakeFetch({});
    await google.fetchLogo({ domain: 'a b.com/../x' }, options(fetch));
    expect(fetch.calls[0]).toContain('domain=a%20b.com%2F..%2Fx');
  });
});

describe('what a source refuses', () => {
  const result = (route: () => Response | Promise<Response>, extra: Partial<LogoFetchOptions> = {}) => google.fetchLogo({ domain: 'example.com' }, options(fakeFetch({ favicons: route }), extra));

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
    const source = google.fetchLogo({ domain: 'example.com' }, options(fakeFetch({ favicons: hangingResponse }), { timeoutMs: 10 }));
    expect(await source).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await result(() => Promise.reject(new TypeError('connection reset')))).toMatchObject({ ok: false, reason: 'network' });
  });

  it('a body that stalls is cut off by the same deadline', async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { headers: { 'content-type': 'image/png' } });
    expect(await google.fetchLogo({ domain: 'example.com' }, options(fakeFetch({ favicons: () => stalled }), { timeoutMs: 10 }))).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('a domain source asked without a domain', () => {
  it.each([new GoogleFaviconSource(), new DuckDuckGoSource(), new LogoDevSource('pk_test')])('$name answers not-found without any request', async (source) => {
    const fetch = fakeFetch({});
    expect(await source.fetchLogo({ t212Ticker: 'AAPL_US_EQ' }, options(fetch))).toEqual({ ok: false, reason: 'not-found', source: source.name });
    expect(fetch.calls).toEqual([]);
  });
});

describe('the Trading 212 bucket source', () => {
  const t212 = new Trading212LogoSource();
  const url = `${DEFAULT_T212_LOGO_BASE}/AAPL_US_EQ.png`;
  const ask = (route: () => Response | Promise<Response>, extra: Partial<LogoFetchOptions> = {}, ticker = 'AAPL_US_EQ') => t212.fetchLogo({ t212Ticker: ticker }, options(fakeFetch({ 'amazonaws.com/': route }), extra));

  it('asks the bucket for <ticker>.png and returns the valid 240 px png', async () => {
    const fetch = fakeFetch({ 'amazonaws.com/AAPL_US_EQ.png': () => imageResponse(pngBytes(240, 240, 4000), 'image/png') });
    const result = await t212.fetchLogo({ t212Ticker: 'AAPL_US_EQ', domain: 'apple.com' }, options(fetch));
    expect(result).toMatchObject({ ok: true, source: 't212', logo: { contentType: 'image/png', width: 240, height: 240 } });
    expect(fetch.calls).toEqual([url]);
  });

  it('keeps the lower case letters of the exchange part and encodes what it puts in the path', async () => {
    const fetch = fakeFetch({});
    await t212.fetchLogo({ t212Ticker: 'SMGBl_EQ' }, options(fetch));
    await t212.fetchLogo({ t212Ticker: 'BRK.B-1_US_EQ' }, options(fetch));
    expect(fetch.calls).toEqual([`${DEFAULT_T212_LOGO_BASE}/SMGBl_EQ.png`, `${DEFAULT_T212_LOGO_BASE}/BRK.B-1_US_EQ.png`]);
  });

  it('refuses a bad ticker before any request', async () => {
    const fetch = fakeFetch({});
    for (const bad of ['', '..', '../x', 'a/b', 'a%2Fb', 'a?b', 'x'.repeat(41)]) {
      expect(await t212.fetchLogo({ t212Ticker: bad }, options(fetch))).toEqual({ ok: false, reason: 'not-found', source: 't212' });
    }
    expect(await t212.fetchLogo({ domain: 'apple.com' }, options(fetch))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(fetch.calls).toEqual([]);
  });

  it('accepts a logo up to 64 KB and refuses more', async () => {
    expect(await ask(() => imageResponse(pngBytes(240, 240, 60_000), 'image/png'))).toMatchObject({ ok: true });
    const big = pngBytes(240, 240, MAX_LOGO_BYTES + 10);
    expect(await ask(() => imageResponse(big, 'image/png', { 'content-length': String(big.length) }))).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('refuses a wrong content type, html, a tiny picture, a 404 and a server error', async () => {
    expect(await ask(() => imageResponse(pngBytes(240, 240), 'binary/octet-stream'))).toMatchObject({ ok: false, reason: 'content-type' });
    expect(await ask(() => imageResponse(htmlBytes(), 'text/html'))).toMatchObject({ ok: false, reason: 'content-type' });
    expect(await ask(() => imageResponse(htmlBytes(), 'image/png'))).toMatchObject({ ok: false, reason: 'not-an-image' });
    expect(await ask(() => imageResponse(pngBytes(32, 32), 'image/png'))).toMatchObject({ ok: false, reason: 'too-small' });
    expect(await ask(() => new Response('', { status: 404 }))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await ask(() => new Response('', { status: 403 }))).toMatchObject({ ok: false, reason: 'http-error' });
  });

  it('times out on a request that does not answer, and never follows a redirect', async () => {
    expect(await ask(hangingResponse, { timeoutMs: 10 })).toMatchObject({ ok: false, reason: 'timeout' });
    const redirects: (RequestRedirect | undefined)[] = [];
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return Promise.reject(new TypeError('redirect'));
    }) as typeof fetch;
    expect(await t212.fetchLogo({ t212Ticker: 'AAPL_US_EQ' }, options(spy))).toMatchObject({ ok: false, reason: 'network' });
    expect(redirects).toEqual(['manual']);
    expect(await ask(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.png' } }))).toMatchObject({ ok: false, reason: 'http-error' });
  });

  it('uses a base override, but only an https amazonaws.com origin unless the test flag is set', async () => {
    const fetch = fakeFetch({ 'my-bucket.s3.eu-west-1.amazonaws.com/KMB_US_EQ.png': () => imageResponse(pngBytes(240, 240), 'image/png') });
    const other = new Trading212LogoSource('https://my-bucket.s3.eu-west-1.amazonaws.com');
    expect(await other.fetchLogo({ t212Ticker: 'KMB_US_EQ' }, options(fetch))).toMatchObject({ ok: true });
    expect(() => new Trading212LogoSource('https://logos.example.com')).toThrow(/amazonaws/);
    expect(() => new Trading212LogoSource('http://a.amazonaws.com')).toThrow(/amazonaws/);
    const fake = new Trading212LogoSource('http://fake-upstream.test:8080', { allowAnyHost: true });
    const fakeFetched = fakeFetch({ 'fake-upstream.test:8080/KMB_US_EQ.png': () => imageResponse(pngBytes(240, 240), 'image/png') });
    expect(await fake.fetchLogo({ t212Ticker: 'KMB_US_EQ' }, options(fakeFetched))).toMatchObject({ ok: true });
  });
});

describe('normalizeT212LogoBase', () => {
  it('accepts a plain https amazonaws.com origin only', () => {
    expect(normalizeT212LogoBase(DEFAULT_T212_LOGO_BASE)).toBe(DEFAULT_T212_LOGO_BASE);
    expect(normalizeT212LogoBase(` ${DEFAULT_T212_LOGO_BASE}/ `)).toBe(DEFAULT_T212_LOGO_BASE);
    for (const bad of [undefined, '', 'not a url', 'http://x.amazonaws.com', 'https://amazonaws.com.evil.test', 'https://evilamazonaws.com', 'https://u:p@x.amazonaws.com', 'https://x.amazonaws.com/p', 'https://x.amazonaws.com/?q=1', 'https://x.amazonaws.com/#h', 'ftp://x.amazonaws.com', 'https://localhost']) {
      expect(normalizeT212LogoBase(bad)).toBeUndefined();
    }
  });

  it('lets the test flag point at any http or https origin, and nothing else', () => {
    const lenient = { allowAnyHost: true };
    expect(normalizeT212LogoBase('http://localhost:9000', lenient)).toBe('http://localhost:9000');
    expect(normalizeT212LogoBase('https://fake.test', lenient)).toBe('https://fake.test');
    expect(normalizeT212LogoBase('file:///etc', lenient)).toBeUndefined();
    expect(normalizeT212LogoBase('ftp://fake.test', lenient)).toBeUndefined();
  });
});

describe('createLogoSources', () => {
  const names = (list: ReturnType<typeof createLogoSources>) => list.map((source) => source.name);

  it('builds the sources in the configured order and skips logodev without a token', () => {
    expect(names(createLogoSources(['logodev', 'google', 'duckduckgo']))).toEqual(['google', 'duckduckgo']);
    expect(names(createLogoSources(['logodev', 'google', 'duckduckgo'], { logoDevToken: 'pk_x' }))).toEqual(['logodev', 'google', 'duckduckgo']);
    expect(names(createLogoSources(['duckduckgo', 'google'], { logoDevToken: '' }))).toEqual(['duckduckgo', 'google']);
    expect(createLogoSources(['logodev'], { logoDevToken: '' })).toEqual([]);
    expect(createLogoSources([])).toEqual([]);
  });

  it('builds the Trading 212 source with the default or the given base, asked by ticker', () => {
    const [source] = createLogoSources(['t212']);
    expect(source).toMatchObject({ name: 't212', by: 't212Ticker' });
    expect(names(createLogoSources(['t212', 'logodev', 'google', 'duckduckgo'], { logoDevToken: 'pk_x' }))).toEqual(['t212', 'logodev', 'google', 'duckduckgo']);
    expect(createLogoSources(['google'])[0]).toMatchObject({ by: 'domain' });
    expect(() => createLogoSources(['t212'], { t212Base: 'https://evil.test' })).toThrow();
  });
});
