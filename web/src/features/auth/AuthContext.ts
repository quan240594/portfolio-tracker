import { createContext, useContext } from 'react';
import type { AuthContextValue } from './types';

const unavailable = () => Promise.reject(new Error('Authentication is not enabled.'));

/** Default value (no provider, or auth off): behaves as "always signed in" so mock/demo mode needs no login. */
export const DISABLED_AUTH: AuthContextValue = {
  enabled: false,
  status: 'signedIn',
  signIn: unavailable,
  completeNewPassword: unavailable,
  verifyTotpSetup: unavailable,
  submitTotp: unavailable,
  requestPasswordReset: unavailable,
  confirmPasswordReset: unavailable,
  cancelChallenge: unavailable,
  signOut: unavailable,
  retry: () => undefined,
};

export const AuthContext = createContext<AuthContextValue>(DISABLED_AUTH);

export const useAuth = (): AuthContextValue => useContext(AuthContext);
