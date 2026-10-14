import type { ICognitoStorage } from 'amazon-cognito-identity-js';

const PREFIX = 'CognitoIdentityServiceProvider.';
/** Only the refresh token and the "last user" pointer survive a reload; ID/access tokens live in memory. */
const PERSISTED = /\.(refreshToken|LastAuthUser)$/;

/**
 * Token storage for amazon-cognito-identity-js.
 *
 * Trade-off: the 30-day refresh token is kept in localStorage so a reload (or a new tab) does not force a new
 * password + TOTP sign-in; the short-lived ID/access tokens stay in memory only. localStorage is readable by any
 * script on the origin, which is why the CloudFront CSP forbids third-party scripts (`script-src 'self'`), and
 * sign-out revokes the refresh token server-side. sessionStorage would shrink the exposure but would require a
 * full MFA sign-in in every tab, which is impractical for a daily-use personal app.
 */
export class RefreshTokenStorage implements ICognitoStorage {
  private readonly memory = new Map<string, string>();

  constructor(private readonly persistent: Storage = globalThis.localStorage) {}

  setItem(key: string, value: string): void {
    if (PERSISTED.test(key)) this.persistent.setItem(key, value);
    else this.memory.set(key, value);
  }

  getItem(key: string): string | null {
    if (PERSISTED.test(key)) return this.persistent.getItem(key);
    return this.memory.get(key) ?? null;
  }

  removeItem(key: string): void {
    if (PERSISTED.test(key)) this.persistent.removeItem(key);
    else this.memory.delete(key);
  }

  clear(): void {
    this.memory.clear();
    const stale: string[] = [];
    for (let i = 0; i < this.persistent.length; i++) {
      const key = this.persistent.key(i);
      if (key?.startsWith(PREFIX)) stale.push(key);
    }
    for (const key of stale) this.persistent.removeItem(key);
  }
}
