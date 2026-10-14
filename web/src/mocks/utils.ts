import { delay, HttpResponse } from 'msw';
import type { ApiError } from '@portfolio/shared';
import { API_BASE_URL } from '../config';

export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Resolve handler URLs the same way the client does (relative to the page origin). */
export const api = (path: string) => `${API_BASE_URL}${path}`;

export const errorResponse = (status: number, code: string, message: string, details?: unknown): Response =>
  HttpResponse.json<ApiError>({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });

export async function latency() {
  if (import.meta.env.MODE !== 'test') await delay(150 + (crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32) * 250);
}

/** Turns thrown MockHttpErrors into API error responses. */
export function guard<T>(fn: () => T | Promise<T>) {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MockHttpError) return errorResponse(err.status, err.code, err.message, err.details);
      throw err;
    }
  };
}
