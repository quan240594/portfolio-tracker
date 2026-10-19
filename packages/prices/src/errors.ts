export interface ProviderErrorDetails {
  provider?: string;
  symbol?: string;
  status?: number;
  /** Milliseconds after which the call may be retried (rate limits). */
  retryAfterMs?: number;
}

const NO_DETAILS: ProviderErrorDetails = {};

/** Base of every error a market-data provider raises. `retryable` tells a job whether to try the symbol again later. */
export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly provider: string;
  readonly symbol?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, details: ProviderErrorDetails = NO_DETAILS) {
    super(message);
    this.provider = details.provider ?? '';
    this.symbol = details.symbol;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  get retryable(): boolean {
    return false;
  }
}

/** Throttling (429 / quota), 5xx or a network failure. */
export class RetryableProviderError extends ProviderError {
  override name = 'RetryableProviderError';

  override get retryable(): boolean {
    return true;
  }
}

/** Provider or client-side quota exhausted. */
export class RateLimitError extends RetryableProviderError {
  override name = 'RateLimitError';
}

/** The provider does not know the symbol (not retryable). */
export class SymbolNotFoundError extends ProviderError {
  override name = 'SymbolNotFoundError';
}

/** No provider is configured for this symbol (e.g. no API key). Not retryable. */
export class ProviderUnavailableError extends ProviderError {
  override name = 'ProviderUnavailableError';
}

/**
 * Raised by the budgeted `fetch` when a step has used its subrequests. It is not a ProviderError on purpose: the unit of
 * work that hit it is unfinished (nothing was stored) and runs again in the next step.
 */
export class SubrequestBudgetError extends Error {
  override name = 'SubrequestBudgetError';

  constructor(readonly limit: number) {
    super(`Subrequest budget of ${limit} exhausted for this step`);
  }
}

export const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
