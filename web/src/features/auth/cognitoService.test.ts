import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCognitoService } from './cognitoService';
import { RefreshTokenStorage } from './refreshStorage';

type Cb = Record<string, (...args: unknown[]) => void>;

// Scripts the mocked amazon-cognito-identity-js: each test decides how the SDK answers.
const sdk = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  completeNewPasswordChallenge: vi.fn(),
  associateSoftwareToken: vi.fn(),
  verifySoftwareToken: vi.fn(),
  sendMFACode: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
  forgotPassword: vi.fn(),
  confirmPassword: vi.fn(),
}));

vi.mock('amazon-cognito-identity-js', () => {
  type Storage = { getItem(k: string): string | null };
  class CognitoUserPool {
    constructor(readonly data: { ClientId: string; Storage: Storage }) {}
    getCurrentUser() {
      const name = this.data.Storage.getItem(`CognitoIdentityServiceProvider.${this.data.ClientId}.LastAuthUser`);
      return name ? new CognitoUser({ Username: name, Pool: this, Storage: this.data.Storage }) : null;
    }
  }
  class CognitoUser {
    constructor(readonly data: { Username: string; Pool?: unknown; Storage?: unknown }) {}
    getUsername() {
      return this.data.Username;
    }
    authenticateUser = sdk.authenticateUser;
    completeNewPasswordChallenge = sdk.completeNewPasswordChallenge;
    associateSoftwareToken = sdk.associateSoftwareToken;
    verifySoftwareToken = sdk.verifySoftwareToken;
    sendMFACode = sdk.sendMFACode;
    getSession = sdk.getSession;
    refreshSession = sdk.refreshSession;
    signOut = sdk.signOut;
    forgotPassword = sdk.forgotPassword;
    confirmPassword = sdk.confirmPassword;
  }
  class AuthenticationDetails {
    constructor(readonly data: { Username: string; Password: string }) {}
  }
  class CognitoRefreshToken {
    constructor(readonly data: { RefreshToken: string }) {}
  }
  return { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoRefreshToken };
});

const session = (email = 'me@example.com') => ({
  getIdToken: () => ({ decodePayload: () => ({ email }), getJwtToken: () => `jwt-${email}` }),
});

const CLIENT = 'client-1';
const KEY = `CognitoIdentityServiceProvider.${CLIENT}`;

function setup() {
  const memory = new Map<string, string>();
  const storage = new RefreshTokenStorage({
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
  } as Storage);
  const service = createCognitoService({ userPoolId: 'eu-west-1_Pool', clientId: CLIENT }, storage);
  return { service, storage, memory };
}

/** Makes `fn` answer by calling the given callback name of its last (or indexed) argument. */
const answer = (fn: ReturnType<typeof vi.fn>, name: string, ...args: unknown[]) =>
  fn.mockImplementation((...a: unknown[]) => {
    const callbacks = a.find((x) => x && typeof x === 'object' && name in (x as object)) as Cb;
    callbacks[name]!(...args);
  });

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
});

