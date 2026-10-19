import type { PortableRequest, PortableResponse } from '../../http.js';
import { resolveGithubAuthConfig, type GithubAuthConfig, type ResolvedGithubAuthConfig } from './config.js';
import { clearCookie, serializeCookie, SESSION_COOKIE, STATE_COOKIE } from './cookies.js';
import { constantTimeEqual, randomToken } from './crypto.js';
import { portableToFetchResponse, fetchRequestToPortable } from './fetch-adapter.js';
import { authorizeUrl, exchangeCode, fetchUser } from './github-api.js';
import { sanitizeReturnTo } from './return-to.js';
import { requireSameOrigin } from './same-origin.js';
import { createSessionCodec, STATE_TTL_SECONDS, type SessionCodec } from './session.js';

export type AuthRoutes = (request: PortableRequest) => Promise<PortableResponse | undefined>;

const NO_STORE = 'no-store';
const clearState = () => clearCookie(STATE_COOKIE, '/auth');

function text(status: number, body: string, cookies: string[] = [], extra: Record<string, string> = {}): PortableResponse {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE, ...extra };
  return cookies.length > 0 ? { status, headers, body, cookies } : { status, headers, body };
}

const methodNotAllowed = (allow: string) => text(405, 'Method not allowed', [], { allow });

/** Same neutral page for any non-owner: it never says who the owner is. */
const forbidden = () => text(403, 'Access denied. This app is private.', [clearState()]);
const badRequest = () => text(400, 'Sign-in could not be completed. Please start again.', [clearState()]);
const badGateway = () => text(502, 'Sign-in with GitHub is unavailable right now. Please try again later.', [clearState()]);

async function login(config: ResolvedGithubAuthConfig, codec: SessionCodec, request: PortableRequest): Promise<PortableResponse> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const state = randomToken();
  const returnTo = sanitizeReturnTo(request.query.returnTo);
  const cookie = serializeCookie(STATE_COOKIE, await codec.issueState(state, returnTo), { path: '/auth', maxAgeSeconds: STATE_TTL_SECONDS });
  return { status: 302, headers: { location: authorizeUrl(config, state), 'cache-control': NO_STORE }, body: '', cookies: [cookie] };
}

async function callback(config: ResolvedGithubAuthConfig, codec: SessionCodec, request: PortableRequest): Promise<PortableResponse> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const saved = await codec.readState(request.headers.cookie);
  const { code, state } = request.query;
  if (!saved || !state || !code || !constantTimeEqual(saved.state, state)) return badRequest();

  const token = await exchangeCode(config, code);
  if (!token.ok) return token.reason === 'rejected' ? badRequest() : badGateway();
  const user = await fetchUser(config, token.value);
  if (!user.ok) return badGateway();
  if (user.value.id !== config.ownerGithubId) return forbidden();

  const session = serializeCookie(SESSION_COOKIE, await codec.issueSession(user.value.login), { path: '/', maxAgeSeconds: config.sessionTtlSeconds });
  const returnTo = sanitizeReturnTo(saved.returnTo);
  return { status: 302, headers: { location: returnTo, 'cache-control': NO_STORE }, body: '', cookies: [session, clearState()] };
}

async function session(codec: SessionCodec, request: PortableRequest): Promise<PortableResponse> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const claims = await codec.readSession(request.headers.cookie);
  const body = claims ? { authenticated: true, login: claims.login } : { authenticated: false };
  return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE }, body: JSON.stringify(body) };
}

function logout(config: ResolvedGithubAuthConfig, request: PortableRequest): PortableResponse {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const rejected = requireSameOrigin(request, config.origin);
  if (rejected) return rejected;
  return { status: 204, headers: { 'cache-control': NO_STORE }, body: '', cookies: [clearCookie(SESSION_COOKIE, '/')] };
}

/**
 * `/auth/login`, `/auth/callback`, `/auth/session` and `/auth/logout`. Returns undefined for any other path so the caller
 * can route on. Only the one configured GitHub user id can ever obtain a session.
 */
export function createAuthRoutes(input: GithubAuthConfig): AuthRoutes {
  const config = resolveGithubAuthConfig(input);
  const codec = createSessionCodec(config);

  return async (request) => {
    if (request.path !== '/auth' && !request.path.startsWith('/auth/')) return undefined;
    switch (request.path) {
      case '/auth/login':
        return login(config, codec, request);
      case '/auth/callback':
        return callback(config, codec, request);
      case '/auth/session':
        return session(codec, request);
      case '/auth/logout':
        return logout(config, request);
      default:
        return text(404, 'Not found');
    }
  };
}

/** Workers adapter: the same routes over a Fetch `Request`/`Response`; undefined for non-/auth paths. */
export function createAuthFetchHandler(input: GithubAuthConfig): (request: Request) => Promise<Response | undefined> {
  const routes = createAuthRoutes(input);
  return async (request) => {
    const response = await routes(await fetchRequestToPortable(request));
    return response ? portableToFetchResponse(response) : undefined;
  };
}
