import type { PortableResponse } from '../../http.js';
import { constantTimeEqual } from './crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckedRequest {
  method: string;
  headers: Record<string, string | undefined> | Headers;
}

function header(request: OriginCheckedRequest, name: string): string | undefined {
  const { headers } = request;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  return (headers as Record<string, string | undefined>)[name];
}

/**
 * CSRF defence in depth next to SameSite=Lax: a state-changing request must come from `origin`. The `Origin` header
 * decides when present; otherwise only `Sec-Fetch-Site: same-origin` is accepted. Safe methods always pass.
 */
export function isSameOrigin(request: OriginCheckedRequest, origin: string): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const requestOrigin = header(request, 'origin');
  if (requestOrigin !== undefined) return constantTimeEqual(requestOrigin, origin);
  return header(request, 'sec-fetch-site') === 'same-origin';
}

/** A 403 response for a cross-origin mutation, or undefined when the request may proceed. */
export function requireSameOrigin(request: OriginCheckedRequest, origin: string): PortableResponse | undefined {
  if (isSameOrigin(request, origin)) return undefined;
  return {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: 'Forbidden: cross-origin request',
  };
}
