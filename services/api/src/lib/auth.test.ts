import { describe, expect, it } from 'vitest';
import { toPortableRequest } from '@portfolio/aws';
import { resolveUserId as resolvePortable, type AuthConfig } from './auth.js';
import { HttpError } from './http.js';
import { apiEvent } from '../testing/fakes.js';

/** The API Gateway event as the application sees it: through the adapter's translation. */
const resolveUserId = (event: Parameters<typeof toPortableRequest>[0], config: AuthConfig) => resolvePortable(toPortableRequest(event), config);

const cognito: AuthConfig = { authMode: 'cognito', demoUserId: 'demo' };
const demo: AuthConfig = { authMode: 'demo', demoUserId: 'demo' };

const withClaims = (claims: Record<string, unknown> | undefined) => {
  const event = apiEvent('GET', '/portfolio');
  (event.requestContext as unknown as { authorizer: unknown }).authorizer = { jwt: { claims } };
  return event;
};

const unauthenticated = expect.objectContaining({ statusCode: 401, code: 'UNAUTHENTICATED' });

describe('resolveUserId (cognito mode)', () => {
  it('returns the sub claim set by the JWT authorizer', () => {
    expect(resolveUserId(withClaims({ sub: '3f1c2b9e-0a52-4d6e-9b53-7a1f6c0a8d11' }), cognito)).toBe('3f1c2b9e-0a52-4d6e-9b53-7a1f6c0a8d11');
  });

  it('rejects requests without an authorizer, claims or a usable sub — never falling back to the demo user', () => {
    for (const event of [
      apiEvent('GET', '/portfolio'),
      withClaims(undefined),
      withClaims({}),
      withClaims({ sub: '' }),
      withClaims({ sub: 42 }),
    ]) {
      expect(() => resolveUserId(event, cognito)).toThrow(HttpError);
      try {
        resolveUserId(event, cognito);
      } catch (err) {
        expect(err).toEqual(unauthenticated);
      }
    }
  });

  it('rejects subs that could escape DynamoDB / S3 key namespaces', () => {
    for (const sub of ['a/b', '../x', 'a#b', 'with space', 'x'.repeat(129)]) {
      expect(() => resolveUserId(withClaims({ sub }), cognito)).toThrow(HttpError);
    }
  });
});

describe('resolveUserId (demo mode)', () => {
  it('uses the demo user without claims', () => {
    expect(resolveUserId(apiEvent('GET', '/portfolio'), demo)).toBe('demo');
    expect(resolveUserId(withClaims({ sub: '' }), demo)).toBe('demo');
  });

  it('still honours a validated sub claim and keeps rejecting unsafe ones', () => {
    expect(resolveUserId(withClaims({ sub: 'user-123' }), demo)).toBe('user-123');
    expect(() => resolveUserId(withClaims({ sub: 'a/b' }), demo)).toThrow(HttpError);
  });
});

describe('resolveUserId on a portable request', () => {
  it('uses the identity the platform verified, and fails closed without one', () => {
    expect(resolvePortable({ identity: { subject: 'abc' } }, cognito)).toBe('abc');
    expect(resolvePortable({ identity: { subject: 'abc' } }, demo)).toBe('abc');
    expect(resolvePortable({}, demo)).toBe('demo');
    expect(() => resolvePortable({}, cognito)).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(() => resolvePortable({ identity: { subject: 'a/b' } }, demo)).toThrow(expect.objectContaining({ statusCode: 401 }));
  });
});
