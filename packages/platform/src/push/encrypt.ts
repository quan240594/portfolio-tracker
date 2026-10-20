import type { Bytes } from '../encoding.js';
import { base64UrlToBytes, bytesToBase64Url } from '../auth/github/base64url.js';

/**
 * Web Push message encryption: RFC 8291 with the `aes128gcm` content coding of RFC 8188, ECDH on P-256 and HKDF-SHA-256, on
 * WebCrypto only. A message is one record: header (salt, record size, sender public key) + AES-128-GCM(payload || 0x02).
 */

const encoder = new TextEncoder();

/** Record size announced in the header; one record carries up to `RECORD_SIZE - 17` payload bytes. */
export const RECORD_SIZE = 4096;
const TAG_BYTES = 16;
const PADDING_DELIMITER = 0x02;
const UNCOMPRESSED_POINT_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
/** Largest plaintext of a single record (the delimiter byte and the GCM tag take the rest). */
export const MAX_RECORD_PLAINTEXT = RECORD_SIZE - TAG_BYTES - 1;

/** The subscriber's keys exactly as `PushSubscription.toJSON()` delivers them: base64url. */
export interface PushKeys {
  /** The user agent's ECDH public key: 65 bytes, uncompressed P-256 point. */
  p256dh: string;
  /** The 16-byte authentication secret. */
  auth: string;
}

export interface EncryptOptions {
  /** Fixed salt and sender key pair: only for the RFC 8291 test vector; every real message uses fresh random ones. */
  salt?: Bytes;
  senderKeyPair?: CryptoKeyPair;
}

const NO_OPTIONS: EncryptOptions = {};

export class PushCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushCryptoError';
  }
}

const concat = (...parts: Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** HKDF-SHA-256 (extract with `salt`, expand with `info`) to `length` bytes. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Decodes and checks the subscriber's keys (`p256dh`: uncompressed P-256 point, `auth`: 16 bytes). */
export function decodeUserAgentKeys(keys: PushKeys): { publicKey: Bytes; authSecret: Bytes } {
  const publicKey = base64UrlToBytes(keys.p256dh);
  const authSecret = base64UrlToBytes(keys.auth);
  if (publicKey?.length !== UNCOMPRESSED_POINT_BYTES || publicKey[0] !== 0x04) throw new PushCryptoError('p256dh must be an uncompressed P-256 public key');
  if (authSecret?.length !== AUTH_SECRET_BYTES) throw new PushCryptoError('auth must be a 16-byte secret');
  return { publicKey, authSecret };
}

export interface ContentKeys {
  /** Input keying material of the content key (RFC 8291 section 3.4). */
  ikm: Bytes;
  /** AES-128-GCM content encryption key. */
  cek: Bytes;
  /** AES-GCM nonce of the (only) record. */
  nonce: Bytes;
}

/** RFC 8291 key schedule: the content encryption key and nonce from the ECDH secret, the auth secret and the salt. */
export async function deriveContentKeys(input: { ecdhSecret: Bytes; authSecret: Bytes; userAgentPublic: Bytes; senderPublic: Bytes; salt: Bytes }): Promise<ContentKeys> {
  const { ecdhSecret, authSecret, userAgentPublic, senderPublic, salt } = input;
  const keyInfo = concat(encoder.encode('WebPush: info\0'), userAgentPublic, senderPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  return { ikm, cek, nonce };
}

/** Encrypts `plaintext` for the subscriber: the complete request body (header + ciphertext) of the push request. */
export async function encryptPayload(plaintext: Bytes, keys: PushKeys, options: EncryptOptions = NO_OPTIONS): Promise<Bytes> {
  if (plaintext.length > MAX_RECORD_PLAINTEXT) throw new PushCryptoError('The payload does not fit in one record');
  const { publicKey: userAgentPublic, authSecret } = decodeUserAgentKeys(keys);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const sender = options.senderKeyPair ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const peer = await crypto.subtle.importKey('raw', userAgentPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, sender.privateKey, 256));
  const { cek, nonce } = await deriveContentKeys({ ecdhSecret, authSecret, userAgentPublic, senderPublic, salt });
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, Uint8Array.of(PADDING_DELIMITER));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));
  const header = new Uint8Array(salt.length + 4 + 1 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(salt.length, RECORD_SIZE);
  header[salt.length + 4] = senderPublic.length;
  header.set(senderPublic, salt.length + 5);
  return concat(header, ciphertext);
}

/** An ECDH P-256 private key (JWK) from its `d` scalar and the matching uncompressed public point, both raw bytes. */
export function ecPrivateJwk(scalar: Bytes, publicPoint: Bytes): JsonWebKey {
  return { kty: 'EC', crv: 'P-256', d: bytesToBase64Url(scalar), x: bytesToBase64Url(publicPoint.slice(1, 33)), y: bytesToBase64Url(publicPoint.slice(33, 65)) };
}
