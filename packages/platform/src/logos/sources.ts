import { isT212Ticker } from '@portfolio/shared';
import { DEFAULT_MIN_LOGO_PIXELS, MAX_LOGO_BYTES, validateLogo, type LogoRejection, type ValidatedLogo } from './image.js';

/**
 * LogoSource: one place a company logo can be downloaded from, by public domain (or, for the Trading 212 bucket, by the Trading 212
 * ticker of the instrument). The server tries the sources in order and keeps
 * the first picture that passes the strict validation (image.ts). Sources are plain objects over `fetch`, so a new one (a service
 * with a token, a different keyless icon endpoint) is one small class, and a source that disappears only costs a fallback to the
 * next one: with none left the screens show the monogram.
 *
 * The upstream sees a public company domain (or an instrument ticker) and the IP of the server, nothing else: no cookie, no referrer,
 * no account, no list of holdings.
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

/** What a lookup knows about the holding: the public domain of the company and/or the Trading 212 ticker of the instrument. */
export interface LogoSubject {
  domain?: string;
  t212Ticker?: string;
}

export interface LogoSource {
  readonly name: string;
  /** What the source is asked by: a source is skipped (no request, no failure) for a subject without it. */
  readonly by: keyof LogoSubject;
  fetchLogo(subject: LogoSubject, options: LogoFetchOptions): Promise<LogoFetchResult>;
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
  /** `manual` hands a redirect back as a 3xx answer, which is a failure: a source with a fixed host never follows a redirect elsewhere (workerd has no `error` mode). */
  redirect?: 'follow' | 'manual';
}

const missingSubject = (source: string): Promise<LogoFetchResult> => Promise.resolve({ ok: false, reason: 'not-found', source });

/** One GET with a deadline, then the strict validation. Never throws: every outcome is a result. */
async function download({ source, url, mislabelledAs, redirect = 'follow' }: Download, options: LogoFetchOptions): Promise<LogoFetchResult> {
  const fail = (reason: LogoFailure): LogoFetchResult => ({ ok: false, reason, source });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetch(url, { method: 'GET', redirect, headers: { accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/*;q=0.5' }, signal: controller.signal });
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
  readonly by = 'domain';

  fetchLogo({ domain }: LogoSubject, options: LogoFetchOptions): Promise<LogoFetchResult> {
    if (domain === undefined) return missingSubject(this.name);
    return download({ source: this.name, url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` }, options);
  }
}

/** DuckDuckGo's icon endpoint: keyless, usually smaller icons. Its `.ico` path is known to carry PNG data under an icon content type. */
export class DuckDuckGoSource implements LogoSource {
  readonly name = 'duckduckgo';
  readonly by = 'domain';

  fetchLogo({ domain }: LogoSubject, options: LogoFetchOptions): Promise<LogoFetchResult> {
    if (domain === undefined) return missingSubject(this.name);
    return download({ source: this.name, url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`, mislabelledAs: ['image/x-icon', 'image/vnd.microsoft.icon'] }, options);
  }
}

/** A token-based logo API the owner can switch on with the Worker secret `LOGO_DEV_TOKEN`; it is never constructed without one. */
export class LogoDevSource implements LogoSource {
  readonly name = 'logodev';
  readonly by = 'domain';

  constructor(private readonly token: string) {}

  fetchLogo({ domain }: LogoSubject, options: LogoFetchOptions): Promise<LogoFetchResult> {
    if (domain === undefined) return missingSubject(this.name);
    const url = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(this.token)}&size=128&format=png&fallback=404`;
    return download({ source: this.name, url }, options);
  }
}

export const DEFAULT_T212_LOGO_BASE = 'https://trading212equities.s3.eu-central-1.amazonaws.com';
const T212_HOST_SUFFIX = '.amazonaws.com';

export interface T212BaseOptions {
  /** Tests only: lets the base point at any http(s) origin (a fake upstream). */
  allowAnyHost?: boolean;
}

const STRICT_BASE: T212BaseOptions = {};

/**
 * The base URL of the Trading 212 logo bucket, or undefined when `raw` may not be used: it must be a plain https origin (no
 * credentials, query, fragment or path) on a host ending in `.amazonaws.com`. `allowAnyHost` is for tests only.
 */
export function normalizeT212LogoBase(raw: string | undefined, { allowAnyHost = false }: T212BaseOptions = STRICT_BASE): string | undefined {
  const text = (raw ?? '').trim();
  if (text === '') return undefined;
  const url = parseUrl(text);
  if (url === undefined || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') return undefined;
  if (allowAnyHost) return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  return url.protocol === 'https:' && url.hostname.endsWith(T212_HOST_SUFFIX) ? url.origin : undefined;
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
 * The logo bucket of the Trading 212 app (`<T212 ticker>.png`, 240 px, full-bleed square, public and keyless). It is an UNDOCUMENTED
 * asset bucket, not part of the official API: it can change or disappear without notice, so it is configurable and removable
 * (`LOGO_SOURCES` without `t212`), and a miss only falls back to the domain sources and then to the monogram. The ticker is validated
 * again here and URL-encoded, and a redirect is never followed.
 */
export class Trading212LogoSource implements LogoSource {
  readonly name = 't212';
  readonly by = 't212Ticker';
  private readonly base: string;

  constructor(base: string = DEFAULT_T212_LOGO_BASE, options: T212BaseOptions = STRICT_BASE) {
    const checked = normalizeT212LogoBase(base, options);
    if (checked === undefined) throw new Error('The Trading 212 logo base must be an https amazonaws.com origin');
    this.base = checked;
  }

  fetchLogo({ t212Ticker }: LogoSubject, options: LogoFetchOptions): Promise<LogoFetchResult> {
    if (!isT212Ticker(t212Ticker)) return missingSubject(this.name);
    return download({ source: this.name, url: `${this.base}/${encodeURIComponent(t212Ticker)}.png`, redirect: 'manual' }, options);
  }
}

export const LOGO_SOURCE_NAMES = ['t212', 'logodev', 'google', 'duckduckgo'] as const;
export type LogoSourceName = (typeof LOGO_SOURCE_NAMES)[number];

export interface LogoSourceSettings {
  logoDevToken?: string;
  /** Base URL of the Trading 212 bucket (already checked by `normalizeT212LogoBase`); the default one when absent. */
  t212Base?: string;
  /** Tests only: lets `t212Base` point at a fake upstream. */
  allowAnyHost?: boolean;
}

/** The sources of `names`, in that order; `logodev` is skipped when there is no token. */
export function createLogoSources(names: readonly LogoSourceName[], settings: LogoSourceSettings = {}): LogoSource[] {
  const sources: LogoSource[] = [];
  for (const name of names) {
    if (name === 't212') sources.push(new Trading212LogoSource(settings.t212Base, { allowAnyHost: settings.allowAnyHost }));
    else if (name === 'google') sources.push(new GoogleFaviconSource());
    else if (name === 'duckduckgo') sources.push(new DuckDuckGoSource());
    else if (settings.logoDevToken !== undefined && settings.logoDevToken !== '') sources.push(new LogoDevSource(settings.logoDevToken));
  }
  return sources;
}
