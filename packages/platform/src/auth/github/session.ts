import type { ResolvedGithubAuthConfig } from './config.js';
import { createTokenSigner } from './crypto.js';
import { readCookie, SESSION_COOKIE, STATE_COOKIE } from './cookies.js';

const SESSION_PURPOSE = 'pt_session';
const STATE_PURPOSE = 'pt_oauth_state';
export const STATE_TTL_SECONDS = 10 * 60;

export interface SessionClaims {
  sub: string;
  login: string;
  iat: number;
  exp: number;
}

export interface OAuthState {
  state: string;
  returnTo: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEpochSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function parseClaims(payload: unknown): SessionClaims | undefined {
  if (!isRecord(payload)) return undefined;
  const { sub, login, iat, exp } = payload;
  if (typeof sub !== 'string' || typeof login !== 'string' || !isEpochSeconds(iat) || !isEpochSeconds(exp)) return undefined;
  return { sub, login, iat, exp };
}

function parseState(payload: unknown): (OAuthState & { exp: number }) | undefined {
  if (!isRecord(payload)) return undefined;
  const { state, returnTo, exp } = payload;
  if (typeof state !== 'string' || typeof returnTo !== 'string' || !isEpochSeconds(exp)) return undefined;
  return { state, returnTo, exp };
}

/** Stateless signed cookies: nothing is stored server side, so there is nothing to rotate or clean up. */
export function createSessionCodec(config: ResolvedGithubAuthConfig) {
  const signer = createTokenSigner(config.sessionSecret);
  const nowSeconds = () => Math.floor(config.now() / 1000);

  return {
    async issueSession(login: string): Promise<string> {
      const iat = nowSeconds();
      const claims: SessionClaims = { sub: `github:${config.ownerGithubId}`, login, iat, exp: iat + config.sessionTtlSeconds };
      return signer.sign(SESSION_PURPOSE, claims);
    },

    /** The claims of a valid, unexpired session of the owner in a `Cookie` header, else undefined. */
    async readSession(cookieHeader: string | null | undefined): Promise<SessionClaims | undefined> {
      const token = readCookie(cookieHeader, SESSION_COOKIE);
      if (!token) return undefined;
      const claims = parseClaims(await signer.verify(SESSION_PURPOSE, token));
      if (claims?.sub !== `github:${config.ownerGithubId}` || claims.exp <= nowSeconds() || claims.iat > claims.exp) return undefined;
      return claims;
    },

    async issueState(state: string, returnTo: string): Promise<string> {
      return signer.sign(STATE_PURPOSE, { state, returnTo, exp: nowSeconds() + STATE_TTL_SECONDS });
    },

    async readState(cookieHeader: string | null | undefined): Promise<OAuthState | undefined> {
      const token = readCookie(cookieHeader, STATE_COOKIE);
      if (!token) return undefined;
      const parsed = parseState(await signer.verify(STATE_PURPOSE, token));
      if (!parsed || parsed.exp <= nowSeconds()) return undefined;
      return { state: parsed.state, returnTo: parsed.returnTo };
    },
  };
}

export type SessionCodec = ReturnType<typeof createSessionCodec>;
