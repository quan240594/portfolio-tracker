/**
 * Client of the Worker's same-origin session endpoints (GitHub mode). The session itself is a signed HttpOnly cookie
 * that scripts cannot read, so the SPA only ever learns "who is signed in" from `GET /auth/session`.
 */
export interface GithubSessionService {
  /** The signed-in GitHub login, or null when there is no valid session. Rejects when the check itself fails. */
  fetchSession(signal?: AbortSignal): Promise<string | null>;
  /** Ends the session on the server. Rejects when the server could not be reached or refused. */
  logout(): Promise<void>;
}

export const SESSION_PATH = '/auth/session';
export const LOGIN_PATH = '/auth/login';
export const LOGOUT_PATH = '/auth/logout';

export const SESSION_CHECK_FAILED = 'Could not check your sign-in. Check your connection and try again.';
export const SIGN_OUT_FAILED = 'Could not sign out. Check your connection and try again.';

/**
 * A same-origin path to come back to after signing in. Anything that is not a plain absolute path (a full URL, a
 * protocol-relative `//host`, backslashes, control characters) or that points into the auth endpoints falls back to "/".
 */
export function safeReturnTo(path: string): string {
  const isPlainPath = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !hasControlCharacter(path);
  return isPlainPath && !isAuthPath(path) ? path : '/';
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isAuthPath(path: string): boolean {
  return path === '/auth' || path.startsWith('/auth/') || path.startsWith('/auth?') || path.startsWith('/auth#');
}

/** Target of the "Sign in with GitHub" link: a full-page navigation, never a fetch. */
export const loginUrl = (returnTo: string): string => `${LOGIN_PATH}?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;

function parseSession(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) throw new Error(SESSION_CHECK_FAILED);
  const { authenticated, login } = body as { authenticated?: unknown; login?: unknown };
  if (authenticated === false) return null;
  if (authenticated === true && typeof login === 'string' && login !== '') return login;
  throw new Error(SESSION_CHECK_FAILED);
}

export const githubSessionService: GithubSessionService = {
  async fetchSession(signal) {
    let res: Response;
    try {
      res = await fetch(SESSION_PATH, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new Error(SESSION_CHECK_FAILED);
    }
    if (!res.ok) throw new Error(SESSION_CHECK_FAILED);
    return parseSession(await res.json().catch(() => undefined));
  },

  async logout() {
    let res: Response;
    try {
      res = await fetch(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' });
    } catch {
      throw new Error(SIGN_OUT_FAILED);
    }
    // 401: the session is already gone, which is what the user asked for.
    if (!res.ok && res.status !== 401) throw new Error(SIGN_OUT_FAILED);
  },
};
