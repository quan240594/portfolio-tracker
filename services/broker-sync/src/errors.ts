export const BROKER_ERROR_CODES = [
  'T212_AUTH_REJECTED',
  'T212_RATE_LIMITED',
  'T212_HTTP_ERROR',
  'T212_NETWORK',
  'T212_BAD_RESPONSE',
  'NO_CREDENTIALS',
  'VALIDATION_FAILED',
] as const;
export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

/** Shown in the CLI, in the sync state's `lastError` and in the web status card. */
export const AUTH_REJECTED_MESSAGE =
  "Trading 212 rejected the credentials. Check the key/secret, that the key has the read scopes, that the environment (live/demo) matches, and — if the key has an IP allowlist — that this machine's public IP is on it.";

/** Error whose message is safe to persist and show: it never contains credentials, headers or response bodies. */
export class BrokerError extends Error {
  constructor(
    public readonly code: BrokerErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

/** `CODE: message`, the form stored in `lastError`. Unknown errors are reduced to a generic message. */
export function describeError(err: unknown): string {
  if (err instanceof BrokerError) return `${err.code}: ${err.message}`.slice(0, 500);
  return 'INTERNAL: Sync failed unexpectedly (see the sync Lambda logs)';
}
