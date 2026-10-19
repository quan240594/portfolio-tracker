import { base64ToBytes, bytesToBase64 } from '../../encoding.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
  const base64 = bytesToBase64(bytes);
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') end--;
  return base64.slice(0, end).replaceAll('+', '-').replaceAll('/', '_');
}

/** Strict decode: only the URL-safe alphabet, no padding. Returns undefined for anything else. */
export function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return base64ToBytes(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
}
