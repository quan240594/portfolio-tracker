import type { PortableRequest } from '@portfolio/platform';
import type { AuthMode } from '@portfolio/shared';
import { HttpError } from './http.js';

/** Cognito `sub` claims are UUIDs; anything else must never end up in storage keys. */
const SAFE_USER_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface AuthConfig {
  authMode: AuthMode;
  demoUserId: string;
}

const unauthenticated = () => new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');

/**
 * Resolves the caller's user id. This is the ONLY place a user id is derived; handlers receive it via the
 * route context and never read identity from the request body, query string or headers.
 *
 * The platform adapter reports the principal it verified (`request.identity`: the API Gateway JWT authorizer's `sub`
 * claim on AWS); this function fails closed:
 * - `cognito`: requires an identity, otherwise 401 UNAUTHENTICATED.
 * - `demo`: local development and tests; an identity is honoured when present, else DEMO_USER_ID.
 */
export function resolveUserId(request: Pick<PortableRequest, 'identity'>, config: AuthConfig): string {
  const sub = request.identity?.subject;
  if (sub) {
    if (SAFE_USER_ID.test(sub)) return sub;
    throw unauthenticated();
  }
  if (config.authMode === 'demo') return config.demoUserId;
  throw unauthenticated();
}
