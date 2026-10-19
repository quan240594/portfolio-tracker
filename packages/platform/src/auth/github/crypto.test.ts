import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from './base64url.js';
import { constantTimeEqual, createTokenSigner, randomToken } from './crypto.js';
import { clearCookie, readCookie, serializeCookie } from './cookies.js';

describe('constantTimeEqual', () => {
  it('is true only for identical strings or bytes', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual('é', new TextEncoder().encode('é'))).toBe(true);
  });
});

describe('base64url', () => {
  it('round-trips bytes without padding or unsafe characters', () => {
    const bytes = Uint8Array.from([251, 255, 254, 0, 1, 2, 3]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
  });

  it('rejects the standard alphabet, padding, whitespace, empty and impossible lengths', () => {
    for (const bad of ['a+b/', 'abcd==', 'ab cd', '', 'abcde']) expect(base64UrlToBytes(bad)).toBeUndefined();
  });
});

describe('randomToken', () => {
  it('is url-safe, long enough and different every time', () => {
    const a = randomToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken()).not.toBe(a);
    expect(randomToken(8).length).toBeLessThan(a.length);
  });
});

describe('createTokenSigner', () => {
  const secret = 'a-very-long-secret-of-32-characters!!';
  const signer = createTokenSigner(secret);

  it('signs and verifies a payload, in the documented payload.signature format', async () => {
    const token = await signer.sign('p', { a: 1 });
    expect(token.split('.')).toHaveLength(2);
    expect(await signer.verify('p', token)).toEqual({ a: 1 });
  });

  it('rejects another secret, another purpose and a tampered payload or signature', async () => {
    const token = await signer.sign('p', { a: 1 });
    const [payload, signature] = token.split('.') as [string, string];
    expect(await createTokenSigner('another-long-secret-of-32-characters!').verify('p', token)).toBeUndefined();
    expect(await signer.verify('q', token)).toBeUndefined();
    const forgedPayload = bytesToBase64Url(new TextEncoder().encode('{"a":2}'));
    expect(await signer.verify('p', `${forgedPayload}.${signature}`)).toBeUndefined();
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(await signer.verify('p', `${payload}.${flipped}`)).toBeUndefined();
    expect(await signer.verify('p', `${payload}.${signature.slice(0, -2)}`)).toBeUndefined();
  });

  it('rejects wrong structure: empty, one part, three parts (JWT style), unsigned, bad encodings', async () => {
    const token = await signer.sign('p', { a: 1 });
    const [payload, signature] = token.split('.') as [string, string];
    for (const bad of ['', 'abc', `${payload}.${signature}.x`, `x.${payload}.${signature}`, `${payload}.`, `.${signature}`, `${payload}.***`]) {
      expect(await signer.verify('p', bad)).toBeUndefined();
    }
    const none = bytesToBase64Url(new TextEncoder().encode('{"alg":"none"}'));
    expect(await signer.verify('p', `${none}.`)).toBeUndefined();
  });

  it('rejects a correctly signed payload that is not JSON', async () => {
    const raw = createTokenSigner(secret);
    const notJson = bytesToBase64Url(new TextEncoder().encode('not json'));
    // Sign "not json" with the real key via a payload whose JSON is replaced by re-signing the exact bytes.
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`p.${notJson}`)));
    expect(await raw.verify('p', `${notJson}.${bytesToBase64Url(mac)}`)).toBeUndefined();
  });

  it('rejects a correctly signed payload whose base64 is not canonical utf-8 json', async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const encodedPayload = 'abcde'; // invalid length: signature cannot be valid, payload undecodable
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`p.${encodedPayload}`)));
    expect(await signer.verify('p', `${encodedPayload}.${bytesToBase64Url(mac)}`)).toBeUndefined();
  });
});

describe('cookies', () => {
  it('serialises with the required attributes', () => {
    expect(serializeCookie('n', 'v', { path: '/', maxAgeSeconds: 60 })).toBe('n=v; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60');
    expect(clearCookie('n', '/auth')).toBe('n=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0');
  });

  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; pt_session=tok; b=2', 'pt_session')).toBe('tok');
    expect(readCookie('xpt_session=no; pt_session=yes', 'pt_session')).toBe('yes');
    expect(readCookie('a=1', 'pt_session')).toBeUndefined();
    expect(readCookie('pt_session=', 'pt_session')).toBeUndefined();
    expect(readCookie('=x; novalue', 'pt_session')).toBeUndefined();
    expect(readCookie(undefined, 'a')).toBeUndefined();
    expect(readCookie(null, 'a')).toBeUndefined();
    expect(readCookie('', 'a')).toBeUndefined();
  });
});
