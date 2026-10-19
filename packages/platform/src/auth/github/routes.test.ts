import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortableResponse } from '../../http.js';
import {
  ACCESS_TOKEN, CLIENT_SECRET, ORIGIN, OWNER_ID, SESSION_SECRET, T0,
  cookieNamed, cookieValues, fakeGithub, portableRequest, testConfig,
} from '../../testing/github-auth.js';
import { createTokenSigner } from './crypto.js';
import { createGithubIdentityResolver } from './identity.js';
import { createAuthFetchHandler, createAuthRoutes } from './routes.js';

afterEach(() => vi.restoreAllMocks());

const SESSION_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800';
const STATE_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600';

async function startLogin(routes: ReturnType<typeof createAuthRoutes>, returnTo?: string) {
  const response = (await routes(portableRequest('/auth/login', { query: returnTo === undefined ? {} : { returnTo } })))!;
  const location = new URL(response.headers.location!);
  return { response, location, state: location.searchParams.get('state')!, stateCookie: cookieValues(response).pt_state ?? cookieValues(response).pt_oauth_state! };
}

async function signIn(config = testConfig(), returnTo?: string) {
  const routes = createAuthRoutes(config);
  const login = await startLogin(routes, returnTo);
  const response = (await routes(portableRequest('/auth/callback', {
    query: { code: 'code-1', state: login.state },
    headers: { cookie: `pt_oauth_state=${login.stateCookie}` },
  })))!;
  return { config, routes, login, response };
}

const sessionCookieOf = (response: PortableResponse) => cookieValues(response).pt_session!;

