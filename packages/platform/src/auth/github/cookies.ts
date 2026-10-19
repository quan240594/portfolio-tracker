export const SESSION_COOKIE = 'pt_session';
export const STATE_COOKIE = 'pt_oauth_state';

export interface CookieOptions {
  path: string;
  maxAgeSeconds: number;
}

/** Cookie values here are base64url tokens, so they need no escaping. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${options.path}; Max-Age=${options.maxAgeSeconds}`;
}

export const clearCookie = (name: string, path: string): string => serializeCookie(name, '', { path, maxAgeSeconds: 0 });

/** The first value of cookie `name` in a `Cookie` request header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
