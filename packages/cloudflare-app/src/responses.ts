import type { ApiError } from '@portfolio/shared';

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** The API's standard error envelope. */
export function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return jsonResponse(status, body, headers);
}
