import type { Bytes } from '../encoding.js';
import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from '../auth/github/base64url.js';
import { createTestSubscriber, decryptAes128gcm, importEcdhPrivateKey } from '../testing/push.js';
import { MAX_RECORD_PLAINTEXT, PushCryptoError, RECORD_SIZE, decodeUserAgentKeys, deriveContentKeys, encryptPayload } from './encrypt.js';

const bytes = (value: string): Bytes => base64UrlToBytes(value)!;
const text = (value: string): Bytes => new TextEncoder().encode(value);

/** RFC 8291 Appendix A: every input and the intermediate values of the specification's example. */
const VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

describe('RFC 8291 Appendix A test vector', () => {
  it('derives the intermediate values of the specification', async () => {
    const asPrivate = await importEcdhPrivateKey(bytes(VECTOR.asPrivate), bytes(VECTOR.asPublic));
    const uaPublic = await crypto.subtle.importKey('raw', bytes(VECTOR.uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, asPrivate, 256));
    expect(bytesToBase64Url(ecdhSecret)).toBe(VECTOR.ecdhSecret);

    const keys = await deriveContentKeys({ ecdhSecret, authSecret: bytes(VECTOR.authSecret), userAgentPublic: bytes(VECTOR.uaPublic), senderPublic: bytes(VECTOR.asPublic), salt: bytes(VECTOR.salt) });
    expect(bytesToBase64Url(keys.ikm)).toBe(VECTOR.ikm);
    expect(bytesToBase64Url(keys.cek)).toBe(VECTOR.cek);
    expect(bytesToBase64Url(keys.nonce)).toBe(VECTOR.nonce);
  });

  it('produces exactly the encrypted message of the specification', async () => {
    const privateKey = await importEcdhPrivateKey(bytes(VECTOR.asPrivate), bytes(VECTOR.asPublic));
    const publicKey = await crypto.subtle.importKey('raw', bytes(VECTOR.asPublic), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const body = await encryptPayload(bytes(VECTOR.plaintext), { p256dh: VECTOR.uaPublic, auth: VECTOR.authSecret }, { salt: bytes(VECTOR.salt), senderKeyPair: { privateKey, publicKey } });
    const expected = new Uint8Array([...bytes(VECTOR.header), ...bytes(VECTOR.ciphertext)]);
    expect(bytesToBase64Url(body)).toBe(bytesToBase64Url(expected));
    expect(body.length).toBe(86 + 16 + 41 + 1);
  });

  it('decrypts the specification message back to the plaintext', async () => {
    const privateKey = await importEcdhPrivateKey(bytes(VECTOR.uaPrivate), bytes(VECTOR.uaPublic));
    const message = new Uint8Array([...bytes(VECTOR.header), ...bytes(VECTOR.ciphertext)]);
    const plaintext = await decryptAes128gcm(message, { privateKey, publicKey: bytes(VECTOR.uaPublic), authSecret: bytes(VECTOR.authSecret) });
    expect(new TextDecoder().decode(plaintext)).toBe('When I grow up, I want to be a watermelon');
  });
});

describe('encryptPayload round trip', () => {
  it('a subscriber with a generated key pair reads what was sent, with a fresh salt and sender key every time', async () => {
    const subscriber = await createTestSubscriber();
    const payload = JSON.stringify({ title: 'KMB declared $1.28 per share', body: 'Ex-date 06-11-2026 · +2.4 % vs last quarter', emoji: '€ ✓' });
    const first = await encryptPayload(text(payload), subscriber.subscription.keys);
    const second = await encryptPayload(text(payload), subscriber.subscription.keys);
    expect(await subscriber.decrypt(first)).toEqual(JSON.parse(payload));
    expect(await subscriber.decrypt(second)).toEqual(JSON.parse(payload));
    expect(bytesToBase64Url(first)).not.toBe(bytesToBase64Url(second));
  });

  it('writes the header of RFC 8188: record size 4096 and the 65-byte sender key id', async () => {
    const subscriber = await createTestSubscriber();
    const body = await encryptPayload(text('{}'), subscriber.subscription.keys);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(RECORD_SIZE);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04);
    expect(body.length).toBe(16 + 4 + 1 + 65 + 2 + 1 + 16);
  });

  it('cannot be decrypted by another subscriber', async () => {
    const [intended, other] = await Promise.all([createTestSubscriber(), createTestSubscriber()]);
    const body = await encryptPayload(text('{"secret":1}'), intended.subscription.keys);
    await expect(other.decrypt(body)).rejects.toThrow();
  });

  it('carries the largest payload a single record holds and refuses one byte more', async () => {
    const subscriber = await createTestSubscriber();
    const filler = 'a'.repeat(MAX_RECORD_PLAINTEXT - '{"x":""}'.length);
    const largest = text(`{"x":"${filler}"}`);
    expect(largest.length).toBe(MAX_RECORD_PLAINTEXT);
    expect(await subscriber.decrypt(await encryptPayload(largest, subscriber.subscription.keys))).toEqual({ x: filler });
    await expect(encryptPayload(new Uint8Array(MAX_RECORD_PLAINTEXT + 1), subscriber.subscription.keys)).rejects.toThrow(PushCryptoError);
  });
});

describe('decodeUserAgentKeys', () => {
  it('accepts a valid key pair of secrets', () => {
    const { publicKey, authSecret } = decodeUserAgentKeys({ p256dh: VECTOR.uaPublic, auth: VECTOR.authSecret });
    expect([publicKey.length, authSecret.length]).toEqual([65, 16]);
  });

  it.each([
    ['not base64url', '***', VECTOR.authSecret],
    ['a compressed point', bytesToBase64Url(new Uint8Array(33).fill(2)), VECTOR.authSecret],
    ['a 65-byte value that is not an uncompressed point', bytesToBase64Url(new Uint8Array(65).fill(5)), VECTOR.authSecret],
    ['a short auth secret', VECTOR.uaPublic, bytesToBase64Url(new Uint8Array(8))],
    ['a malformed auth secret', VECTOR.uaPublic, '!!'],
  ])('rejects %s', (_label, p256dh, auth) => {
    expect(() => decodeUserAgentKeys({ p256dh, auth })).toThrow(PushCryptoError);
  });
});
