import { describe, expect, it, vi } from 'vitest';
import type { PortableRequest } from '../http.js';
import { MemoryItemStore } from '../memory/item-store.js';
import { pngBytes, svgBytes } from '../testing/logo-fixtures.js';
import { LOGO_CACHE_SECONDS, LOGO_MISSING_CACHE_SECONDS, createLogoRoute } from './route.js';
import { LogoService } from './service.js';
import type { LogoFetchResult, LogoSource } from './sources.js';
import { ItemLogoStore } from './store.js';
import { portableToFetchResponse } from '../auth/github/fetch-adapter.js';

const NOW = new Date('2026-03-01T10:20:00.000Z');

function setup(answer: (domain: string) => LogoFetchResult, hourlyLimit = 30) {
  const calls: string[] = [];
  const source: LogoSource = {
    name: 'fake',
    by: 'domain',
    fetchLogo: ({ domain }) => {
      calls.push(domain!);
      return Promise.resolve(answer(domain!));
    },
  };
  const service = new LogoService({ store: new ItemLogoStore(new MemoryItemStore()), sources: [source], now: () => NOW, hourlyLimit, negativeTtlDays: 7, fetch: vi.fn() as unknown as typeof fetch });
  const resolveSubject = vi.fn((_user: string, symbol: string) => Promise.resolve(symbol === 'NODOMAIN' ? undefined : { domain: `${symbol.toLowerCase().replace(/\W/g, '')}.example.com` }));
  const route = createLogoRoute({ service, resolveSubject });
  const request = (path: string, headers: Record<string, string> = {}, extra: Partial<PortableRequest> = {}): PortableRequest => ({ method: 'GET', path, query: {}, headers, identity: { subject: 'github-1' }, ...extra });
  return { route, request, calls, resolveSubject };
}

const png = (): LogoFetchResult => ({ ok: true, source: 'fake', logo: { bytes: pngBytes(), contentType: 'image/png', width: 128, height: 128 } });
const nothing = (): LogoFetchResult => ({ ok: false, source: 'fake', reason: 'not-found' });

