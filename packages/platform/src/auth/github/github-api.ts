import type { ResolvedGithubAuthConfig } from './config.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USER_AGENT = 'portfolio-tracker-auth';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_LOGIN_LENGTH = 100;

export type GithubOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'rejected' | 'failed' };

export interface GithubUser {
  id: number;
  login: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const redirectUri = (config: ResolvedGithubAuthConfig): string => `${config.origin}/auth/callback`;

/** The authorize URL: no scope (the public `/user` endpoint is all that is needed), so no repository access is requested. */
export function authorizeUrl(config: ResolvedGithubAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri(config));
  url.searchParams.set('scope', '');
  url.searchParams.set('state', state);
  return url.toString();
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) return undefined;
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Exchanges the one-time code for an access token. The token is returned to the caller only to read `/user`, then dropped. */
export async function exchangeCode(config: ResolvedGithubAuthConfig, code: string): Promise<GithubOutcome<string>> {
  try {
    const response = await config.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri(config) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await readJson(response);
    if (!isRecord(json)) return { ok: false, reason: 'failed' };
    if (json.error === 'bad_verification_code') return { ok: false, reason: 'rejected' };
    const token = json.access_token;
    return typeof token === 'string' && token !== '' ? { ok: true, value: token } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function fetchUser(config: ResolvedGithubAuthConfig, accessToken: string): Promise<GithubOutcome<GithubUser>> {
  try {
    const response = await config.fetch(USER_URL, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await readJson(response);
    if (!isRecord(json)) return { ok: false, reason: 'failed' };
    const { id, login } = json;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof login !== 'string' || login.length > MAX_LOGIN_LENGTH) {
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, value: { id, login } };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
