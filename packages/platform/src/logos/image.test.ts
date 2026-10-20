import { describe, expect, it } from 'vitest';
import { MAX_LOGO_BYTES, sha256Hex, sniffImage, validateLogo, type LogoValidationOptions } from './image.js';
import { htmlBytes, jpegBytes, pngBytes, svgBytes, webpBytes } from '../testing/logo-fixtures.js';

const options: LogoValidationOptions = { maxBytes: MAX_LOGO_BYTES, minPixels: 32, placeholderHashes: new Set() };
const verdict = (bytes: Uint8Array, type: string | null, extra: Partial<LogoValidationOptions> = {}) => validateLogo(bytes, type, { ...options, ...extra });

describe('sniffImage', () => {
  it('reads the size of each raster type', () => {
    expect(sniffImage(pngBytes(120, 64))).toEqual({ type: 'image/png', width: 120, height: 64 });
    expect(sniffImage(jpegBytes(200, 100))).toEqual({ type: 'image/jpeg', width: 200, height: 100 });
    expect(sniffImage(webpBytes(90, 70, 'VP8X'))).toEqual({ type: 'image/webp', width: 90, height: 70 });
    expect(sniffImage(webpBytes(90, 70, 'VP8L'))).toEqual({ type: 'image/webp', width: 90, height: 70 });
    expect(sniffImage(webpBytes(90, 70, 'VP8 '))).toEqual({ type: 'image/webp', width: 90, height: 70 });
  });

  it('recognises an svg document, with or without a prologue, and has no pixel size for it', () => {
    expect(sniffImage(svgBytes())).toEqual({ type: 'image/svg+xml' });
    expect(sniffImage(svgBytes('', '\uFEFF  <?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "x" "y">\n'))).toEqual({ type: 'image/svg+xml' });
  });

  it('refuses html, text, an unterminated prologue and truncated or odd headers', () => {
    expect(sniffImage(htmlBytes())).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<!-- never closed <svg>'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<!DOCTYPE svg <svg>'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<!DOCTYPE html><svg></svg>'))).toBeUndefined();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(sniffImage(new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(sniffImage(Uint8Array.from([...jpegBytes().subarray(0, 4)]))).toBeUndefined();
    const riff = Uint8Array.from(webpBytes());
    riff.set([0x58, 0x58, 0x58, 0x58], 12);
    expect(sniffImage(riff)).toBeUndefined();
    const unsupportedLossless = Uint8Array.from(webpBytes(8, 8, 'VP8L'));
    unsupportedLossless[20] = 0;
    expect(sniffImage(unsupportedLossless)).toBeUndefined();
  });

  it('skips markers that do not carry the size in a jpeg', () => {
    const huffman = [0xff, 0xc4, 0x00, 0x04, 0, 0];
    const padded = jpegBytes(64, 48);
    const bytes = Uint8Array.from([...padded.subarray(0, 2), ...huffman, 0xff, 0xff, ...padded.subarray(2)]);
    expect(sniffImage(bytes)).toEqual({ type: 'image/jpeg', width: 64, height: 48 });
  });

  it('flags an svg with script, event handlers, foreign objects or javascript links as unsafe', () => {
    for (const body of ['<script>alert(1)</script>', '<rect onload="x()"/>', '<foreignObject><div/></foreignObject>', '<a href="javascript:alert(1)"/>', '<iframe src="x"/>']) {
      expect(sniffImage(svgBytes(body))).toBe('unsafe-svg');
    }
  });
});

describe('validateLogo', () => {
  it('accepts each allowed type and stores the type of the bytes', async () => {
    expect(await verdict(pngBytes(), 'image/png')).toEqual({ ok: true, logo: expect.objectContaining({ contentType: 'image/png', width: 128, height: 128 }) });
    expect(await verdict(jpegBytes(), 'IMAGE/JPEG; charset=binary')).toMatchObject({ ok: true });
    expect(await verdict(webpBytes(), 'image/webp')).toMatchObject({ ok: true });
    expect(await verdict(svgBytes(), 'image/svg+xml')).toEqual({ ok: true, logo: expect.objectContaining({ contentType: 'image/svg+xml' }) });
  });

  it.each([
    ['text/html', htmlBytes(), 'content-type'],
    [null, pngBytes(), 'content-type'],
    ['image/gif', pngBytes(), 'content-type'],
    ['image/x-icon', pngBytes(), 'content-type'],
    ['image/png', htmlBytes(), 'not-an-image'],
    ['image/png', jpegBytes(), 'type-mismatch'],
    ['image/svg+xml', pngBytes(), 'type-mismatch'],
    ['image/png', pngBytes(16, 16), 'too-small'],
    ['image/png', pngBytes(128, 31), 'too-small'],
    ['image/png', new Uint8Array(), 'empty'],
    ['image/png', pngBytes(128, 128, MAX_LOGO_BYTES), 'too-large'],
    ['image/svg+xml', svgBytes('<script/>'), 'unsafe-svg'],
  ] as const)('refuses %s: %s', async (type, bytes, reason) => {
    expect(await verdict(bytes, type)).toEqual({ ok: false, reason });
  });

  it('accepts a vector image whatever its size', async () => {
    expect(await verdict(svgBytes(), 'image/svg+xml', { minPixels: 4096 })).toMatchObject({ ok: true });
  });

  it('refuses the exact bytes of a known placeholder, and only those', async () => {
    const placeholder = pngBytes(64, 64, 5);
    const hashes = new Set([await sha256Hex(placeholder)]);
    expect(await verdict(placeholder, 'image/png', { placeholderHashes: hashes })).toEqual({ ok: false, reason: 'placeholder' });
    expect(await verdict(pngBytes(64, 64, 6), 'image/png', { placeholderHashes: hashes })).toMatchObject({ ok: true });
  });

  it('trusts a mislabelled content type only for the listed labels and only for raster bytes', async () => {
    const mislabelled = { mislabelledAs: ['image/x-icon'] };
    expect(await verdict(pngBytes(), 'image/x-icon', mislabelled)).toEqual({ ok: true, logo: expect.objectContaining({ contentType: 'image/png' }) });
    expect(await verdict(pngBytes(), 'image/vnd.microsoft.icon', mislabelled)).toEqual({ ok: false, reason: 'content-type' });
    expect(await verdict(svgBytes(), 'image/x-icon', mislabelled)).toEqual({ ok: false, reason: 'type-mismatch' });
    expect(await verdict(htmlBytes(), 'image/x-icon', mislabelled)).toEqual({ ok: false, reason: 'not-an-image' });
  });
});
