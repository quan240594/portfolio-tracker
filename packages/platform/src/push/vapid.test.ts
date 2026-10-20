import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from '../auth/github/base64url.js';
import { verifyVapidAuthorization } from '../testing/push.js';
import { VAPID_JWT_LIFETIME_SECONDS, VapidConfigError, createVapidSigner, generateVapidKeys } from './vapid.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const SUBJECT = 'https://portfolio.example.workers.dev';

describe('generateVapidKeys', () => {
  it('prints a 65-byte uncompressed public key and a PKCS #8 private key, both base64url', async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    const raw = base64UrlToBytes(publicKey)!;
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(publicKey).toMatch(/^[\w-]{87}$/);
    expect(base64UrlToBytes(privateKey)![0]).toBe(0x30);
    expect(privateKey).toMatch(/^[\w-]+$/);
  });

  it('generates a different pair every time', async () => {
    expect((await generateVapidKeys()).publicKey).not.toBe((await generateVapidKeys()).publicKey);
  });
});

describe('createVapidSigner', () => {
  it('signs an ES256 JWT with aud, exp <= 12 h and sub = the app origin, and sends the public key', async () => {
    const keys = await generateVapidKeys();
    const signer = await createVapidSigner({ ...keys, subject: `${SUBJECT}/some/path?x=1`, now: () => NOW });
    const header = await signer.authorization('https://fcm.googleapis.com');
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const { claims, publicKey, jwtHeader } = await verifyVapidAuthorization(header);
    expect(jwtHeader).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe(SUBJECT);
    expect(claims.exp).toBe(NOW / 1000 + VAPID_JWT_LIFETIME_SECONDS);
    expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(12 * 3600);
    expect(publicKey).toBe(keys.publicKey);
    const signature = header.split(', k=')[0]!.split('.')[2]!;
    expect(base64UrlToBytes(signature)!.length).toBe(64);
  });

  it('uses the system clock by default', async () => {
    const signer = await createVapidSigner({ ...(await generateVapidKeys()), subject: SUBJECT });
    const { claims } = await verifyVapidAuthorization(await signer.authorization('https://web.push.apple.com'));
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  });

  it('accepts the private key as the base64url of a private JWK too', async () => {
    const keys = await generateVapidKeys();
    const key = await crypto.subtle.importKey('pkcs8', base64UrlToBytes(keys.privateKey)!, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(await crypto.subtle.exportKey('jwk', key))));
    const signer = await createVapidSigner({ publicKey: keys.publicKey, privateKey: jwk, subject: SUBJECT });
    await expect(verifyVapidAuthorization(await signer.authorization('https://fcm.googleapis.com'))).resolves.toBeTruthy();
  });

  it('refuses a private key that does not belong to the public key', async () => {
    const [a, b] = await Promise.all([generateVapidKeys(), generateVapidKeys()]);
    await expect(createVapidSigner({ publicKey: a.publicKey, privateKey: b.privateKey, subject: SUBJECT })).rejects.toThrow('does not belong');
  });

  it.each([
    ['a public key that is not base64url', { publicKey: '***' }, 'VAPID_PUBLIC_KEY'],
    ['a public key of the wrong length', { publicKey: bytesToBase64Url(new Uint8Array(33)) }, 'VAPID_PUBLIC_KEY'],
    ['a private key that is not base64url', { privateKey: '***' }, 'not base64url'],
    ['a private key that is not a key', { privateKey: bytesToBase64Url(new Uint8Array(40).fill(7)) }, 'P-256 private key'],
    ['a private JWK that is broken', { privateKey: bytesToBase64Url(new TextEncoder().encode('{"kty":"EC"}')) }, 'P-256 private key'],
    ['an http subject', { subject: 'http://portfolio.example' }, 'https URL'],
    ['a subject that is not a URL', { subject: 'mailto-owner' }, 'https URL'],
  ])('rejects %s', async (_label, override, message) => {
    const keys = await generateVapidKeys();
    const attempt = createVapidSigner({ ...keys, subject: SUBJECT, ...override });
    await expect(attempt).rejects.toThrow(VapidConfigError);
    await expect(attempt).rejects.toThrow(message);
  });

  it('never puts a key into an error message', async () => {
    const keys = await generateVapidKeys();
    const error = await createVapidSigner({ ...keys, privateKey: bytesToBase64Url(new Uint8Array(40).fill(7)), subject: SUBJECT }).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(keys.privateKey);
    expect((error as Error).message).not.toContain(keys.publicKey);
  });
});
