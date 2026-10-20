import { utf8Bytes, type Bytes } from '../encoding.js';
import { logger } from '../logger.js';
import { DEFAULT_PUSH_HOSTS, validatePushEndpoint } from './endpoint.js';
import { encryptPayload, type PushKeys } from './encrypt.js';
import { createVapidSigner, type VapidConfig, type VapidSigner } from './vapid.js';

/** A browser's push subscription as the client posts it (`PushSubscription.toJSON()`). */
export interface PushSubscriptionData {
  endpoint: string;
  keys: PushKeys;
}

export const PUSH_URGENCIES = ['very-low', 'low', 'normal', 'high'] as const;
export type PushUrgency = (typeof PUSH_URGENCIES)[number];

export interface PushOptions {
  /** Seconds the push service keeps an undelivered message (default one day, at most 28 days). */
  ttl?: number;
  urgency?: PushUrgency;
  /** Replaces a still-queued message with the same topic: at most 32 characters of the URL-safe base64 alphabet. */
  topic?: string;
}

/**
 * The outcome of one push. `gone`: the subscription no longer exists (404/410): the caller deletes it. `rate-limited`: 429, retry
 * after `retryAfterSeconds` when the service said so. `retryable`: timeouts, network errors, 5xx: try again later. `rejected`:
 * will not work as sent (bad endpoint, too large, 400/401/403, redirects): retrying the same message is pointless.
 */
export type PushResult =
  | { kind: 'ok'; status: number }
  | { kind: 'gone'; status: number }
  | { kind: 'rate-limited'; status: number; retryAfterSeconds?: number }
  | { kind: 'retryable'; reason: string; status?: number }
  | { kind: 'rejected'; reason: string; status?: number };

export type PushSender = (subscription: PushSubscriptionData, payload: object, options?: PushOptions) => Promise<PushResult>;

/** The JSON payload of one message is capped (the record holds ~4 KB; push services refuse more). */
export const MAX_PUSH_PAYLOAD_BYTES = 3584;
export const DEFAULT_PUSH_TTL_SECONDS = 24 * 3600;
export const MAX_PUSH_TTL_SECONDS = 28 * 24 * 3600;
export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

export interface PushSenderConfig {
  vapid: VapidConfig;
  /** Outbound `fetch`; on Cloudflare the alarm's counted one (every push is one subrequest). */
  fetch?: typeof fetch;
  /** Allowed push-service hosts (see `DEFAULT_PUSH_HOSTS`). */
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  /** Epoch milliseconds, for `Retry-After` dates. Defaults to the system clock. */
  now?: () => number;
}

const rejected = (reason: string, status?: number): PushResult => ({ kind: 'rejected', reason, ...(status === undefined ? {} : { status }) });
const retryable = (reason: string, status?: number): PushResult => ({ kind: 'retryable', reason, ...(status === undefined ? {} : { status }) });

/** `Retry-After`: delta-seconds or an HTTP date; undefined when absent or unusable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - nowMs) / 1000));
}

/** Maps the push service's HTTP status (RFC 8030 section 5) to a typed result. */
export function mapPushStatus(status: number, retryAfter: string | null, nowMs: number): PushResult {
  if (status >= 200 && status < 300) return { kind: 'ok', status };
  if (status === 404 || status === 410) return { kind: 'gone', status };
  if (status === 429) {
    const seconds = parseRetryAfter(retryAfter, nowMs);
    return { kind: 'rate-limited', status, ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  }
  if (status === 413) return rejected('payload-too-large', status);
  if (status >= 500 || status === 408) return retryable('push-service-error', status);
  return rejected(status >= 300 && status < 400 ? 'redirect' : 'refused', status);
}

interface ResolvedOptions {
  ttl: number;
  urgency?: PushUrgency;
  topic?: string;
}

function resolveOptions(options: PushOptions): ResolvedOptions | string {
  const ttl = options.ttl ?? DEFAULT_PUSH_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_PUSH_TTL_SECONDS) return 'invalid-ttl';
  if (options.urgency !== undefined && !PUSH_URGENCIES.includes(options.urgency)) return 'invalid-urgency';
  if (options.topic !== undefined && !TOPIC.test(options.topic)) return 'invalid-topic';
  return { ttl, ...(options.urgency === undefined ? {} : { urgency: options.urgency }), ...(options.topic === undefined ? {} : { topic: options.topic }) };
}

function requestHeaders(authorization: string, options: ResolvedOptions): Record<string, string> {
  return {
    Authorization: authorization,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttl),
    ...(options.urgency === undefined ? {} : { Urgency: options.urgency }),
    ...(options.topic === undefined ? {} : { Topic: options.topic }),
  };
}

/**
 * Web Push sender (RFC 8030 + RFC 8291 + RFC 8292) on WebCrypto and an injected `fetch`. Never logs keys, payloads or the endpoint
 * path: only the push service's host and the status.
 */
export function createPushSender(config: PushSenderConfig): PushSender {
  const doFetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const allowedHosts = config.allowedHosts ?? DEFAULT_PUSH_HOSTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  let signer: Promise<VapidSigner | undefined> | undefined;
  const getSigner = (): Promise<VapidSigner | undefined> => {
    signer ??= createVapidSigner(config.vapid).catch((error: unknown) => {
      logger.error('The VAPID keys are unusable', { reason: error instanceof Error ? error.message : 'unknown' });
      return undefined;
    });
    return signer;
  };

  return async (subscription, payload, options = {}) => {
    const endpoint = validatePushEndpoint(subscription.endpoint, allowedHosts);
    if (!endpoint.ok) return rejected('invalid-endpoint');
    const body = utf8Bytes(JSON.stringify(payload));
    if (body.length > MAX_PUSH_PAYLOAD_BYTES) return rejected('payload-too-large');
    const resolved = resolveOptions(options);
    if (typeof resolved === 'string') return rejected(resolved);
    const vapid = await getSigner();
    if (vapid === undefined) return rejected('vapid-not-usable');
    let encrypted: Bytes;
    try {
      encrypted = await encryptPayload(body, subscription.keys);
    } catch {
      return rejected('invalid-subscription-keys');
    }
    const { host, origin } = endpoint.url;
    const headers = requestHeaders(await vapid.authorization(origin), resolved);
    try {
      // A redirect would send the encrypted body (and the VAPID header) somewhere the allow-list never vetted.
      const response = await doFetch(endpoint.url.toString(), { method: 'POST', headers, body: encrypted, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel().catch(() => undefined);
      const result = mapPushStatus(response.status, response.headers.get('retry-after'), (config.now ?? Date.now)());
      logger.info('Push request finished', { host, status: response.status, result: result.kind });
      return result;
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      logger.warn('Push request failed', { host, reason: timedOut ? 'timeout' : 'network' });
      return retryable(timedOut ? 'timeout' : 'network');
    }
  };
}
