/**
 * Strict validation of a downloaded logo. The server only keeps bytes that really are a small raster or vector image of one of the
 * four allowed types: the declared content type must be allowed, the bytes must be of that type (a page of HTML served as an image
 * is refused by its first bytes), the picture must not be a generic placeholder (by size or by the hash of a known default icon),
 * and the whole file must stay under the size cap. Nothing is rewritten or stripped: what passes is stored and served unchanged.
 */

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/** The cap of one stored logo (an icon of 128 px is far below it); bigger files are refused before they are stored. */
export const MAX_LOGO_BYTES = 40_000;
/** Pictures narrower or lower than this are favicons, not logos: a service answers them when it has nothing better. */
export const DEFAULT_MIN_LOGO_PIXELS = 32;

export interface ImageInfo {
  type: LogoType;
  /** Pixels; absent for a vector image. */
  width?: number;
  height?: number;
}

export type LogoRejection = 'content-type' | 'not-an-image' | 'type-mismatch' | 'too-small' | 'placeholder' | 'unsafe-svg' | 'too-large' | 'empty';

export interface ValidatedLogo {
  bytes: Uint8Array;
  contentType: LogoType;
  width?: number;
  height?: number;
}

export interface LogoValidationOptions {
  maxBytes: number;
  minPixels: number;
  /** Hex SHA-256 of the exact bytes of a service's generic "no icon" picture. */
  placeholderHashes: ReadonlySet<string>;
  /** Other content types a source is known to put on real pictures (for instance `image/x-icon` on PNG data); the bytes decide the type. */
  mislabelledAs?: readonly string[];
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Uint8Array, start: number, end: number): string => String.fromCodePoint(...bytes.subarray(start, end));
const u16be = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number): number => u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const u32be = (bytes: Uint8Array, at: number): number => u16be(bytes, at) * 65_536 + u16be(bytes, at + 2);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function pngInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length < 24 || !startsWith(bytes, PNG_SIGNATURE) || ascii(bytes, 12, 16) !== 'IHDR') return undefined;
  return { type: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** Start-of-frame markers carry the size; C4 (huffman table), C8 (reserved) and CC (arithmetic conditioning) do not. */
const isFrameMarker = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (isFrameMarker(marker)) return { type: 'image/jpeg', height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    at += 2 + u16be(bytes, at + 2);
  }
  return undefined;
}

function webpInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') return undefined;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = u16le(bytes, 21) | (u16le(bytes, 23) << 16);
    return { type: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return { type: 'image/webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  return undefined;
}

const SVG_ROOT = /^<svg[\s>]/i;
const SVG_DOCTYPE = /^<!doctype svg/i;
const ACTIVE_SVG = /<script|<foreignobject|<iframe|<embed|<object|javascript:|\son[a-z]+\s*=/i;
const MAX_PROLOGUE_ITEMS = 6;

/** The end of the prologue item (XML declaration, comment or SVG doctype) `text` starts with, or -1 when it starts with something else. */
function prologueEnd(text: string): number {
  if (text.startsWith('<?xml')) return text.indexOf('?>') === -1 ? -1 : text.indexOf('?>') + 2;
  if (text.startsWith('<!--')) return text.indexOf('-->') === -1 ? -1 : text.indexOf('-->') + 3;
  if (SVG_DOCTYPE.test(text)) return text.indexOf('>') + 1 || -1;
  return -1;
}

/** An SVG document: after an optional XML declaration, comments and SVG doctype the root element is `<svg`. Anything else (HTML with an inline svg) is not one. */
function svgInfo(bytes: Uint8Array): ImageInfo | undefined | 'unsafe' {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '').trimStart();
  for (let item = 0; item < MAX_PROLOGUE_ITEMS; item++) {
    const end = prologueEnd(text);
    if (end === -1) break;
    text = text.slice(end).trimStart();
  }
  if (!SVG_ROOT.test(text)) return undefined;
  return ACTIVE_SVG.test(text) ? 'unsafe' : { type: 'image/svg+xml' };
}

/** What the bytes are, whatever the server declared: PNG, JPEG, WebP or SVG with their pixel size, or undefined (HTML, ICO, anything else). */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined | 'unsafe-svg' {
  const raster = pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
  if (raster !== undefined) return raster;
  const vector = svgInfo(bytes);
  return vector === 'unsafe' ? 'unsafe-svg' : vector;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const baseType = (header: string | null): string => (header ?? '').split(';')[0]!.trim().toLowerCase();

const isLogoType = (value: string): value is LogoType => (LOGO_TYPES as readonly string[]).includes(value);

/** The verdict on one download: the bytes to keep or why they are refused. `contentTypeHeader` is the header as the server sent it. */
export async function validateLogo(bytes: Uint8Array, contentTypeHeader: string | null, options: LogoValidationOptions): Promise<{ ok: true; logo: ValidatedLogo } | { ok: false; reason: LogoRejection }> {
  const declared = baseType(contentTypeHeader);
  const declaredOk = isLogoType(declared);
  if (!declaredOk && !(options.mislabelledAs ?? []).includes(declared)) return { ok: false, reason: 'content-type' };
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > options.maxBytes) return { ok: false, reason: 'too-large' };
  const info = sniffImage(bytes);
  if (info === 'unsafe-svg') return { ok: false, reason: 'unsafe-svg' };
  if (info === undefined) return { ok: false, reason: 'not-an-image' };
  // A mislabelled picture is only trusted when it is a raster picture; the bytes, not the label, decide the stored type.
  if (declaredOk ? declared !== info.type : info.type === 'image/svg+xml') return { ok: false, reason: 'type-mismatch' };
  if (info.width !== undefined && info.height !== undefined && Math.min(info.width, info.height) < options.minPixels) return { ok: false, reason: 'too-small' };
  if (options.placeholderHashes.has(await sha256Hex(bytes))) return { ok: false, reason: 'placeholder' };
  return { ok: true, logo: { bytes, contentType: info.type, ...(info.width === undefined ? {} : { width: info.width, height: info.height }) } };
}
