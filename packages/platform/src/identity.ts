/** The authenticated principal of a request, as established by the platform in front of the application. */
export interface PortableIdentity {
  /** Stable user id (the JWT `sub`). */
  subject: string;
}

/**
 * Identity port: turns the platform's raw request (API Gateway event, Worker `Request`, ...) into the principal.
 * It only reports what the platform has verified (a JWT authorizer's claims, a verified token); it returns
 * undefined for anonymous requests. The application decides what an anonymous request may do (fail closed).
 *
 * Implementations: API Gateway JWT authorizer claims (`@portfolio/aws`); a Worker verifies a JWT with `crypto.subtle`.
 */
export interface IdentityResolver<Raw> {
  identify(raw: Raw): PortableIdentity | undefined | Promise<PortableIdentity | undefined>;
}
