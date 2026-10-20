import { MAX_CLASSIFICATION_IMPORT_BYTES } from '@portfolio/shared';

/** Largest JSON body the API accepts through the Worker (the CSV upload has its own, larger limit). */
export const MAX_API_BODY_BYTES = 256 * 1024;

/** The classification import carries a whole holdings export as JSON: its own, larger limit (the API route enforces it too). */
const IMPORT_PATH = '/api/classification/import';

export function bodyLimitFor(pathname: string): number {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return path === IMPORT_PATH ? MAX_CLASSIFICATION_IMPORT_BYTES : MAX_API_BODY_BYTES;
}

function declaredLength(request: Request): number | undefined {
  const header = request.headers.get('content-length');
  if (header === null || !/^\d{1,15}$/.test(header)) return undefined;
  return Number(header);
}

/** True when the request announces a body larger than `maxBytes` (checked before a single byte is read). */
export function declaresTooLarge(request: Request, maxBytes: number): boolean {
  const length = declaredLength(request);
  return length !== undefined && length > maxBytes;
}

/**
 * Reads the request body, at most `maxBytes`. Resolves `undefined` as soon as the announced or the actual size is over the
 * limit (the rest of the stream is cancelled, never buffered); an empty body is an empty array.
 */
export async function readBodyBounded(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (declaresTooLarge(request, maxBytes)) return undefined;
  if (request.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream: the oversized remainder is never buffered.
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