describe('sign-in challenges', () => {
  it('signs in directly when no challenge is required', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'onSuccess', session());
    await expect(service.signIn(' me@example.com ', 'pw')).resolves.toEqual({ step: 'signedIn', email: 'me@example.com' });
    expect(sdk.authenticateUser.mock.calls[0]![0].data).toEqual({ Username: 'me@example.com', Password: 'pw' });
  });

  it('falls back to an empty email when the token has none', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'onSuccess', { getIdToken: () => ({ decodePayload: () => ({}) }) });
    await expect(service.signIn('x@y.z', 'pw')).resolves.toEqual({ step: 'signedIn', email: '' });
  });

  it('rejects with the SDK error on failure', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'onFailure', Object.assign(new Error('nope'), { code: 'NotAuthorizedException' }));
    await expect(service.signIn('a@b.c', 'bad')).rejects.toMatchObject({ code: 'NotAuthorizedException' });
  });

  it('first login: new password → TOTP setup (associate secret) → verify → signed in', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'newPasswordRequired', {}, {});
    await expect(service.signIn('a@b.c', 'temp')).resolves.toEqual({ step: 'newPassword' });

    answer(sdk.completeNewPasswordChallenge, 'mfaSetup', 'MFA_SETUP', {});
    answer(sdk.associateSoftwareToken, 'associateSecretCode', 'SECRET123');
    await expect(service.completeNewPassword('N3w-Password!')).resolves.toEqual({ step: 'totpSetup', secret: 'SECRET123' });
    expect(sdk.completeNewPasswordChallenge.mock.calls[0]!.slice(0, 2)).toEqual(['N3w-Password!', {}]);

    answer(sdk.verifySoftwareToken, 'onSuccess', session());
    await expect(service.verifyTotpSetup('123456')).resolves.toEqual({ step: 'signedIn', email: 'me@example.com' });
    expect(sdk.verifySoftwareToken.mock.calls[0]!.slice(0, 2)).toEqual(['123456', 'Authenticator app']);
  });

  it('reports a failure to start TOTP enrolment and a wrong enrolment code', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'mfaSetup', 'MFA_SETUP', {});
    answer(sdk.associateSoftwareToken, 'onFailure', new Error('assoc'));
    await expect(service.signIn('a@b.c', 'pw')).rejects.toThrow('assoc');

    answer(sdk.authenticateUser, 'mfaSetup', 'MFA_SETUP', {});
    answer(sdk.associateSoftwareToken, 'associateSecretCode', 'S');
    await service.signIn('a@b.c', 'pw');
    answer(sdk.verifySoftwareToken, 'onFailure', Object.assign(new Error('bad'), { code: 'EnableSoftwareTokenMFAException' }));
    await expect(service.verifyTotpSetup('000000')).rejects.toMatchObject({ code: 'EnableSoftwareTokenMFAException' });
  });

  it('later logins: TOTP required → code accepted (SOFTWARE_TOKEN_MFA) or rejected', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'totpRequired', 'SOFTWARE_TOKEN_MFA', {});
    await expect(service.signIn('a@b.c', 'pw')).resolves.toEqual({ step: 'totp' });

    answer(sdk.sendMFACode, 'onFailure', Object.assign(new Error('x'), { code: 'CodeMismatchException' }));
    await expect(service.submitTotp('111111')).rejects.toMatchObject({ code: 'CodeMismatchException' });

    answer(sdk.sendMFACode, 'onSuccess', session());
    await expect(service.submitTotp('222222')).resolves.toEqual({ step: 'signedIn', email: 'me@example.com' });
    expect(sdk.sendMFACode.mock.calls[1]![2]).toBe('SOFTWARE_TOKEN_MFA');
  });

  it('refuses SMS / MFA-type selection challenges (TOTP only)', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'mfaRequired', 'SMS_MFA', {});
    await expect(service.signIn('a@b.c', 'pw')).rejects.toThrow(/unsupported MFA/);
    answer(sdk.authenticateUser, 'selectMFAType', 'SELECT_MFA_TYPE', {});
    await expect(service.signIn('a@b.c', 'pw')).rejects.toThrow(/unsupported MFA/);
  });

  it('answers challenge steps without a pending sign-in with an expired-challenge error', async () => {
    const { service } = setup();
    for (const run of [() => service.completeNewPassword('x'), () => service.verifyTotpSetup('1'), () => service.submitTotp('1')]) {
      await expect(run()).rejects.toMatchObject({ code: 'ExpiredChallenge' });
    }
  });

  it('forgets the pending challenge once signed in', async () => {
    const { service } = setup();
    answer(sdk.authenticateUser, 'onSuccess', session());
    await service.signIn('a@b.c', 'pw');
    await expect(service.submitTotp('123456')).rejects.toMatchObject({ code: 'ExpiredChallenge' });
  });
});

