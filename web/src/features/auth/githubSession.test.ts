import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubSessionService, loginUrl, safeReturnTo } from './githubSession';

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (impl: () => Promise<Response>) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

describe('safeReturnTo / loginUrl', () => {
  it('keeps plain same-origin paths with query and hash', () => {
    expect(safeReturnTo('/holdings?scope=a&b=1#top')).toBe('/holdings?scope=a&b=1#top');
    expect(safeReturnTo('/')).toBe('/');
  });

  it.each(['https://evil.example/x', '//evil.example', '/\\evil.example', '/a\\b', 'holdings', '', '/a\nb', '/a\u007fb', '/auth', '/auth/login', '/auth?x=1', '/auth#x'])(
    'falls back to "/" for %j',
    (path) => {
      expect(safeReturnTo(path)).toBe('/');
    },
  );

  it('keeps paths that merely start with the word auth', () => {
    expect(safeReturnTo('/authors')).toBe('/authors');
  });

  it('builds the full-page sign-in URL with an encoded returnTo', () => {
    expect(loginUrl('/holdings?x=1&y=2#h')).toBe('/auth/login?returnTo=%2Fholdings%3Fx%3D1%26y%3D2%23h');
    expect(loginUrl('//evil.example')).toBe('/auth/login?returnTo=%2F');
  });
});

describe('githubSessionService.fetchSession', () => {
  it('returns the login of an authenticated session and sends the cookie, no-store, and no bearer header', async () => {
    const fetchMock = stubFetch(() => json({ authenticated: true, login: 'octo-owner' }));
    const signal = new AbortController().signal;
    await expect(githubSessionService.fetchSession(signal)).resolves.toBe('octo-owner');
    expect(fetchMock).toHaveBeenCalledWith('/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
  });

  it('returns null when nobody is signed in', async () => {
    stubFetch(() => json({ authenticated: false }));
    await expect(githubSessionService.fetchSession()).resolves.toBeNull();
  });

  it.each([
    ['a server error', () => json({ authenticated: false }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('offline'))],
    ['a body that is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['a JSON body of the wrong shape', () => json(['x'])],
    ['an authenticated session without a login', () => json({ authenticated: true })],
    ['an authenticated session with an empty login', () => json({ authenticated: true, login: '' })],
    ['an unknown authenticated value', () => json({ authenticated: 'yes', login: 'x' })],
    ['a null body', () => json(null)],
  ])('rejects with a friendly message for %s', async (_name, impl) => {
    stubFetch(impl);
    await expect(githubSessionService.fetchSession()).rejects.toThrow('Could not check your sign-in');
  });

  it('passes an abort through unchanged', async () => {
    stubFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(githubSessionService.fetchSession()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('githubSessionService.logout', () => {
  it('POSTs to /auth/logout with the cookie', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(githubSessionService.logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  });

  it('treats 401 (session already gone) as signed out', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 401 })));
    await expect(githubSessionService.logout()).resolves.toBeUndefined();
  });

  it.each([
    ['a server error', () => Promise.resolve(new Response(null, { status: 500 }))],
    ['a network failure', () => Promise.reject(new TypeError('offline'))],
  ])('rejects on %s', async (_name, impl) => {
    stubFetch(impl);
    await expect(githubSessionService.logout()).rejects.toThrow('Could not sign out');
  });
});
