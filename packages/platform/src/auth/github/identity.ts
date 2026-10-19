import type { IdentityResolver, PortableIdentity } from '../../identity.js';
import type { PortableRequest } from '../../http.js';
import { resolveGithubAuthConfig, type GithubAuthConfig } from './config.js';
import { createSessionCodec } from './session.js';

export type CookieCarrier = Pick<PortableRequest, 'headers'> | Request;

export function cookieHeaderOf(request: CookieCarrier): string | undefined {
  const { headers } = request;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get('cookie') ?? undefined;
  return (headers as Record<string, string | undefined>).cookie;
}

/** `{ subject: "github:<id>" }` for a valid, unexpired owner session cookie; undefined otherwise (the app fails closed). */
export function createGithubIdentityResolver(config: GithubAuthConfig): IdentityResolver<CookieCarrier> {
  const codec = createSessionCodec(resolveGithubAuthConfig(config));
  return {
    async identify(request): Promise<PortableIdentity | undefined> {
      const claims = await codec.readSession(cookieHeaderOf(request));
      return claims ? { subject: claims.sub } : undefined;
    },
  };
}
