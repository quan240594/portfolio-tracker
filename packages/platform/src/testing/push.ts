import type { Bytes } from '../encoding.js';
import { base64UrlToBytes, bytesToBase64Url } from '../auth/github/base64url.js';
import { deriveContentKeys, ecPrivateJwk } from '../push/encrypt.js';
import type { PushSubscriptionData } from '../push/sender.js';

/** Test doubles for Web Push: a subscriber that can decrypt what the sender produced, and a fake push service over `fetch`. */

const decoder = new TextDecoder();

/**
 * The receiving side of RFC 8291 (what a browser does): decrypts a push request body with the user agent's private key and the
 * authentication secret. Returns the payload without the padding delimiter.
 */
export async function decryptAes128gcm(body: Uint8Array, receiver: { privateKey: CryptoKey; publicKey: Bytes; authSecret: Bytes }): Promise<Bytes> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const peer = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, receiver.privateKey, 256));
  const { cek, nonce } = await deriveContentKeys({ ecdhSecret, authSecret: receiver.authSecret, userAgentPublic: receiver.publicKey, senderPublic, salt });
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  if (record[end - 1] !== 0x02) throw new Error('Missing padding delimiter');
  return record.slice(0, end - 1);
}

export interface TestSubscriber {
  subscription: PushSubscriptionData;
  /** Decrypts a request body the sender produced for this subscriber and parses the JSON payload. */
  decrypt(body: Uint8Array): Promise<Record<string, unknown>>;
}

/** A subscriber with a freshly generated key pair and auth secret, subscribed at `endpoint`. */
export async function createTestSubscriber(endpoint = 'https://fcm.googleapis.com/fcm/send/test-device'): Promise<TestSubscriber> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint, keys: { p256dh: bytesToBase64Url(publicKey), auth: bytesToBase64Url(authSecret) } },
    async decrypt(body) {
      const plaintext = await decryptAes128gcm(body, { privateKey: pair.privateKey, publicKey, authSecret });
      return JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
    },
  };
}

/** An ECDH private key from raw `d` and the uncompressed public point (the RFC 8291 test vector gives both). */
export const importEcdhPrivateKey = (scalar: Bytes, publicPoint: Bytes): Promise<CryptoKey> =>
  crypto.subtle.importKey('jwk', ecPrivateJwk(scalar, publicPoint), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);

export interface VapidClaims {
  aud: string;
  exp: number;
  sub: string;
}

/** Parses and verifies (ES256) the `Authorization: vapid t=..., k=...` header; throws when the signature or the structure is wrong. */
export async function verifyVapidAuthorization(header: string): Promise<{ claims: VapidClaims; publicKey: string; jwtHeader: Record<string, unknown> }> {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  if (!match) throw new Error('Not a vapid Authorization header');
  const [, head, claims, signature, publicKey] = match as unknown as [string, string, string, string, string];
  const key = await crypto.subtle.importKey('raw', base64UrlToBytes(publicKey)!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64UrlToBytes(signature)!, new TextEncoder().encode(`${head}.${claims}`));
  if (!valid) throw new Error('Invalid VAPID signature');
  return {
    claims: JSON.parse(decoder.decode(base64UrlToBytes(claims)!)) as VapidClaims,
    publicKey,
    jwtHeader: JSON.parse(decoder.decode(base64UrlToBytes(head)!)) as Record<string, unknown>,
  };
}

export interface RecordedPush {
  url: string;
  headers: Record<string, string>;
  body: Bytes;
}

export interface FakePushService {
  fetch: typeof fetch;
  /** Every request received, oldest first. */
  requests: RecordedPush[];
  /** Answers requests for the endpoint URL with `status` (default 201) and optional headers from now on. */
  respond(endpoint: string, status: number, headers?: Record<string, string>): void;
  /** Makes requests for the endpoint URL fail with a network error. */
  fail(endpoint: string): void;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

/** A fake push service: records every request, answers 201 unless told otherwise. No network involved. */
export function createFakePushService(): FakePushService {
  const requests: RecordedPush[] = [];
  const answers = new Map<string, { status: number; headers: Record<string, string> } | 'fail'>();
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const body = new Uint8Array(await new Response(init?.body ?? null).arrayBuffer());
    requests.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body });
    const answer = answers.get(url) ?? { status: 201, headers: {} };
    if (answer === 'fail') throw new TypeError('network down');
    return new Response(null, { status: answer.status, headers: answer.headers });
  };
  return {
    fetch: fakeFetch,
    requests,
    respond: (endpoint, status, headers = {}) => {
      answers.set(endpoint, { status, headers });
    },
    fail: (endpoint) => {
      answers.set(endpoint, 'fail');
    },
  };
}
