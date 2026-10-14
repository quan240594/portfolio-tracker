/**
 * Bridge between the API client and the auth layer. The client never imports React or Cognito: when auth is on,
 * AuthProvider registers these hooks; otherwise requests are sent without credentials.
 */
export interface AuthTokenHooks {
  getToken(): Promise<string | undefined>;
  onUnauthorized(): void;
}

let hooks: AuthTokenHooks | undefined;

export function setAuthTokenHooks(next: AuthTokenHooks | undefined): void {
  hooks = next;
}

export async function authorizationHeaders(): Promise<Record<string, string>> {
  const token = await hooks?.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function notifyUnauthorized(): void {
  hooks?.onUnauthorized();
}
