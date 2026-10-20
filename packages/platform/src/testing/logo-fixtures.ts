/** Byte builders for logo tests: the smallest files each image type's header needs (the sizes are real, the picture data is filler). */

const text = (value: string): number[] => Array.from(value, (char) => char.codePointAt(0)!);
const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [...le16(value), (value >>> 16) & 0xff];

/** A PNG header of `width` x `height` followed by `padding` filler bytes. */
export function pngBytes(width = 128, height = 128, padding = 40): Uint8Array {
  return Uint8Array.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...new Array<number>(padding).fill(7)]);
}

export function jpegBytes(width = 128, height = 128, padding = 20): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x0b, 8, (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...frame, ...new Array<number>(padding).fill(0)]);
}

export type WebpKind = 'VP8X' | 'VP8L' | 'VP8 ';

export function webpBytes(width = 128, height = 128, kind: WebpKind = 'VP8X'): Uint8Array {
  const head = [...text('RIFF'), 0, 0, 0, 0, ...text('WEBP'), ...text(kind), 0, 0, 0, 0];
  if (kind === 'VP8X') return Uint8Array.from([...head, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), 0, 0]);
  if (kind === 'VP8L') {
    const bits = (width - 1) | ((height - 1) << 14);
    return Uint8Array.from([...head, 0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0, 0]);
  }
  return Uint8Array.from([...head, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);
}

export const svgBytes = (body = '<circle cx="8" cy="8" r="8"/>', prologue = ''): Uint8Array => new TextEncoder().encode(`${prologue}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`);

export const htmlBytes = (): Uint8Array => new TextEncoder().encode('<!doctype html><html><body><svg></svg>Sign in</body></html>');

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A `fetch` answering by URL substring; unmatched URLs are 404. Records the requests. */
export function fakeFetch(routes: Readonly<Record<string, (signal?: AbortSignal | null) => Response | Promise<Response>>>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push(url);
    const route = Object.entries(routes).find(([part]) => url.includes(part));
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(route[1](init?.signal));
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

export const imageResponse = (bytes: Uint8Array, contentType: string, headers: Record<string, string> = {}): Response =>
  new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'content-type': contentType, ...headers } });

/** A response that never comes: the promise only ends when the request is aborted (the source's timeout). */
export const hangingResponse = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
