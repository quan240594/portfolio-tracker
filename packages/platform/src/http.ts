import type { PortableIdentity } from './identity.js';

/**
 * Portable HTTP contract between a platform adapter and the application. The adapter translates its native request
 * (API Gateway event, Node `IncomingMessage`, Worker `Request`) into a `PortableRequest` and the `PortableResponse`
 * back; the application never sees a native type.
 */
export interface PortableRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Raw path without the query string (still percent-encoded). */
  path: string;
  query: Record<string, string | undefined>;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** The request body as text (a base64 body is decoded by the adapter). */
  body?: string;
  /** Verified principal, when the platform authenticated the caller. */
  identity?: PortableIdentity;
  /** Correlation id for logs. */
  requestId?: string;
}

export interface PortableResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
  /** Binary body (a stored logo); when present it is sent instead of `body`. Only the Fetch adapter understands it (the AWS handlers never set it). */
  bytes?: Uint8Array;
  /** `Set-Cookie` header values, one entry per cookie (a header map cannot hold several). */
  cookies?: string[];
}

export type PortableHandler = (request: PortableRequest) => Promise<PortableResponse>;