describe('GET /logos/{symbol}', () => {
  it('serves the image bytes with a private cache, a validator and nosniff', async () => {
    const { route, request } = setup(png);
    const response = (await route(request('/logos/AAPL')))!;
    expect(response.status).toBe(200);
    expect(response.bytes).toEqual(pngBytes());
    expect(response.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': `private, max-age=${LOGO_CACHE_SECONDS}`, 'x-content-type-options': 'nosniff', 'content-length': String(pngBytes().length) });
    expect(response.headers.etag).toMatch(/^"v2-fake-[0-9a-f]{32}"$/);
    expect(response.headers).not.toHaveProperty('content-security-policy');
    const fetched = portableToFetchResponse(response);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(pngBytes());
  });

  it('answers 304 without a body when the validator matches (also weak, listed or *) and 200 when it does not', async () => {
    const { route, request } = setup(png);
    const first = (await route(request('/logos/AAPL')))!;
    const etag = first.headers.etag!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const again = (await route(request('/logos/AAPL', { 'if-none-match': header })))!;
      expect(again).toMatchObject({ status: 304, body: '', headers: { etag, 'cache-control': `private, max-age=${LOGO_CACHE_SECONDS}` } });
      expect(again.bytes).toBeUndefined();
    }
    expect((await route(request('/logos/AAPL', { 'if-none-match': '"stale"' })))!.status).toBe(200);
    expect(portableToFetchResponse((await route(request('/logos/AAPL', { 'if-none-match': etag })))!).status).toBe(304);
  });

  it('keeps the browser cache short and changes the validator with the source, so a better source is not pinned', async () => {
    expect(LOGO_CACHE_SECONDS).toBeLessThanOrEqual(86_400);
    const etags: string[] = [];
    for (const name of ['google', 't212']) {
      const source: LogoSource = { name, by: 'domain', fetchLogo: () => Promise.resolve({ ok: true, source: name, logo: { bytes: pngBytes(), contentType: 'image/png', width: 128, height: 128 } }) };
      const service = new LogoService({ store: new ItemLogoStore(new MemoryItemStore()), sources: [source], now: () => NOW, hourlyLimit: 5, negativeTtlDays: 7 });
      const route = createLogoRoute({ service, resolveSubject: () => Promise.resolve({ domain: 'a.example.com' }) });
      const response = (await route({ method: 'GET', path: '/logos/AAPL', query: {}, headers: {}, identity: { subject: 'u' } }))!;
      etags.push(response.headers.etag!);
    }
    expect(new Set(etags).size).toBe(2);
  });

  it('looks a symbol up by the subject its resolver gives: ticker first, then the domain', async () => {
    const asked: unknown[] = [];
    const source: LogoSource = { name: 't212', by: 't212Ticker', fetchLogo: (subject) => (asked.push(subject), Promise.resolve(png())) };
    const service = new LogoService({ store: new ItemLogoStore(new MemoryItemStore()), sources: [source], now: () => NOW, hourlyLimit: 5, negativeTtlDays: 7 });
    const route = createLogoRoute({ service, resolveSubject: () => Promise.resolve({ t212Ticker: 'KMB_US_EQ', domain: 'kimberly-clark.com' }) });
    const response = (await route({ method: 'GET', path: '/logos/KMB', query: {}, headers: {}, identity: { subject: 'u' } }))!;
    expect(response.status).toBe(200);
    expect(asked).toEqual([{ t212Ticker: 'KMB_US_EQ', domain: 'kimberly-clark.com' }]);
  });

  it('hardens an svg opened as a page', async () => {
    const { route, request } = setup(() => ({ ok: true, source: 'fake', logo: { bytes: svgBytes(), contentType: 'image/svg+xml' } }));
    const response = (await route(request('/logos/AAPL')))!;
    expect(response.headers).toMatchObject({ 'content-type': 'image/svg+xml', 'content-security-policy': expect.stringContaining('sandbox') });
  });

  it('answers a cached 404 for a symbol nobody has a logo for, and fetches that domain once', async () => {
    const { route, request, calls } = setup(nothing);
    const first = (await route(request('/logos/ZZZ')))!;
    const second = (await route(request('/logos/ZZZ')))!;
    for (const response of [first, second]) {
      expect(response).toMatchObject({ status: 404, headers: { 'cache-control': `private, max-age=${LOGO_MISSING_CACHE_SECONDS}` } });
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'NOT_FOUND', message: 'No logo for this symbol' } });
    }
    expect(calls).toEqual(['zzz.example.com']);
  });

  it('answers 404 for a symbol with no known domain, without any lookup', async () => {
    const { route, request, calls } = setup(png);
    expect((await route(request('/logos/NODOMAIN')))!.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 404 for a path that is not a market symbol, however it is encoded', async () => {
    const { route, request, resolveSubject } = setup(png);
    for (const path of ['/logos/%E0%A4%A', '/logos/..%2F..%2Fsecret', '/logos/a%20b', `/logos/${'A'.repeat(40)}`]) {
      expect((await route(request(path)))!.status).toBe(404);
    }
    expect(resolveSubject).not.toHaveBeenCalled();
  });

  it('decodes an encoded symbol', async () => {
    const { route, request, resolveSubject } = setup(png);
    await route(request('/logos/BRK.B'));
    await route(request('/logos/SAP%2EDE'));
    expect(resolveSubject.mock.calls.map(([, symbol]) => symbol)).toEqual(['BRK.B', 'SAP.DE']);
  });

  it('needs an authenticated user', async () => {
    const { route, request, resolveSubject } = setup(png);
    const response = (await route(request('/logos/AAPL', {}, { identity: undefined })))!;
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHENTICATED');
    expect(resolveSubject).not.toHaveBeenCalled();
  });

  it('limits the lookups per hour with a 429 and Retry-After, and still serves what is stored', async () => {
    const { route, request, calls } = setup(png, 2);
    await route(request('/logos/AAA'));
    await route(request('/logos/BBB'));
    const limited = (await route(request('/logos/CCC')))!;
    expect(limited).toMatchObject({ status: 429, headers: { 'retry-after': '2400', 'cache-control': 'no-store' } });
    expect(JSON.parse(limited.body).error.code).toBe('LOGO_RATE_LIMITED');
    expect((await route(request('/logos/AAA')))!.status).toBe(200);
    expect(calls).toEqual(['aaa.example.com', 'bbb.example.com']);
  });

  it('leaves every other request to the application', () => {
    const { route, request } = setup(png);
    expect(route(request('/logos'))).toBeUndefined();
    expect(route(request('/logos/AAPL/extra'))).toBeUndefined();
    expect(route(request('/assets/AAPL'))).toBeUndefined();
    expect(route(request('/logos/AAPL', {}, { method: 'POST' }))).toBeUndefined();
  });

  it('gives each lookup its own counted fetch', async () => {
    const seen: unknown[] = [];
    const source: LogoSource = { name: 'spy', by: 'domain', fetchLogo: (_d, o) => (seen.push(o.fetch), Promise.resolve(nothing())) };
    const service = new LogoService({ store: new ItemLogoStore(new MemoryItemStore()), sources: [source], now: () => NOW, hourlyLimit: 5, negativeTtlDays: 7 });
    const counted = vi.fn() as unknown as typeof fetch;
    const route = createLogoRoute({ service, resolveSubject: () => Promise.resolve({ domain: 'a.example.com' }), fetchFor: () => counted });
    await route({ method: 'GET', path: '/logos/AAPL', query: {}, headers: {}, identity: { subject: 'u' } });
    expect(seen).toEqual([counted]);
  });
});
