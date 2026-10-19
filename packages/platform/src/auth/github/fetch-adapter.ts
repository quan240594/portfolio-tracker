import type { PortableRequest, PortableResponse } from '../../http.js';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Workers/Fetch `Request` -> portable request (lower-case headers, decoded query, text body for mutations). */
export async function fetchRequestToPortable(request: Request): Promise<PortableRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await request.text() : undefined;
  return {
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    ...(body === undefined || body === '' ? {} : { body }),
  };
}

/** Portable response -> Fetch `Response`, keeping every `Set-Cookie` as its own header. */
export function portableToFetchResponse(response: PortableResponse): Response {
  const headers = new Headers(response.headers);
  for (const cookie of response.cookies ?? []) headers.append('set-cookie', cookie);
  const body = NULL_BODY_STATUSES.has(response.status) || response.body === '' ? null : response.body;
  return new Response(body, { status: response.status, headers });
}
