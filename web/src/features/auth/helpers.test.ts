import { describe, expect, it, vi } from 'vitest';
import { authErrorMessage } from './errors';
import { formatSecret, otpauthUri } from './otpauth';
import { isTotpCode, normaliseTotpCode, passwordProblem } from './passwordPolicy';
import { RefreshTokenStorage } from './refreshStorage';
import { authorizationHeaders, notifyUnauthorized, setAuthTokenHooks } from './tokenHooks';

describe('authErrorMessage', () => {
  it('maps known Cognito errors to friendly messages', () => {
    expect(authErrorMessage({ code: 'NotAuthorizedException', message: 'Incorrect username or password.' })).toBe('Incorrect email or password.');
    expect(authErrorMessage({ name: 'UserNotFoundException' })).toBe('Incorrect email or password.');
    expect(authErrorMessage({ code: 'CodeMismatchException' })).toMatch(/not correct/);
    expect(authErrorMessage({ code: 'ExpiredCodeException' })).toMatch(/expired/);
    expect(authErrorMessage({ code: 'LimitExceededException' })).toMatch(/Too many attempts/);
    expect(authErrorMessage({ code: 'NetworkError' })).toMatch(/Could not reach/);
  });

  it('recognises an expired sign-in session', () => {
    const expired = 'Your sign-in session expired. Go back and sign in again.';
    expect(authErrorMessage({ code: 'NotAuthorizedException', message: 'Invalid session for the user, session is expired.' })).toBe(expired);
    expect(authErrorMessage({ code: 'ExpiredChallenge' })).toBe(expired);
  });

  it('falls back to the error message, then to a generic one', () => {
    expect(authErrorMessage(new Error('Custom'))).toBe('Custom');
    expect(authErrorMessage({})).toBe('Something went wrong. Please try again.');
    expect(authErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
  });
});

describe('otpauth helpers', () => {
  it('builds an otpauth URI that carries the secret and issuer', () => {
    expect(otpauthUri('me@example.com', 'ABC DEF')).toBe(
      'otpauth://totp/Portfolio%20Tracker%3Ame%40example.com?secret=ABC%20DEF&issuer=Portfolio%20Tracker',
    );
  });

  it('groups the secret in blocks of four for manual entry', () => {
    expect(formatSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(formatSecret('')).toBe('');
  });
});

describe('passwordPolicy', () => {
  it('reports the first unmet rule, mirroring the Cognito pool policy', () => {
    expect(passwordProblem('Short1!')).toMatch(/at least 12/);
    expect(passwordProblem('ALLUPPERCASE123!')).toMatch(/lowercase/);
    expect(passwordProblem('alllowercase123!')).toMatch(/uppercase/);
    expect(passwordProblem('NoDigitsHere!!!!')).toMatch(/number/);
    expect(passwordProblem('NoSymbolsHere1234')).toMatch(/symbol/);
    expect(passwordProblem('Str0ng-Passw0rd!')).toBeUndefined();
  });

  it('validates and normalises TOTP codes', () => {
    expect(normaliseTotpCode(' 123 456 ')).toBe('123456');
    expect(isTotpCode('123456')).toBe(true);
    expect(isTotpCode('12345')).toBe(false);
    expect(isTotpCode('12345a')).toBe(false);
  });
});

describe('RefreshTokenStorage', () => {
  const backing = () => {
    const map = new Map<string, string>();
    return {
      map,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
          return map.size;
        },
        clear: () => map.clear(),
      } as Storage,
    };
  };
  const P = 'CognitoIdentityServiceProvider.cid';

  it('persists only the refresh token and the last-user pointer; ID/access tokens stay in memory', () => {
    const { map, storage } = backing();
    const s = new RefreshTokenStorage(storage);
    s.setItem(`${P}.LastAuthUser`, 'me');
    s.setItem(`${P}.me.refreshToken`, 'r');
    s.setItem(`${P}.me.idToken`, 'i');
    s.setItem(`${P}.me.accessToken`, 'a');
    expect([...map.keys()].sort((a, b) => a.localeCompare(b))).toEqual([`${P}.LastAuthUser`, `${P}.me.refreshToken`]);
    expect(s.getItem(`${P}.me.refreshToken`)).toBe('r');
    expect(s.getItem(`${P}.me.idToken`)).toBe('i');
    expect(s.getItem(`${P}.me.missing`)).toBeNull();
  });

  it('removes single items and clears everything Cognito stored', () => {
    const { map, storage } = backing();
    map.set('unrelated', 'keep');
    const s = new RefreshTokenStorage(storage);
    s.setItem(`${P}.LastAuthUser`, 'me');
    s.setItem(`${P}.me.refreshToken`, 'r');
    s.setItem(`${P}.me.idToken`, 'i');
    s.removeItem(`${P}.me.idToken`);
    expect(s.getItem(`${P}.me.idToken`)).toBeNull();
    s.removeItem(`${P}.me.refreshToken`);
    expect(map.has(`${P}.me.refreshToken`)).toBe(false);
    s.setItem(`${P}.me.refreshToken`, 'r');
    s.setItem(`${P}.me.idToken`, 'i');
    s.clear();
    expect([...map.keys()]).toEqual(['unrelated']);
    expect(s.getItem(`${P}.me.idToken`)).toBeNull();
  });

  it('defaults to window.localStorage', () => {
    const s = new RefreshTokenStorage();
    s.setItem(`${P}.LastAuthUser`, 'me');
    expect(localStorage.getItem(`${P}.LastAuthUser`)).toBe('me');
  });
});

describe('token hooks', () => {
  it('adds a bearer header only when a token is available and forwards 401 notifications', async () => {
    expect(await authorizationHeaders()).toEqual({});
    notifyUnauthorized(); // no hooks registered: no-op

    const onUnauthorized = vi.fn();
    setAuthTokenHooks({ getToken: () => Promise.resolve('tok'), onUnauthorized });
    expect(await authorizationHeaders()).toEqual({ Authorization: 'Bearer tok' });
    notifyUnauthorized();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    setAuthTokenHooks({ getToken: () => Promise.resolve(undefined), onUnauthorized });
    expect(await authorizationHeaders()).toEqual({});
    setAuthTokenHooks(undefined);
  });
});
