import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AuthContext, DISABLED_AUTH } from './AuthContext';
import { SESSION_EXPIRED_NOTICE } from './errors';
import { githubSessionService, type GithubSessionService } from './githubSession';
import { setAuthTokenHooks } from './tokenHooks';
import type { AuthContextValue, AuthState } from './types';

const SIGNED_OUT: AuthState = { status: 'signedOut' };
const unavailable = () => Promise.reject(new Error('Password sign-in is not used in this build.'));
// The API is authenticated by the cookie alone: no token is ever attached.
const NO_TOKEN = () => Promise.resolve(undefined);

/**
 * GitHub mode: the Worker owns the sign-in. The provider asks `GET /auth/session` once on load (and again on retry),
 * and turns an API 401 into the signed-out state. It exposes the same context as the Cognito provider.
 */
export function GithubAuthProvider({
  session = githubSessionService,
  children,
}: Readonly<{ session?: GithubSessionService; children: ReactNode }>) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const signedIn = useRef(false);

  const applyState = useCallback(
    (next: AuthState) => {
      const wasSignedIn = signedIn.current;
      signedIn.current = next.status === 'signedIn';
      setState(next);
      // Never leave the owner's cached API data around once the session is gone.
      if (wasSignedIn && !signedIn.current) queryClient.clear();
    },
    [queryClient],
  );

  useEffect(() => {
    const controller = new AbortController();
    session.fetchSession(controller.signal).then(
      (login) => applyState(login ? { status: 'signedIn', login } : SIGNED_OUT),
      () => {
        if (!controller.signal.aborted) applyState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [session, applyState, attempt]);

  const expireSession = useCallback(() => {
    if (signedIn.current) applyState({ status: 'signedOut', notice: SESSION_EXPIRED_NOTICE });
  }, [applyState]);

  useEffect(() => {
    setAuthTokenHooks({ getToken: NO_TOKEN, onUnauthorized: expireSession });
    return () => setAuthTokenHooks(undefined);
  }, [expireSession]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const signOut = useCallback(async () => {
    await session.logout();
    applyState(SIGNED_OUT);
  }, [session, applyState]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...DISABLED_AUTH,
      ...state,
      enabled: true,
      provider: 'github',
      signIn: unavailable,
      completeNewPassword: unavailable,
      verifyTotpSetup: unavailable,
      submitTotp: unavailable,
      cancelChallenge: unavailable,
      signOut,
      retry,
    }),
    [state, signOut, retry],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
