import { assetSymbolSchema, type ApiError } from '@portfolio/shared';
import type { PortableRequest, PortableResponse } from '../http.js';
import type { LogoOutcome, LogoService } from './service.js';
import type { StoredLogo } from './store.js';

/** A found logo is revalidated daily (a fixed domain fix shows within a day); the validator makes that a cheap 304. */
export const LOGO_CACHE_SECONDS = 86_400;
/** What a browser remembers of "no logo" before it asks again (the screens also remember it for the session). */
export const LOGO_MISSING_CACHE_SECONDS = 3600;

export interface LogoRouteOptions {
  service: LogoService;
  /** The domain to look the logo of `symbol` up by for this user (override, provider website, curated table, issuer), or undefined. */
  resolveDomain: (userId: string, symbol: string, request: PortableRequest) => Promise<string | undefined>;
  /** A fresh counted `fetch` for one lookup (the Hub budgets the outbound calls of each request). */
  fetchFor?: () => typeof fetch;
}

const PATH = /^\/logos\/([^/]+)$/;

/** An SVG opened as a page cannot run anything: no script, no network, sandboxed. */
const SVG_HARDENING = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function error(status: number, code: string, message: string, headers: Record<string, string>): PortableResponse {
  const body: ApiError = { error: { code, message } };
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

const notFound = (): PortableResponse => error(404, 'NOT_FOUND', 'No logo for this symbol', { 'cache-control': `private, max-age=${LOGO_MISSING_CACHE_SECONDS}` });

/** `"abc"`, `W/"abc"`, a comma separated list or `*`: does any of them name `etag`? */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim().replace(/^W\//, '');
    return value === '*' || value === `"${etag}"`;
  });
}

function imageResponse(logo: StoredLogo, request: PortableRequest): PortableResponse {
  const headers: Record<string, string> = {
    'cache-control': `private, max-age=${LOGO_CACHE_SECONDS}`,
    etag: `"${logo.etag}"`,
    'x-content-type-options': 'nosniff',
  };
  if (matches(request.headers['if-none-match'], logo.etag)) return { status: 304, headers, body: '' };
  return {
    status: 200,
    headers: { ...headers, 'content-type': logo.contentType, 'content-length': String(logo.bytes.length), ...(logo.contentType === 'image/svg+xml' ? { 'content-security-policy': SVG_HARDENING } : {}) },
    body: '',
    bytes: logo.bytes,
  };
}

function outcomeResponse(outcome: LogoOutcome, request: PortableRequest): PortableResponse {
  if (outcome.kind === 'found') return imageResponse(outcome.logo, request);
  if (outcome.kind === 'missing') return notFound();
  return error(429, 'LOGO_RATE_LIMITED', 'Logos are fetched slowly; try again later', { 'cache-control': 'no-store', 'retry-after': String(outcome.retryAfterSeconds) });
}

/**
 * `GET /logos/{symbol}` (the path without the `/api` prefix): the stored logo bytes of the company behind the symbol, with a long
 * private cache, an ETag and `304`; a miss is a cached `404`. The route answers `undefined` for any other request so it can sit
 * in front of the application router. Authentication, the budget and the same-origin check are the caller's, as for every API route.
 */
export function createLogoRoute(options: LogoRouteOptions): (request: PortableRequest) => Promise<PortableResponse> | undefined {
  async function serve(request: PortableRequest, symbolPart: string): Promise<PortableResponse> {
    const userId = request.identity?.subject;
    const symbol = decodeSymbol(symbolPart);
    if (userId === undefined) return error(401, 'UNAUTHENTICATED', 'Authentication required', { 'cache-control': 'no-store' });
    if (symbol === undefined) return notFound();
    const domain = await options.resolveDomain(userId, symbol, request);
    if (domain === undefined) return notFound();
    return outcomeResponse(await options.service.lookup(domain, options.fetchFor?.()), request);
  }
  return (request) => {
    const match = request.method === 'GET' ? PATH.exec(request.path) : null;
    return match ? serve(request, match[1]!) : undefined;
  };
}

function decodeSymbol(part: string): string | undefined {
  try {
    const parsed = assetSymbolSchema.safeParse(decodeURIComponent(part));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
