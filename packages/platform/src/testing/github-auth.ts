import type { PortableRequest, PortableResponse } from '../http.js';
import type { GithubAuthConfig, GithubFetch } from '../auth/github/config.js';

export const OWNER_ID = 424242;
export const ORIGIN = 'https://app.example.test';
export const SESSION_SECRET = 'test-session-secret-0123456789-abcdef';
export const CLIENT_SECRET = 'test-client-secret-value';
export const ACCESS_TOKEN = 'gho_testAccessTokenValue';
export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

export interface FakeGithub {
  fetch: GithubFetch;
  calls: { url: string; init: RequestInit | undefined }[];
  /** Overrides for the next responses. */
  tokenResponse: () => Response;
  userResponse: () => Response;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DEFAULT_USER = { id: OWNER_ID, login: 'the-owner' };

export function fakeGithub(user: { id: number; login: string } = DEFAULT_USER): FakeGithub {
  const fake: FakeGithub = {
    calls: [],
    tokenResponse: () => json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope: '' }),
    userResponse: () => json(user),
    fetch: (url, init) => {
      fake.calls.push({ url, init });
      if (url === 'https://github.com/login/oauth/access_token') return Promise.resolve(fake.tokenResponse());
      if (url === 'https://api.github.com/user') return Promise.resolve(fake.userResponse());
      return Promise.reject(new Error(`unexpected url ${url}`));
    },
  };
  return fake;
}

export function testConfig(overrides: Partial<GithubAuthConfig> & { now?: () => number } = {}): GithubAuthConfig & { fakeGithub: FakeGithub } {
  const github = fakeGithub();
  return {
    clientId: 'client-id-123',
    clientSecret: CLIENT_SECRET,
    ownerGithubId: OWNER_ID,
    sessionSecret: SESSION_SECRET,
    origin: ORIGIN,
    now: () => T0,
    fetch: github.fetch,
    ...overrides,
    fakeGithub: github,
  };
}

export function portableRequest(path: string, init: Partial<PortableRequest> = {}): PortableRequest {
  return { method: 'GET', path, query: {}, headers: {}, ...init };
}

/** Name=value pairs of the `Set-Cookie` values of a response (attributes stripped). */
export function cookieValues(response: PortableResponse): Record<string, string> {
  return Object.fromEntries((response.cookies ?? []).map((cookie) => {
    const pair = cookie.split(';')[0]!;
    const index = pair.indexOf('=');
    return [pair.slice(0, index), pair.slice(index + 1)];
  }));
}

export const cookieNamed = (response: PortableResponse, name: string): string | undefined =>
  (response.cookies ?? []).find((cookie) => cookie.startsWith(`${name}=`));
