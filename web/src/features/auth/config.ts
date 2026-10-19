import { USE_MOCKS } from '../../config';

/**
 * Build-time auth configuration.
 * - `none`: no login screen (mock/demo mode, `pnpm dev` against the local demo-mode API).
 * - `cognito`: Amazon Cognito sign-in with TOTP MFA; every route is behind the sign-in gate.
 * - `github`: personal Cloudflare deployment. The Worker serves the SPA and the API on the same origin and holds the
 *   sign-in (GitHub OAuth) in a signed HttpOnly cookie; the SPA never sees a token, it only asks `GET /auth/session`.
 * - `invalid`: an unknown mode, or VITE_AUTH_MODE=cognito without a complete pool configuration. The app refuses to
 *   start (fail closed) instead of silently rendering without a login.
 */
export type AuthConfig =
  | { mode: 'none' }
  | { mode: 'cognito'; userPoolId: string; clientId: string; region: string }
  | { mode: 'github' }
  | { mode: 'invalid'; reason: string };

export interface AuthEnv {
  VITE_AUTH_MODE?: string;
  VITE_API_BASE_URL?: string;
  VITE_COGNITO_USER_POOL_ID?: string;
  VITE_COGNITO_CLIENT_ID?: string;
  VITE_COGNITO_REGION?: string;
}

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
const invalid = (reason: string): AuthConfig => ({ mode: 'invalid', reason });
const ABSOLUTE_URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function readGithubConfig(env: AuthEnv): AuthConfig {
  // The session cookie is only sent to the page's own origin, so a cross-origin API could never authenticate.
  if (ABSOLUTE_URL_PATTERN.test(env.VITE_API_BASE_URL?.trim() ?? '')) {
    return invalid('VITE_AUTH_MODE=github needs a same-origin API: leave VITE_API_BASE_URL empty or use a path such as "/api".');
  }
  return { mode: 'github' };
}

export function readAuthConfig(env: AuthEnv, useMocks: boolean): AuthConfig {
  if (useMocks) return { mode: 'none' };
  const mode = (env.VITE_AUTH_MODE ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'none') return { mode: 'none' };
  if (mode === 'github') return readGithubConfig(env);
  if (mode !== 'cognito') return invalid(`Unknown VITE_AUTH_MODE "${env.VITE_AUTH_MODE}". Use "cognito", "github" or "none".`);

  const userPoolId = env.VITE_COGNITO_USER_POOL_ID?.trim() ?? '';
  const clientId = env.VITE_COGNITO_CLIENT_ID?.trim() ?? '';
  if (!userPoolId || !clientId) {
    return invalid('VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID are required when VITE_AUTH_MODE=cognito.');
  }
  // Pool ids look like "eu-west-1_AbCdEfGhI": the region is the part before the underscore.
  const region = env.VITE_COGNITO_REGION?.trim() || userPoolId.split('_')[0]!;
  if (!REGION_PATTERN.test(region)) return invalid(`Invalid Cognito region "${region}".`);
  return { mode: 'cognito', userPoolId, clientId, region };
}

export const AUTH_CONFIG: AuthConfig = readAuthConfig(import.meta.env, USE_MOCKS);
