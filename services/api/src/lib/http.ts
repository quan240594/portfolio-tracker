import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ApiError } from '@portfolio/shared';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RouteResult {
  statusCode: number;
  body: unknown;
  /** When set, `body` is a string sent as-is with this content type (e.g. `text/csv`) instead of JSON. */
  contentType?: string;
  /** Extra response headers (e.g. `content-disposition` for downloads). */
  headers?: Record<string, string>;
}

export const ok = (body: unknown, statusCode = 200): RouteResult => ({ statusCode, body });

export function errorBody(code: string, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

function serializeBody(result: RouteResult): string {
  if (result.body === undefined) return '';
  return result.contentType && typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
}

export function toResponse(
  result: RouteResult,
  corsOrigin: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: result.statusCode,
    headers: {
      'content-type': result.contentType ?? 'application/json',
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-expose-headers': 'content-disposition',
      'cache-control': 'no-store',
      ...result.headers,
    },
    body: serializeBody(result),
  };
}

/** Parses a zod `safeParse` result, throwing a 400 VALIDATION_ERROR on failure. */
export function validate<T>(
  result: { success: true; data: T } | { success: false; error: { issues: unknown[] } },
  message = 'Invalid request',
): T {
  if (!result.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', message, result.error.issues);
  }
  return result.data;
}

export function parseJsonBody(body: string | undefined, isBase64Encoded?: boolean): unknown {
  if (!body) throw new HttpError(400, 'VALIDATION_ERROR', 'Request body is required');
  const raw = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
  }
}
