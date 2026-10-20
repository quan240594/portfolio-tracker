import type { Bytes } from '../encoding.js';
import { base64UrlToBytes, bytesToBase64Url } from '../auth/github/base64url.js';

/**
 * VAPID (RFC 8292): the application server identifies itself to the push service with an ES256 JWT whose audience is the
 * push service's origin, plus its public key. Keys are generated once (`generateVapidKeys`); the private key is a Worker secret.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The RFC caps `exp` at 24 hours; 11 hours leaves room for a skewed clock and stays under the 12 h this app promises. */
export const VAPID_JWT_LIFETIME_SECONDS = 11 * 3600;
const PUBLIC_KEY_BYTES = 65;

export interface VapidKeys {
  /** The 65-byte uncompressed P-256 point, base64url: the public `VAPID_PUBLIC_KEY` and the browser's `applicationServerKey`. */
  publicKey: string;
  /** The private key as base64url of its PKCS #8 DER: the Worker secret `VAPID_PRIVATE_KEY`. */
  privateKey: string;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    publicKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** The contact URL of the application server: the app's own https origin (RFC 8292 allows `mailto:` or `https:`). */
  subject: string;
  /** Epoch milliseconds; defaults to the system clock. */
  now?: () => number;
}

export interface VapidSigner {
  publicKey: string;
  /** The `Authorization` header value for a push service origin, e.g. `https://fcm.googleapis.com`. */
  authorization(audience: string): Promise<string>;
}

export class VapidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VapidConfigError';
  }
}

const jsonPart = (value: object): string => bytesToBase64Url(encoder.encode(JSON.stringify(value)));

async function importPrivateKey(privateKey: string, publicBytes: Bytes): Promise<CryptoKey> {
  const raw = base64UrlToBytes(privateKey);
  if (raw === undefined || raw.length === 0) throw new VapidConfigError('VAPID_PRIVATE_KEY is not base64url');
  try {
    // A PKCS #8 key (what `generateVapidKeys` prints) or, for convenience, the base64url of a private JWK.
    const key =
      raw[0] === 0x7b
        ? await crypto.subtle.importKey('jwk', JSON.parse(decoder.decode(raw)) as JsonWebKey, ECDSA, true, ['sign'])
        : await crypto.subtle.importKey('pkcs8', raw, ECDSA, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const derived = concatPoint(jwk);
    if (derived === undefined || bytesToBase64Url(derived) !== bytesToBase64Url(publicBytes)) throw new VapidConfigError('VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY');
    return key;
  } catch (error) {
    if (error instanceof VapidConfigError) throw error;
    throw new VapidConfigError('VAPID_PRIVATE_KEY is not a P-256 private key');
  }
}

function concatPoint(jwk: JsonWebKey): Bytes | undefined {
  const x = jwk.x === undefined ? undefined : base64UrlToBytes(jwk.x);
  const y = jwk.y === undefined ? undefined : base64UrlToBytes(jwk.y);
  if (x === undefined || y === undefined) return undefined;
  return Uint8Array.of(0x04, ...x, ...y);
}

/** Validates the key pair and subject once and returns the signer. Throws `VapidConfigError` (the message never contains a key). */
export async function createVapidSigner(config: VapidConfig): Promise<VapidSigner> {
  const publicBytes = base64UrlToBytes(config.publicKey);
  if (publicBytes?.length !== PUBLIC_KEY_BYTES || publicBytes[0] !== 0x04) throw new VapidConfigError('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 key (base64url)');
  let subject: URL;
  try {
    subject = new URL(config.subject);
  } catch {
    throw new VapidConfigError('The VAPID subject must be an https URL');
  }
  if (subject.protocol !== 'https:') throw new VapidConfigError('The VAPID subject must be an https URL');
  const key = await importPrivateKey(config.privateKey, publicBytes);
  const now = config.now ?? (() => Date.now());
  return {
    publicKey: config.publicKey,
    async authorization(audience) {
      const claims = { aud: audience, exp: Math.floor(now() / 1000) + VAPID_JWT_LIFETIME_SECONDS, sub: subject.origin };
      const signingInput = `${jsonPart({ typ: 'JWT', alg: 'ES256' })}.${jsonPart(claims)}`;
      // WebCrypto's ECDSA signature is the raw r || s (64 bytes) that JWS ES256 wants.
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput)));
      return `vapid t=${signingInput}.${bytesToBase64Url(signature)}, k=${config.publicKey}`;
    },
  };
}
