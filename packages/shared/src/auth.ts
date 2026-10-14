/**
 * Authentication mode of the API.
 * - `cognito`: a JWT authorizer (Amazon Cognito) must have validated the request; the user id is the `sub` claim.
 * - `demo`: local development and tests only; requests without claims act as the single DEMO_USER_ID.
 * Deployed environments always run in `cognito` mode (enforced by Terraform).
 */
export const AUTH_MODES = ['cognito', 'demo'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Fails closed: an unset value means `cognito`, an unknown value throws. */
export function parseAuthMode(raw: string | undefined): AuthMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'cognito';
  const mode = AUTH_MODES.find((m) => m === value);
  if (!mode) throw new Error(`Invalid AUTH_MODE "${raw}"; expected one of: ${AUTH_MODES.join(', ')}`);
  return mode;
}
