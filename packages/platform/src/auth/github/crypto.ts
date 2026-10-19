import { base64UrlToBytes, bytesToBase64Url } from './base64url.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Compares two strings or byte arrays in time that depends only on the longer length, never on where they differ. */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = typeof a === 'string' ? encoder.encode(a) : a;
  const right = typeof b === 'string' ? encoder.encode(b) : b;
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** URL-safe random token of `byteLength` random bytes. */
export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export interface TokenSigner {
  /** `base64url(JSON payload).base64url(HMAC-SHA256)`; `purpose` is mixed into the MAC so a token cannot be replayed across uses. */
  sign(purpose: string, payload: object): Promise<string>;
  /** The payload of a correctly signed token for `purpose`, else undefined (malformed, tampered, wrong secret or purpose). */
  verify(purpose: string, token: string): Promise<unknown>;
}

export function createTokenSigner(secret: string): TokenSigner {
  let keyPromise: Promise<CryptoKey> | undefined;
  const key = () => {
    keyPromise ??= crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return keyPromise;
  };
  const mac = async (purpose: string, encodedPayload: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign('HMAC', await key(), encoder.encode(`${purpose}.${encodedPayload}`)));

  return {
    async sign(purpose, payload) {
      const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
      return `${encodedPayload}.${bytesToBase64Url(await mac(purpose, encodedPayload))}`;
    },
    async verify(purpose, token) {
      const parts = token.split('.');
      if (parts.length !== 2) return undefined;
      const [encodedPayload, encodedSignature] = parts as [string, string];
      const signature = base64UrlToBytes(encodedSignature);
      if (!signature || !constantTimeEqual(signature, await mac(purpose, encodedPayload))) return undefined;
      const payloadBytes = base64UrlToBytes(encodedPayload);
      if (!payloadBytes) return undefined;
      try {
        return JSON.parse(decoder.decode(payloadBytes)) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}