/** Changes the first character: the last base64url character carries padding bits that decoding ignores. */
const flipFirst = (signature: string): string => `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

describe('GET /auth/login', () => {
  it('redirects to GitHub with only client_id, redirect_uri, empty scope and a random state', async () => {
    const config = testConfig();
    const { response, location, state } = await startLogin(createAuthRoutes(config));
    expect(response.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: 'client-id-123',
      redirect_uri: `${ORIGIN}/auth/callback`,
      scope: '',
      state,
    });
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.location).not.toContain(CLIENT_SECRET);
  });

  it('uses a different state each time', async () => {
    const routes = createAuthRoutes(testConfig());
    expect((await startLogin(routes)).state).not.toBe((await startLogin(routes)).state);
  });

  it('sets a signed 10 minute state cookie with the required attributes', async () => {
    const { response } = await startLogin(createAuthRoutes(testConfig()));
    expect(response.cookies).toHaveLength(1);
    expect(cookieNamed(response, 'pt_oauth_state')).toMatch(new RegExp(`^pt_oauth_state=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; ${STATE_ATTRS}$`));
  });

  it('rejects non-GET methods', async () => {
    const response = await createAuthRoutes(testConfig())(portableRequest('/auth/login', { method: 'POST' }));
    expect(response?.status).toBe(405);
    expect(response?.headers.allow).toBe('GET');
  });

  it.each([
    ['//evil.com'], ['/\\evil'], ['https://evil'], ['%2f%2fevil.com'], ['/ok\nSet-Cookie: a=b'], ['/ok\r\nx'], ['javascript:alert(1)'], ['/auth/login'],
  ])('falls back to / for the returnTo %j (no open redirect)', async (returnTo) => {
    const routes = createAuthRoutes(testConfig());
    const login = await startLogin(routes, returnTo);
    const callback = await routes(portableRequest('/auth/callback', {
      query: { code: 'c', state: login.state },
      headers: { cookie: `pt_oauth_state=${login.stateCookie}` },
    }));
    expect(callback?.status).toBe(302);
    expect(callback?.headers.location).toBe('/');
  });
});

describe('GET /auth/callback', () => {
  it('signs the owner in: session cookie, cleared state cookie, redirect to returnTo', async () => {
    const { response, config } = await signIn(testConfig(), '/portfolios/p1?tab=2');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/portfolios/p1?tab=2');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.cookies).toHaveLength(2);
    expect(cookieNamed(response, 'pt_session')).toMatch(new RegExp(`^pt_session=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; ${SESSION_ATTRS.replace('/', '/')}$`));
    expect(cookieNamed(response, 'pt_oauth_state')).toBe('pt_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0');

    const [payloadPart] = sessionCookieOf(response).split('.') as [string];
    const payload = JSON.parse(atob(payloadPart.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    expect(payload).toEqual({ sub: `github:${OWNER_ID}`, login: 'the-owner', iat: T0 / 1000, exp: T0 / 1000 + 604_800 });
    expect(config.fakeGithub.calls.map((call) => call.url)).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
  });

  it('honours a custom session ttl', async () => {
    const { response } = await signIn(testConfig({ sessionTtlSeconds: 3600 }));
    expect(cookieNamed(response, 'pt_session')).toContain('Max-Age=3600');
  });

  it('exchanges the code with GitHub using POST + Accept: application/json and calls /user with a User-Agent', async () => {
    const { config } = await signIn();
    const [token, user] = config.fakeGithub.calls;
    expect(token!.init?.method).toBe('POST');
    expect(token!.init?.headers).toMatchObject({ accept: 'application/json' });
    expect(JSON.parse(token!.init!.body as string)).toEqual({ client_id: 'client-id-123', client_secret: CLIENT_SECRET, code: 'code-1', redirect_uri: `${ORIGIN}/auth/callback` });
    expect(user!.init?.headers).toMatchObject({ authorization: `Bearer ${ACCESS_TOKEN}` });
    expect((user!.init?.headers as Record<string, string>)['user-agent']).toBeTruthy();
  });

  it('never sets a session for another GitHub user and does not reveal the owner', async () => {
    const github = fakeGithub({ id: OWNER_ID + 1, login: 'someone-else' });
    const { response } = await signIn(testConfig({ fetch: github.fetch }));
    expect(response.status).toBe(403);
    expect(cookieNamed(response, 'pt_session')).toBeUndefined();
    expect(cookieNamed(response, 'pt_oauth_state')).toContain('Max-Age=0');
    expect(response.headers.location).toBeUndefined();
    const everything = JSON.stringify(response);
    for (const secret of [String(OWNER_ID), 'the-owner', 'someone-else', ACCESS_TOKEN, CLIENT_SECRET, SESSION_SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('rejects a user whose id is a string (type confusion) or whose profile is malformed', async () => {
    for (const profile of [{ id: String(OWNER_ID), login: 'x' }, { id: OWNER_ID }, { id: OWNER_ID, login: 'x'.repeat(101) }, [], null, 'text']) {
      const github = fakeGithub();
      github.userResponse = () => new Response(JSON.stringify(profile), { status: 200 });
      const { response } = await signIn(testConfig({ fetch: github.fetch }));
      expect(response.status, JSON.stringify(profile)).toBe(502);
      expect(cookieNamed(response, 'pt_session')).toBeUndefined();
    }
  });

  it('rejects a missing state cookie, a missing query state or code, and a state mismatch (replay of another login)', async () => {
    const routes = createAuthRoutes(testConfig());
    const first = await startLogin(routes);
    const second = await startLogin(routes);
    const cookie = `pt_oauth_state=${first.stateCookie}`;
    const attempts = [
      portableRequest('/auth/callback', { query: { code: 'c', state: first.state } }),
      portableRequest('/auth/callback', { query: { code: 'c' }, headers: { cookie } }),
      portableRequest('/auth/callback', { query: { state: first.state }, headers: { cookie } }),
      portableRequest('/auth/callback', { query: { code: 'c', state: second.state }, headers: { cookie } }),
      portableRequest('/auth/callback', { query: { code: 'c', state: `${first.state}x` }, headers: { cookie } }),
      portableRequest('/auth/callback', { query: { code: 'c', state: '' }, headers: { cookie } }),
    ];
    for (const attempt of attempts) {
      const response = await routes(attempt);
      expect(response?.status).toBe(400);
      expect(cookieNamed(response!, 'pt_session')).toBeUndefined();
    }
  });

  it('rejects an expired state cookie', async () => {
    let now = T0;
    const config = testConfig({ now: () => now });
    const routes = createAuthRoutes(config);
    const login = await startLogin(routes);
    now = T0 + 10 * 60 * 1000;
    const response = await routes(portableRequest('/auth/callback', { query: { code: 'c', state: login.state }, headers: { cookie: `pt_oauth_state=${login.stateCookie}` } }));
    expect(response?.status).toBe(400);
    expect(config.fakeGithub.calls).toHaveLength(0);
  });

  it('accepts the state cookie just before it expires', async () => {
    let now = T0;
    const config = testConfig({ now: () => now });
    const routes = createAuthRoutes(config);
    const login = await startLogin(routes);
    now = T0 + 10 * 60 * 1000 - 1000;
    const response = await routes(portableRequest('/auth/callback', { query: { code: 'c', state: login.state }, headers: { cookie: `pt_oauth_state=${login.stateCookie}` } }));
    expect(response?.status).toBe(302);
  });

  it('rejects a tampered, foreign-secret, or session-cookie-as-state cookie before contacting GitHub', async () => {
    const config = testConfig();
    const routes = createAuthRoutes(config);
    const login = await startLogin(routes);
    const other = await startLogin(createAuthRoutes(testConfig({ sessionSecret: 'another-secret-another-secret-123456' })));
    const [payload, signature] = login.stateCookie.split('.') as [string, string];
    const forged = await createTokenSigner(SESSION_SECRET).sign('pt_session', { state: login.state, returnTo: '/', exp: T0 / 1000 + 600 });
    const cookies = [`${payload}.${flipFirst(signature)}`, `${payload}x.${signature}`, other.stateCookie, forged, `${payload}`];
    for (const value of cookies) {
      const response = await routes(portableRequest('/auth/callback', { query: { code: 'c', state: login.state }, headers: { cookie: `pt_oauth_state=${value}` } }));
      expect(response?.status).toBe(400);
    }
    expect(config.fakeGithub.calls).toHaveLength(0);
  });

  it('rejects a signed state cookie with the wrong structure', async () => {
    const config = testConfig();
    const routes = createAuthRoutes(config);
    const signer = createTokenSigner(SESSION_SECRET);
    for (const payload of [{ state: 1, returnTo: '/', exp: T0 / 1000 + 60 }, { state: 's', returnTo: 2, exp: T0 / 1000 + 60 }, { state: 's', returnTo: '/', exp: 'soon' }, ['s'], null]) {
      const value = await signer.sign('pt_oauth_state', payload as object);
      const response = await routes(portableRequest('/auth/callback', { query: { code: 'c', state: 's' }, headers: { cookie: `pt_oauth_state=${value}` } }));
      expect(response?.status).toBe(400);
    }
  });

  it('re-sanitises the returnTo carried in the state cookie', async () => {
    const config = testConfig();
    const routes = createAuthRoutes(config);
    const value = await createTokenSigner(SESSION_SECRET).sign('pt_oauth_state', { state: 's', returnTo: '//evil.com', exp: T0 / 1000 + 60 });
    const response = await routes(portableRequest('/auth/callback', { query: { code: 'c', state: 's' }, headers: { cookie: `pt_oauth_state=${value}` } }));
    expect(response?.headers.location).toBe('/');
  });

  it('returns 502 without leaking tokens or secrets when GitHub or the network fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scenarios: ((github: ReturnType<typeof fakeGithub>) => void)[] = [
      (g) => { g.tokenResponse = () => { throw new Error(`boom ${CLIENT_SECRET}`); }; },
      (g) => { g.tokenResponse = () => new Response('', { status: 500 }); },
      (g) => { g.tokenResponse = () => new Response('<html>', { status: 200 }); },
      (g) => { g.tokenResponse = () => new Response(JSON.stringify({ error: 'incorrect_client_credentials' }), { status: 200 }); },
      (g) => { g.tokenResponse = () => new Response(JSON.stringify({ access_token: '' }), { status: 200 }); },
      (g) => { g.tokenResponse = () => new Response(JSON.stringify({ access_token: 5 }), { status: 200 }); },
      (g) => { g.tokenResponse = () => new Response('[]', { status: 200 }); },
      (g) => { g.userResponse = () => { throw new Error(`boom ${ACCESS_TOKEN}`); }; },
      (g) => { g.userResponse = () => new Response('', { status: 401 }); },
      (g) => { g.userResponse = () => new Response('not json', { status: 200 }); },
    ];
    for (const scenario of scenarios) {
      const github = fakeGithub();
      scenario(github);
      const { response } = await signIn(testConfig({ fetch: github.fetch }));
      expect(response.status).toBe(502);
      expect(cookieNamed(response, 'pt_session')).toBeUndefined();
      const body = JSON.stringify(response);
      for (const secret of [ACCESS_TOKEN, CLIENT_SECRET, SESSION_SECRET, 'boom']) expect(body).not.toContain(secret);
    }
    for (const spy of [log, error, warn]) expect(spy).not.toHaveBeenCalled();
  });

  it('answers 400 when GitHub rejects the code as invalid (e.g. a replayed code)', async () => {
    const github = fakeGithub();
    github.tokenResponse = () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 });
    const { response } = await signIn(testConfig({ fetch: github.fetch }));
    expect(response.status).toBe(400);
  });

  it('rejects non-GET methods', async () => {
    expect((await createAuthRoutes(testConfig())(portableRequest('/auth/callback', { method: 'POST' })))?.status).toBe(405);
  });

  it('never stores or returns the access token', async () => {
    const { response } = await signIn();
    expect(JSON.stringify(response)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(response)).not.toContain(CLIENT_SECRET);
  });
});

describe('GET /auth/session', () => {
  it('reports the owner for a valid cookie, never 401, always no-store', async () => {
    const { routes, response } = await signIn();
    const session = await routes(portableRequest('/auth/session', { headers: { cookie: `pt_session=${sessionCookieOf(response)}` } }));
    expect(session?.status).toBe(200);
    expect(JSON.parse(session!.body)).toEqual({ authenticated: true, login: 'the-owner' });
    expect(session?.headers['cache-control']).toBe('no-store');
    expect(session?.headers['content-type']).toBe('application/json');
  });

  it('reports anonymous without cookie or with a bad one', async () => {
    const routes = createAuthRoutes(testConfig());
    for (const headers of [{}, { cookie: 'pt_session=garbage' }, { cookie: 'other=1' }]) {
      const session = await routes(portableRequest('/auth/session', { headers }));
      expect(session?.status).toBe(200);
      expect(JSON.parse(session!.body)).toEqual({ authenticated: false });
      expect(session?.headers['cache-control']).toBe('no-store');
    }
  });

  it('rejects non-GET methods', async () => {
    expect((await createAuthRoutes(testConfig())(portableRequest('/auth/session', { method: 'DELETE' })))?.status).toBe(405);
  });
});

describe('session cookie validation (identity resolver)', () => {
  const nowSeconds = T0 / 1000;
  const sign = (payload: object, secret = SESSION_SECRET, purpose = 'pt_session') => createTokenSigner(secret).sign(purpose, payload);
  const resolve = async (value: string, config = testConfig()) =>
    createGithubIdentityResolver(config).identify({ headers: { cookie: `pt_session=${value}` } });
  const claims = (extra: object = {}) => ({ sub: `github:${OWNER_ID}`, login: 'the-owner', iat: nowSeconds, exp: nowSeconds + 60, ...extra });

  it('accepts a freshly signed session and returns the github subject', async () => {
    const { response } = await signIn();
    expect(await resolve(sessionCookieOf(response))).toEqual({ subject: `github:${OWNER_ID}` });
    expect(await resolve(await sign(claims()))).toEqual({ subject: `github:${OWNER_ID}` });
  });

  it('rejects a tampered payload, signature, or one signed with the wrong secret', async () => {
    const { response } = await signIn();
    const [payload, signature] = sessionCookieOf(response).split('.') as [string, string];
    const forgedPayload = btoa(JSON.stringify(claims({ login: 'admin' }))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    expect(await resolve(`${forgedPayload}.${signature}`)).toBeUndefined();
    expect(await resolve(`${payload}.${flipFirst(signature)}`)).toBeUndefined();
    expect(await resolve(await sign(claims(), 'a-completely-different-32-char-secret!'))).toBeUndefined();
  });

  it('rejects an expired session and accepts one right before expiry', async () => {
    let now = T0;
    const config = testConfig({ now: () => now });
    const token = await sign(claims());
    now = T0 + 59_000;
    expect(await resolve(token, config)).toBeDefined();
    now = T0 + 60_000;
    expect(await resolve(token, config)).toBeUndefined();
    now = T0 + 5 * 24 * 3600_000;
    expect(await resolve(token, config)).toBeUndefined();
  });

  it('expires sessions after the configured ttl', async () => {
    let now = T0;
    const config = testConfig({ now: () => now, sessionTtlSeconds: 100 });
    const { response } = await signIn(config);
    const cookie = sessionCookieOf(response);
    now = T0 + 99_000;
    expect(await resolve(cookie, config)).toBeDefined();
    now = T0 + 100_000;
    expect(await resolve(cookie, config)).toBeUndefined();
  });

  it('rejects wrong structure and algorithm confusion even when correctly signed', async () => {
    const bad: unknown[] = [
      { alg: 'none' },
      claims({ sub: 'github:1' }),
      claims({ sub: `user:${OWNER_ID}` }),
      claims({ sub: OWNER_ID }),
      claims({ login: 7 }),
      claims({ iat: 'now' }),
      claims({ exp: 'later' }),
      claims({ exp: nowSeconds + 0.5 }),
      claims({ exp: undefined }),
      claims({ iat: nowSeconds + 120, exp: nowSeconds + 60 }),
      [],
      null,
      'string',
      42,
    ];
    for (const payload of bad) {
      const token = await createTokenSigner(SESSION_SECRET).sign('pt_session', payload as object);
      expect(await resolve(token), JSON.stringify(payload)).toBeUndefined();
    }
  });

  it('rejects a token signed for another purpose (state cookie used as session) and JWT-shaped tokens', async () => {
    expect(await resolve(await sign(claims(), SESSION_SECRET, 'pt_oauth_state'))).toBeUndefined();
    const token = await sign(claims());
    expect(await resolve(`eyJhbGciOiJub25lIn0.${token}`)).toBeUndefined();
    expect(await resolve('eyJhbGciOiJub25lIn0.eyJzdWIiOiJnaXRodWI6NDI0MjQyIn0.')).toBeUndefined();
    expect(await resolve('')).toBeUndefined();
  });

  it('rejects a session of a different owner id (owner changed in config)', async () => {
    const token = await sign(claims({ sub: 'github:999' }));
    expect(await resolve(token, testConfig({ ownerGithubId: 999 }))).toEqual({ subject: 'github:999' });
    expect(await resolve(token)).toBeUndefined();
  });

  it('changing the session secret signs everyone out', async () => {
    const { response } = await signIn();
    const cookie = sessionCookieOf(response);
    expect(await resolve(cookie)).toBeDefined();
    expect(await resolve(cookie, testConfig({ sessionSecret: 'rotated-secret-rotated-secret-123456' }))).toBeUndefined();
  });

  it('is anonymous without a cookie and works with a Fetch Request', async () => {
    const resolver = createGithubIdentityResolver(testConfig());
    expect(await resolver.identify({ headers: {} })).toBeUndefined();
    const { response } = await signIn();
    const withCookie = new Request(`${ORIGIN}/api/x`, { headers: { cookie: `pt_session=${sessionCookieOf(response)}` } });
    expect(await resolver.identify(withCookie)).toEqual({ subject: `github:${OWNER_ID}` });
    expect(await resolver.identify(new Request(`${ORIGIN}/api/x`))).toBeUndefined();
  });

  it('fails at construction for a missing or short secret', () => {
    expect(() => createGithubIdentityResolver(testConfig({ sessionSecret: '' }))).toThrow();
    expect(() => createGithubIdentityResolver(testConfig({ sessionSecret: 'short' }))).toThrow();
    expect(() => createAuthRoutes(testConfig({ sessionSecret: 'short' }))).toThrow(/at least 32/);
    expect(() => createAuthFetchHandler(testConfig({ sessionSecret: '' }))).toThrow();
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookie for a same-origin request', async () => {
    const routes = createAuthRoutes(testConfig());
    const response = await routes(portableRequest('/auth/logout', { method: 'POST', headers: { origin: ORIGIN } }));
    expect(response?.status).toBe(204);
    expect(response?.body).toBe('');
    expect(response?.cookies).toEqual(['pt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    const viaFetchHint = await routes(portableRequest('/auth/logout', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(viaFetchHint?.status).toBe(204);
  });

  it('rejects cross-origin and origin-less posts with 403 and keeps the session', async () => {
    const routes = createAuthRoutes(testConfig());
    for (const headers of [{ origin: 'https://evil.example' }, {}, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await routes(portableRequest('/auth/logout', { method: 'POST', headers }));
      expect(response?.status).toBe(403);
      expect(response?.cookies).toBeUndefined();
    }
  });

  it('rejects GET (logout must not be triggerable by a link or image)', async () => {
    const response = await createAuthRoutes(testConfig())(portableRequest('/auth/logout'));
    expect(response?.status).toBe(405);
    expect(response?.headers.allow).toBe('POST');
  });
});

describe('routing', () => {
  it('returns undefined for non-auth paths and 404 for unknown auth paths', async () => {
    const routes = createAuthRoutes(testConfig());
    for (const path of ['/', '/api/portfolios', '/authx', '/authority/login', '/assets/auth/login']) {
      expect(await routes(portableRequest(path))).toBeUndefined();
    }
    expect((await routes(portableRequest('/auth')))?.status).toBe(404);
    expect((await routes(portableRequest('/auth/unknown')))?.status).toBe(404);
    expect((await routes(portableRequest('/auth/login/')))?.status).toBe(404);
  });
});

describe('Workers adapter', () => {
  it('serves the whole flow over Request/Response with separate Set-Cookie headers', async () => {
    const config = testConfig();
    const handle = createAuthFetchHandler(config);
    expect(await handle(new Request(`${ORIGIN}/api/portfolios`))).toBeUndefined();

    const login = (await handle(new Request(`${ORIGIN}/auth/login?returnTo=%2Fgoals`)))!;
    expect(login.status).toBe(302);
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;

    const callback = (await handle(new Request(`${ORIGIN}/auth/callback?code=c&state=${state}`, { headers: { cookie: stateCookie } })))!;
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/goals');
    const cookies = callback.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^pt_session=/);

    const session = (await handle(new Request(`${ORIGIN}/auth/session`, { headers: { cookie: cookies[0]!.split(';')[0]! } })))!;
    expect(await session.json()).toEqual({ authenticated: true, login: 'the-owner' });

    const logout = (await handle(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { origin: ORIGIN }, body: '{}' })))!;
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()).toEqual(['pt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
    expect((await handle(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } })))?.status).toBe(403);
  });
});
