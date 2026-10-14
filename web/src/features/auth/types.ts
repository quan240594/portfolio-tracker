/** Result of a sign-in step: either signed in, or the next challenge Cognito asks for. */
export type SignInStep =
  | { step: 'signedIn'; email: string }
  | { step: 'newPassword' }
  | { step: 'totpSetup'; secret: string }
  | { step: 'totp' };

/** Promise-based facade over Cognito (the only module that talks to amazon-cognito-identity-js). */
export interface AuthService {
  /** Restores a session from the stored refresh token. Resolves with the user's email, or null when signed out. */
  restoreSession(): Promise<string | null>;
  signIn(email: string, password: string): Promise<SignInStep>;
  completeNewPassword(newPassword: string): Promise<SignInStep>;
  verifyTotpSetup(code: string): Promise<SignInStep>;
  submitTotp(code: string): Promise<SignInStep>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void>;
  /** ID token for the API; refreshes silently when expired. Undefined when there is no valid session. */
  getIdToken(): Promise<string | undefined>;
  /** Revokes the refresh token (best effort) and clears every stored token. */
  signOut(): Promise<void>;
}

export type AuthChallenge =
  | { kind: 'newPassword' }
  | { kind: 'totpSetup'; secret: string }
  | { kind: 'totp' };

export interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  /** Signed-in user, or the user in the middle of a sign-in challenge. */
  email?: string;
  challenge?: AuthChallenge;
  /** Shown on the sign-in screen, e.g. after the session expired. */
  notice?: string;
}

export interface AuthActions {
  signIn(email: string, password: string): Promise<void>;
  completeNewPassword(newPassword: string): Promise<void>;
  verifyTotpSetup(code: string): Promise<void>;
  submitTotp(code: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void>;
  /** Abandons the current challenge and returns to the sign-in form. */
  cancelChallenge(): Promise<void>;
  signOut(): Promise<void>;
}

export interface AuthContextValue extends AuthState, AuthActions {
  /** False in mock/demo mode: no login, `status` is always `signedIn`. */
  enabled: boolean;
  /** Set when the build-time auth configuration is unusable. */
  configError?: string;
}
