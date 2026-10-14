import {
  AuthenticationDetails,
  CognitoRefreshToken,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type IAuthenticationCallback,
  type ICognitoStorage,
} from 'amazon-cognito-identity-js';
import { RefreshTokenStorage } from './refreshStorage';
import type { AuthService, SignInStep } from './types';

export interface CognitoServiceConfig {
  userPoolId: string;
  clientId: string;
}

type Resolve = (step: SignInStep) => void;
type Reject = (reason: unknown) => void;

const expiredChallenge = () =>
  Object.assign(new Error('Your sign-in session expired. Go back and sign in again.'), { code: 'ExpiredChallenge' });
const unsupportedMfa = () => new Error('This account requires an unsupported MFA method. Only authenticator apps (TOTP) are supported.');

const emailOf = (session: CognitoUserSession): string => String(session.getIdToken().decodePayload().email ?? '');

/** The SDK normally hands over Errors; anything else is wrapped so callers always get one (keeping its `code`/`message`). */
const toError = (reason: unknown): Error => {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'object' && reason !== null) {
    const { message } = reason as { message?: unknown };
    return Object.assign(new Error(typeof message === 'string' ? message : 'Authentication request failed.'), reason);
  }
  return new Error(typeof reason === 'string' && reason ? reason : 'Authentication request failed.');
};

/** Adapts a Node-style callback API to a promise. */
const promisify = <T>(run: (done: (err: unknown, value?: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    run((err, value) => (err ? reject(toError(err)) : resolve(value as T)));
  });

export function createCognitoService(
  config: CognitoServiceConfig,
  storage: ICognitoStorage = new RefreshTokenStorage(),
): AuthService {
  const pool = new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.clientId, Storage: storage });
  const keyPrefix = `CognitoIdentityServiceProvider.${config.clientId}`;
  /** The user in the middle of a challenge (new password / TOTP). */
  let pending: CognitoUser | undefined;
  let inflight: Promise<CognitoUserSession | null> | undefined;

  const newUser = (email: string) => new CognitoUser({ Username: email.trim(), Pool: pool, Storage: storage });

  const withPending = <T>(run: (user: CognitoUser) => Promise<T>): Promise<T> =>
    pending ? run(pending) : Promise.reject(expiredChallenge());

  const startTotpSetup = (user: CognitoUser, resolve: Resolve, reject: Reject) =>
    user.associateSoftwareToken({
      associateSecretCode: (secret) => resolve({ step: 'totpSetup', secret }),
      onFailure: reject,
    });

  const signedInCallbacks = (resolve: Resolve, reject: Reject) => ({
    onSuccess: (session: CognitoUserSession) => {
      pending = undefined;
      resolve({ step: 'signedIn', email: emailOf(session) });
    },
    onFailure: reject,
  });

  const challengeCallbacks = (user: CognitoUser, resolve: Resolve, reject: Reject): IAuthenticationCallback => ({
    ...signedInCallbacks(resolve, reject),
    newPasswordRequired: () => resolve({ step: 'newPassword' }),
    totpRequired: () => resolve({ step: 'totp' }),
    mfaSetup: () => startTotpSetup(user, resolve, reject),
    mfaRequired: () => reject(unsupportedMfa()),
    selectMFAType: () => reject(unsupportedMfa()),
  });

  const finishWithSession = (user: CognitoUser, run: (callbacks: IAuthenticationCallback) => void) =>
    new Promise<SignInStep>((resolve, reject) => {
      pending = user;
      run(challengeCallbacks(user, resolve, reject));
    });

  const getSession = (user: CognitoUser) => promisify<CognitoUserSession>((done) => user.getSession(done));

  const refreshSession = (user: CognitoUser, token: string) =>
    promisify<CognitoUserSession>((done) => user.refreshSession(new CognitoRefreshToken({ RefreshToken: token }), done));

  /** ID/access tokens are memory-only, so after a reload the session is rebuilt from the stored refresh token. */
  const loadSession = async (): Promise<CognitoUserSession | null> => {
    const user = pool.getCurrentUser();
    if (!user) return null;
    const prefix = `${keyPrefix}.${user.getUsername()}`;
    try {
      if (storage.getItem(`${prefix}.idToken`)) return await getSession(user);
      const refreshToken = storage.getItem(`${prefix}.refreshToken`);
      return refreshToken ? await refreshSession(user, refreshToken) : null;
    } catch (err) {
      if ((err as { code?: string }).code !== 'NotAuthorizedException') throw err;
      user.signOut(); // revoked or expired refresh token: forget it
      return null;
    }
  };

  /** Concurrent callers (parallel API requests) share one refresh. */
  const currentSession = (): Promise<CognitoUserSession | null> => {
    inflight ??= loadSession().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return {
    async restoreSession() {
      const session = await currentSession();
      return session ? emailOf(session) : null;
    },

    signIn(email, password) {
      const details = new AuthenticationDetails({ Username: email.trim(), Password: password });
      const user = newUser(email);
      return finishWithSession(user, (callbacks) => user.authenticateUser(details, callbacks));
    },

    completeNewPassword(newPassword) {
      return withPending((user) =>
        finishWithSession(user, (callbacks) => user.completeNewPasswordChallenge(newPassword, {}, callbacks)),
      );
    },

    verifyTotpSetup(code) {
      return withPending(
        (user) =>
          new Promise<SignInStep>((resolve, reject) => {
            user.verifySoftwareToken(code, 'Authenticator app', signedInCallbacks(resolve, reject));
          }),
      );
    },

    submitTotp(code) {
      return withPending(
        (user) =>
          new Promise<SignInStep>((resolve, reject) => {
            user.sendMFACode(code, signedInCallbacks(resolve, reject), 'SOFTWARE_TOKEN_MFA');
          }),
      );
    },

    requestPasswordReset(email) {
      return new Promise<void>((resolve, reject) => {
        newUser(email).forgotPassword({
          onSuccess: () => resolve(),
          inputVerificationCode: () => resolve(),
          onFailure: reject,
        });
      });
    },

    confirmPasswordReset(email, code, newPassword) {
      return new Promise<void>((resolve, reject) => {
        newUser(email).confirmPassword(code, newPassword, { onSuccess: () => resolve(), onFailure: reject });
      });
    },

    async getIdToken() {
      const session = await currentSession();
      return session?.getIdToken().getJwtToken();
    },

    async signOut() {
      const user = pending ?? pool.getCurrentUser();
      pending = undefined;
      if (!user) return;
      // Revoking needs a valid session and the network; failing to revoke must never block signing out locally.
      await new Promise<void>((resolve) => {
        user.signOut(() => resolve());
      });
      user.signOut();
    },
  };
}
