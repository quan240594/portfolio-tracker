import { DEFAULT_MIN_LOGO_PIXELS, MAX_LOGO_BYTES, validateLogo, type LogoRejection, type ValidatedLogo } from './image.js';

/**
 * LogoSource: one place a company logo can be downloaded from, by public domain. The server tries the sources in order and keeps
 * the first picture that passes the strict validation (image.ts). Sources are plain objects over `fetch`, so a new one (a service
 * with a token, a different keyless icon endpoint) is one small class, and a source that disappears only costs a fallback to the
 * next one: with none left the screens show the monogram.
 *
 * The upstream sees a public company domain and the IP of the server, nothing else: no cookie, no referrer, no account, no list of holdings.
 */
export type LogoFailure = LogoRejection | 'not-found' | 'http-error' | 'timeout' | 'network';

export type LogoFetchResult = { ok: true; logo: ValidatedLogo; source: string } | { ok: false; reason: LogoFailure; source: string };

export interface LogoFetchOptions {
  fetch: typeof fetch;
  /** Per source, covering the body download too. */
  timeoutMs: number;
  maxBytes?: number;
  minPixels?: number;
  placeholderHashes?: ReadonlySet<string>;
}

export interface LogoSource {
  readonly name: string;
  fetchLogo(domain: string, options: LogoFetchOptions): Promise<LogoFetchResult>;
}

export const DEFAULT_LOGO_TIMEOUT_MS = 4000;
const NO_HASHES: ReadonlySet<string> = new Set();

/** Reads at most `max` + 1 bytes, so an oversize body is noticed without being downloaded in full; a body that stalls ends with the deadline. */
async function readCapped(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array | 'too-large'> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return 'too-large';
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const deadline = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('The logo download timed out', 'AbortError')), { once: true }));
  deadline.catch(() => undefined);
  const chunks = await collectChunks(reader, deadline, max);
  if (chunks === 'too-large') return chunks;
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** Reads the stream chunk by chunk (a handful for an icon) until it ends, or 'too-large' once `max` bytes are exceeded. */
async function collectChunks(reader: ReadableStreamDefaultReader<Uint8Array>, deadline: Promise<never>, max: number, chunks: Uint8Array[] = [], size = 0): Promise<Uint8Array[] | 'too-large'> {
  const part = await Promise.race([reader.read(), deadline]);
  if (part.done) return chunks;
  if (size + part.value.length > max) {
    await reader.cancel();
    return 'too-large';
  }
  return collectChunks(reader, deadline, max, [...chunks, part.value], size + part.value.length);
}

interface Download {
  source: string;
  url: string;
  mislabelledAs?: readonly string[];
}

/** One GET with a deadline, then the strict validation. Never throws: every outcome is a result. */
async function download({ source, url, mislabelledAs }: Download, options: LogoFetchOptions): Promise<LogoFetchResult> {
  const fail = (reason: LogoFailure): LogoFetchResult => ({ ok: false, reason, source });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetch(url, { method: 'GET', redirect: 'follow', headers: { accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/*;q=0.5' }, signal: controller.signal });
    if (response.status === 404 || response.status === 410) return fail('not-found');
    if (!response.ok) return fail('http-error');
    const maxBytes = options.maxBytes ?? MAX_LOGO_BYTES;
    const bytes = await readCapped(response, maxBytes, controller.signal);
    if (bytes === 'too-large') return fail('too-large');
    const verdict = await validateLogo(bytes, response.headers.get('content-type'), {
      maxBytes,
      minPixels: options.minPixels ?? DEFAULT_MIN_LOGO_PIXELS,
      placeholderHashes: options.placeholderHashes ?? NO_HASHES,
      mislabelledAs,
    });
    return verdict.ok ? { ok: true, logo: verdict.logo, source } : fail(verdict.reason);
  } catch (error) {
    return fail(controller.signal.aborted || (error instanceof Error && error.name === 'AbortError') ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Google's favicon service: up to 128 px, keyless. Answers a small globe when it has nothing, which the size check and `placeholderHashes` refuse. */
export class GoogleFaviconSource implements LogoSource {
  readonly name = 'google';

  fetchLogo(domain: string, options: LogoFetchOptions): Promise<LogoFetchResult> {
    return download({ source: this.name, url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` }, options);
  }
}

/** DuckDuckGo's icon endpoint: keyless, usually smaller icons. Its `.ico` path is known to carry PNG data under an icon content type. */
export class DuckDuckGoSource implements LogoSource {
  readonly name = 'duckduckgo';

  fetchLogo(domain: string, options: LogoFetchOptions): Promise<LogoFetchResult> {
    return download({ source: this.name, url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`, mislabelledAs: ['image/x-icon', 'image/vnd.microsoft.icon'] }, options);
  }
}

/** A token-based logo API the owner can switch on with the Worker secret `LOGO_DEV_TOKEN`; it is never constructed without one. */
export class LogoDevSource implements LogoSource {
  readonly name = 'logodev';

  constructor(private readonly token: string) {}

  fetchLogo(domain: string, options: LogoFetchOptions): Promise<LogoFetchResult> {
    const url = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(this.token)}&size=128&format=png&fallback=404`;
    return download({ source: this.name, url }, options);
  }
}

export const LOGO_SOURCE_NAMES = ['logodev', 'google', 'duckduckgo'] as const;
export type LogoSourceName = (typeof LOGO_SOURCE_NAMES)[number];

/** The sources of `names`, in that order; `logodev` is skipped when there is no token. */
export function createLogoSources(names: readonly LogoSourceName[], logoDevToken?: string): LogoSource[] {
  const sources: LogoSource[] = [];
  for (const name of names) {
    if (name === 'google') sources.push(new GoogleFaviconSource());
    else if (name === 'duckduckgo') sources.push(new DuckDuckGoSource());
    else if (logoDevToken !== undefined && logoDevToken !== '') sources.push(new LogoDevSource(logoDevToken));
  }
  return sources;
}