describe('session restore and silent refresh', () => {
  it('is signed out without a stored user or without a refresh token', async () => {
    const { service, memory } = setup();
    await expect(service.restoreSession()).resolves.toBeNull();
    memory.set(`${KEY}.LastAuthUser`, 'me');
    await expect(service.restoreSession()).resolves.toBeNull();
    expect(sdk.getSession).not.toHaveBeenCalled();
  });

  it('rebuilds the session from the refresh token after a reload (ID token only lived in memory)', async () => {
    const { service, memory } = setup();
    memory.set(`${KEY}.LastAuthUser`, 'me');
    memory.set(`${KEY}.me.refreshToken`, 'refresh-1');
    sdk.refreshSession.mockImplementation((_token, done: (e: unknown, s?: unknown) => void) => done(null, session()));
    await expect(service.restoreSession()).resolves.toBe('me@example.com');
    expect(sdk.refreshSession.mock.calls[0]![0].data).toEqual({ RefreshToken: 'refresh-1' });
  });

  it('uses getSession (cached or refreshed by the SDK) while tokens are in memory', async () => {
    const { service, storage, memory } = setup();
    storage.setItem(`${KEY}.LastAuthUser`, 'me');
    storage.setItem(`${KEY}.me.idToken`, 'in-memory');
    sdk.getSession.mockImplementation((done: (e: unknown, s?: unknown) => void) => done(null, session()));
    await expect(service.getIdToken()).resolves.toBe('jwt-me@example.com');
    expect(memory.has(`${KEY}.me.idToken`)).toBe(false); // ID tokens never reach localStorage
    expect(memory.get(`${KEY}.LastAuthUser`)).toBe('me');
  });

  it('shares one refresh between concurrent callers and refreshes again later', async () => {
    const { service, memory } = setup();
    memory.set(`${KEY}.LastAuthUser`, 'me');
    memory.set(`${KEY}.me.refreshToken`, 'r');
    sdk.refreshSession.mockImplementation((_t, done: (e: unknown, s?: unknown) => void) => queueMicrotask(() => done(null, session())));
    const tokens = await Promise.all([service.getIdToken(), service.getIdToken(), service.getIdToken()]);
    expect(tokens).toEqual(['jwt-me@example.com', 'jwt-me@example.com', 'jwt-me@example.com']);
    expect(sdk.refreshSession).toHaveBeenCalledTimes(1);
    await service.getIdToken();
    expect(sdk.refreshSession).toHaveBeenCalledTimes(2);
  });

  it('returns no token when signed out', async () => {
    const { service } = setup();
    await expect(service.getIdToken()).resolves.toBeUndefined();
  });

  it('drops a revoked/expired refresh token (NotAuthorized) but keeps it on network errors', async () => {
    const { service, memory } = setup();
    memory.set(`${KEY}.LastAuthUser`, 'me');
    memory.set(`${KEY}.me.refreshToken`, 'r');
    sdk.refreshSession.mockImplementation((_t, done: (e: unknown) => void) => done(Object.assign(new Error('revoked'), { code: 'NotAuthorizedException' })));
    await expect(service.restoreSession()).resolves.toBeNull();
    expect(sdk.signOut).toHaveBeenCalledTimes(1);

    sdk.signOut.mockReset();
    sdk.refreshSession.mockImplementation((_t, done: (e: unknown) => void) => done(Object.assign(new Error('offline'), { code: 'NetworkError' })));
    await expect(service.restoreSession()).rejects.toMatchObject({ code: 'NetworkError' });
    expect(sdk.signOut).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  it('revokes the session, then clears local data even when revoking fails', async () => {
    const { service, memory } = setup();
    memory.set(`${KEY}.LastAuthUser`, 'me');
    sdk.signOut.mockImplementation((cb?: () => void) => cb?.());
    await service.signOut();
    expect(sdk.signOut).toHaveBeenCalledTimes(2); // with revoke callback, then plain local clear
    expect(typeof sdk.signOut.mock.calls[0]![0]).toBe('function');
    expect(sdk.signOut.mock.calls[1]![0]).toBeUndefined();
  });

  it('abandons a pending challenge and does nothing when nobody is signed in', async () => {
    const { service } = setup();
    await service.signOut();
    expect(sdk.signOut).not.toHaveBeenCalled();

    answer(sdk.authenticateUser, 'totpRequired', 'SOFTWARE_TOKEN_MFA', {});
    await service.signIn('a@b.c', 'pw');
    sdk.signOut.mockImplementation((cb?: () => void) => cb?.());
    await service.signOut();
    expect(sdk.signOut).toHaveBeenCalledTimes(2);
    await expect(service.submitTotp('123456')).rejects.toMatchObject({ code: 'ExpiredChallenge' });
  });
});

describe('password reset', () => {
  it('requests a code (verification-code or success callback) and surfaces failures', async () => {
    const { service } = setup();
    answer(sdk.forgotPassword, 'inputVerificationCode', {});
    await expect(service.requestPasswordReset(' a@b.c ')).resolves.toBeUndefined();
    answer(sdk.forgotPassword, 'onSuccess', {});
    await expect(service.requestPasswordReset('a@b.c')).resolves.toBeUndefined();
    answer(sdk.forgotPassword, 'onFailure', new Error('limit'));
    await expect(service.requestPasswordReset('a@b.c')).rejects.toThrow('limit');
  });

  it('confirms the new password with the emailed code', async () => {
    const { service } = setup();
    answer(sdk.confirmPassword, 'onSuccess', 'SUCCESS');
    await expect(service.confirmPasswordReset('a@b.c', '654321', 'N3w-Password!')).resolves.toBeUndefined();
    expect(sdk.confirmPassword.mock.calls[0]!.slice(0, 2)).toEqual(['654321', 'N3w-Password!']);
    answer(sdk.confirmPassword, 'onFailure', new Error('bad code'));
    await expect(service.confirmPasswordReset('a@b.c', '1', 'x')).rejects.toThrow('bad code');
  });
});

describe('defaults', () => {
  it('uses the refresh-token storage when none is injected', async () => {
    const service = createCognitoService({ userPoolId: 'eu-west-1_Pool', clientId: 'default-client' });
    await expect(service.restoreSession()).resolves.toBeNull();
  });

  it('wraps non-Error SDK failures in an Error, keeping their code', async () => {
    const { service, memory } = setup();
    memory.set(`${KEY}.LastAuthUser`, 'me');
    memory.set(`${KEY}.me.refreshToken`, 'r');
    const failWith = (reason: unknown) => sdk.refreshSession.mockImplementation((_t, done: (e: unknown) => void) => done(reason));

    failWith({ code: 'NetworkError', message: 'offline' });
    await expect(service.restoreSession()).rejects.toMatchObject({ code: 'NetworkError', message: 'offline' });
    failWith({ code: 'NetworkError' });
    await expect(service.restoreSession()).rejects.toThrow('Authentication request failed.');
    failWith('boom');
    await expect(service.restoreSession()).rejects.toThrow('boom');
    failWith(42);
    await expect(service.restoreSession()).rejects.toBeInstanceOf(Error);
  });
});
