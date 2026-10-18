/** Web-standard text/base64 helpers (no Node `Buffer`), so the code that uses them also runs in Workers. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text);
export const utf8ByteLength = (text: string): number => encoder.encode(text).length;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.codePointAt(0)!);
}

/** Standard base64 of the UTF-8 bytes of `text` (e.g. HTTP Basic credentials). */
export const encodeBase64 = (text: string): string => bytesToBase64(utf8Bytes(text));
export const decodeBase64 = (base64: string): string => decoder.decode(base64ToBytes(base64));

/** URL-safe base64 without padding, for opaque cursors. */
export function encodeBase64Url(text: string): string {
  const base64 = encodeBase64(text);
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') end--;
  return base64.slice(0, end).replaceAll('+', '-').replaceAll('/', '_');
}

export function decodeBase64Url(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return decodeBase64(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
}
