import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AuthMode } from '@portfolio/shared';
import { HttpError } from './http.js';

type JwtAuthorizer = { jwt?: { claims?: Record<string, unknown> } };

/** Cognito `sub` claims are UUIDs; anything else must never end up in DynamoDB or S3 keys. */
const SAFE_USER_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface AuthConfig {
  authMode: AuthMode;
  demoUserId: string;
}

const subClaim = (event: APIGatewayProxyEventV2): unknown => {
  const authorizer = (event.requestContext as { authorizer?: JwtAuthorizer }).authorizer;
  return authorizer?.jwt?.claims?.sub;
};

const unauthenticated = () => new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');

/**
 * Resolves the caller's user id. This is the ONLY place a user id is derived; handlers receive it via the
 * route context and never read identity from the request body, query string or headers.
 *
 * - `cognito`: requires the API Gateway JWT authorizer's `sub` claim, otherwise 401 UNAUTHENTICATED.
 * - `demo`: local development and tests; the claim is honoured when present, else DEMO_USER_ID.
 */
export function resolveUserId(event: APIGatewayProxyEventV2, config: AuthConfig): string {
  const sub = subClaim(event);
  if (typeof sub === 'string' && sub.length > 0) {
    if (SAFE_USER_ID.test(sub)) return sub;
    throw unauthenticated();
  }
  if (config.authMode === 'demo') return config.demoUserId;
  throw unauthenticated();
}
