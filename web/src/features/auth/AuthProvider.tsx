import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { AuthContext, DISABLED_AUTH } from './AuthContext';
import { SESSION_EXPIRED_NOTICE } from './errors';
import { GithubAuthProvider } from './GithubAuthProvider';
import type { GithubSessionService } from './githubSession';
import { setAuthTokenHooks } from './tokenHooks';
import type { AuthActions, AuthContextValue, AuthService, AuthState, SignInStep } from './types';

type CognitoConfig = Extract<AuthConfig, { mode: 'cognito' }>;
export type LoadAuthService = (config: CognitoConfig) => Promise<AuthService>;

/** Cognito (and its SRP maths) is only downloaded when auth is on, so the mock/Pages build stays lean. */
const defaultLoadService: LoadAuthService = async (config) => (await import('./cognitoService')).createCognitoService(config);

const SIGNED_OUT: AuthState = { status: 'signedOut' };

function stateForStep(step: SignInStep, email: string): AuthState {
  switch (step.step) {
    case 'signedIn':
      return { status: 'signedIn', email: step.email || email };
    case 'newPassword':
      return { status: 'signedOut', email, challenge: { kind: 'newPassword' } };
    case 'totpSetup':
      return { status: 'signedOut', email, challenge: { kind: 'totpSetup', secret: step.secret } };
    case 'totp':
      return { status: 'signedOut', email, challenge: { kind: 'totp' } };
  }
}

export function AuthProvider({
  config = AUTH_CONFIG,
  loadService = defaultLoadService,
  githubSession,
  children,
}: Readonly<{ config?: AuthConfig; loadService?: LoadAuthService; githubSession?: GithubSessionService; children: ReactNode }>) {
  if (config.mode === 'github') return <GithubAuthProvider session={githubSession}>{children}</GithubAuthProvider>;
  if (config.mode === 'none') return <AuthContext.Provider value={DISABLED_AUTH}>{children}</AuthContext.Provider>;
  if (config.mode === 'invalid') return <InvalidConfigAuthProvider reason={config.reason}>{children}</InvalidConfigAuthProvider>;
  return (
    <CognitoAuthProvider config={config} loadService={loadService}>
      {children}
    </CognitoAuthProvider>
  );
}

function InvalidConfigAuthProvider({ reason, children }: Readonly<{ reason: string; children: ReactNode }>) {
  const broken = useMemo<AuthContextValue>(
    () => ({ ...DISABLED_AUTH, enabled: true, status: 'signedOut', configError: reason }),
    [reason],
  );
  return <AuthContext.Provider value={broken}>{children}</AuthContext.Provider>;
}

function CognitoAuthProvider({
  config,
  loadService,
  children,
}: Readonly<{ config: CognitoConfig; loadService: LoadAuthService; children: ReactNode }>) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const servicePromise = useRef<Promise<AuthService>>();
  servicePromise.current ??= loadService(config);
  const signedIn = useRef(false);
  const emailRef = useRef('');

  const withService = useCallback(<T,>(run: (service: AuthService) => Promise<T>): Promise<T> => servicePromise.current!.then(run), []);

  const applyState = useCallback(
    (next: AuthState) => {
      const wasSignedIn = signedIn.current;
      signedIn.current = next.status === 'signedIn';
      setState(next);
      // Never leave one user's cached API data around for the next sign-in.
      if (wasSignedIn && !signedIn.current) queryClient.clear();
    },
    [queryClient],
  );

  // Silent session restore from the refresh token.
  useEffect(() => {
    let active = true;
    withService((s) => s.restoreSession()).then(
      (email) => active && applyState(email ? { status: 'signedIn', email } : SIGNED_OUT),
      () => active && applyState(SIGNED_OUT),
    );
    return () => {
      active = false;
    };
  }, [withService, applyState]);

  const expireSession = useCallback(() => {
    if (!signedIn.current) return;
    withService((s) => s.signOut()).catch(() => undefined);
    applyState({ status: 'signedOut', notice: SESSION_EXPIRED_NOTICE });
  }, [withService, applyState]);

  // API client: attach the ID token (refreshing silently) and sign out when the API answers 401.
  useEffect(() => {
    setAuthTokenHooks({ getToken: () => withService((s) => s.getIdToken()), onUnauthorized: expireSession });
    return () => setAuthTokenHooks(undefined);
  }, [withService, expireSession]);

  const actions = useMemo<AuthActions>(() => {
    const advance = (next: SignInStep) => applyState(stateForStep(next, emailRef.current));
    const signOut = async () => {
      await withService((s) => s.signOut()).catch(() => undefined);
      applyState(SIGNED_OUT);
    };
    return {
      signIn: async (email, password) => {
        emailRef.current = email.trim();
        advance(await withService((s) => s.signIn(email, password)));
      },
      completeNewPassword: async (newPassword) => advance(await withService((s) => s.completeNewPassword(newPassword))),
      verifyTotpSetup: async (code) => advance(await withService((s) => s.verifyTotpSetup(code))),
      submitTotp: async (code) => advance(await withService((s) => s.submitTotp(code))),
      requestPasswordReset: (email) => withService((s) => s.requestPasswordReset(email.trim())),
      confirmPasswordReset: (email, code, password) => withService((s) => s.confirmPasswordReset(email.trim(), code, password)),
      cancelChallenge: signOut,
      signOut,
    };
  }, [withService, applyState]);

  const value = useMemo<AuthContextValue>(() => ({ ...state, ...actions, enabled: true, provider: 'cognito', retry: () => undefined }), [state, actions]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
