/** Minimal `fetch` shape the sign-in flow needs (the global `fetch` in Node 20 and Workers, or a test fake). */
export type GithubFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubAuthConfig {
  /** GitHub OAuth App client id. */
  clientId: string;
  /** GitHub OAuth App client secret (a Worker secret, never in the repo). */
  clientSecret: string;
  /** The numeric GitHub user id of the one owner who may ever sign in. */
  ownerGithubId: number;
  /** HMAC key for the session and state cookies; at least 32 characters. Changing it signs everyone out. */
  sessionSecret: string;
  /** Public origin of the deployment, e.g. `https://host.example`. Must be https (http only for localhost). */
  origin: string;
  /** Session lifetime in seconds (default 7 days). */
  sessionTtlSeconds?: number;
  /** Clock in epoch milliseconds (default `Date.now`). */
  now?: () => number;
  /** Defaults to the global `fetch`. */
  fetch?: GithubFetch;
}

export interface ResolvedGithubAuthConfig {
  clientId: string;
  clientSecret: string;
  ownerGithubId: number;
  sessionSecret: string;
  origin: string;
  sessionTtlSeconds: number;
  now: () => number;
  fetch: GithubFetch;
}

export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_SESSION_SECRET_LENGTH = 32;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`GitHub auth config: ${name} is required`);
  return value;
}

function normalizeOrigin(value: unknown): string {
  const text = requireText(value, 'origin');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('GitHub auth config: origin must be an absolute URL');
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure) throw new Error('GitHub auth config: origin must use https (http is only allowed for localhost)');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('GitHub auth config: origin must not contain a path, query, fragment or credentials');
  }
  return url.origin;
}

/** Validates the configuration and fills defaults. Error messages never contain secret values. */
export function resolveGithubAuthConfig(config: GithubAuthConfig): ResolvedGithubAuthConfig {
  const sessionSecret = requireText(config.sessionSecret, 'sessionSecret');
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`GitHub auth config: sessionSecret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  if (!Number.isSafeInteger(config.ownerGithubId) || config.ownerGithubId <= 0) {
    throw new Error('GitHub auth config: ownerGithubId must be a positive integer');
  }
  const sessionTtlSeconds = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error('GitHub auth config: sessionTtlSeconds must be a positive integer');
  }
  return {
    clientId: requireText(config.clientId, 'clientId'),
    clientSecret: requireText(config.clientSecret, 'clientSecret'),
    ownerGithubId: config.ownerGithubId,
    sessionSecret,
    origin: normalizeOrigin(config.origin),
    sessionTtlSeconds,
    now: config.now ?? (() => Date.now()),
    // Wrapped: calling a detached `fetch` throws "Illegal invocation" in Workers.
    fetch: config.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  };
}
