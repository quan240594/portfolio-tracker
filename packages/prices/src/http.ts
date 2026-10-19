import { retryAttempts } from '@portfolio/shared';
import { silentLogger, type Logger } from '@portfolio/platform';
import { asText } from './parse.js';
import { ProviderError, RateLimitError, RetryableProviderError, SubrequestBudgetError, SymbolNotFoundError } from './errors.js';

/** The `fetch` the host injects (Workers, Node, or a test double). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type Sleep = (ms: number) => Promise<void>;

const SENSITIVE_PARAMS = new Set(['apikey', 'api_key', 'api_token', 'token', 'key', 'x_cg_demo_api_key', 'access_key']);
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
export const USER_AGENT = 'portfolio-tracker-prices/0.1';

/** Replaces the values of credential-like query parameters with `***`. */
export function redactUrl(url: string): string {
  const at = url.indexOf('?');
  if (at < 0) return url;
  const query = url
    .slice(at + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      return SENSITIVE_PARAMS.has(name.toLowerCase()) ? `${name}=***` : pair;
    })
    .join('&');
  return `${url.slice(0, at)}?${query}`;
}

const encodeValue = (value: unknown): string => encodeURIComponent(typeof value === 'boolean' ? `${value}` : asText(value)).replaceAll('%2C', ',');

/** `url?k=v&...` with null/undefined values dropped; commas stay readable (`symbol=A,B`). */
export function buildUrl(url: string, params?: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(params ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeValue(value)}`);
  if (pairs.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

export interface HttpClientOptions {
  /** Provider name for error messages, e.g. `twelvedata`. */
  provider: string;
  fetch: FetchLike;
  sleep: Sleep;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** Retries after the first attempt (429, 5xx, network, timeout). Default 3. */
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Uniform random in [0, 1) for the backoff jitter (default: WebCrypto). */
  random?: () => number;
  /** Builds the signal that aborts a request after `ms` (default `AbortSignal.timeout`). */
  timeoutSignal?: (ms: number) => AbortSignal;
  logger?: Logger;
}

type Attempt = { ok: true; body: string } | { ok: false; error: ProviderError; retryAfter: string | null };

const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

/** HTTP GET with a timeout, retries with exponential backoff and jitter, and credentials redacted from every message. */
export class HttpClient {
  private readonly provider: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly random: () => number;
  private readonly timeoutSignal: (ms: number) => AbortSignal;
  private readonly logger: Logger;

  constructor(options: HttpClientOptions) {
    this.provider = options.provider;
    this.fetchImpl = options.fetch;
    this.sleep = options.sleep;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 8000;
    this.random = options.random ?? secureRandom;
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    this.logger = options.logger ?? silentLogger;
  }

  /** Milliseconds to wait before retry number `attempt` (1-based): Retry-After when numeric, else backoff with jitter. */
  backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null && retryAfter.trim() !== '') {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, this.backoffMaxMs);
    }
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1));
    return delay / 2 + this.random() * (delay / 2);
  }

  async getJson(url: string, params?: Readonly<Record<string, unknown>>, headers?: Readonly<Record<string, string>>, symbol?: string): Promise<unknown> {
    const body = await this.getText(url, params, { Accept: 'application/json', ...headers }, symbol);
    if (body === '') return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ProviderError(`${this.provider}: invalid JSON from ${redactUrl(buildUrl(url, params))}`, { provider: this.provider, symbol });
    }
  }

  async getText(url: string, params?: Readonly<Record<string, unknown>>, headers?: Readonly<Record<string, string>>, symbol?: string): Promise<string> {
    const full = buildUrl(url, params);
    const safeUrl = redactUrl(full);
    const requestHeaders = { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers };
    let last: Extract<Attempt, { ok: false }> | undefined;
    const attempts = retryAttempts((): Promise<Attempt> => this.attempt(full, requestHeaders, safeUrl, symbol), {
      maxAttempts: this.maxRetries + 1,
      delayMs: (retry) => {
        const delay = this.backoffMs(retry, last?.retryAfter ?? null);
        this.logger.warn('http retry', { provider: this.provider, url: safeUrl, attempt: retry, delayMs: Math.round(delay), error: last?.error.message });
        return delay;
      },
      sleep: this.sleep,
    });
    for await (const outcome of attempts) {
      if (outcome.ok) return outcome.body;
      last = outcome;
    }
    throw last!.error;
  }

  /** One request. Returns the body, a retryable failure, or throws the terminal ProviderError. */
  private async attempt(full: string, headers: Record<string, string>, safeUrl: string, symbol: string | undefined): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetchImpl(full, { method: 'GET', headers, signal: this.timeoutSignal(this.timeoutMs) });
    } catch (error) {
      if (error instanceof SubrequestBudgetError) throw error;
      const reason = error instanceof Error ? error.name : 'error';
      return { ok: false, retryAfter: null, error: new RetryableProviderError(`${this.provider}: network error for ${safeUrl}: ${reason}`, { provider: this.provider, symbol }) };
    }
    if (response.ok) return this.read(response, safeUrl, symbol);
    return await this.failure(response, safeUrl, symbol);
  }

  private async read(response: Response, safeUrl: string, symbol: string | undefined): Promise<Attempt> {
    try {
      return { ok: true, body: await response.text() };
    } catch {
      return { ok: false, retryAfter: null, error: new RetryableProviderError(`${this.provider}: network error for ${safeUrl}: body`, { provider: this.provider, symbol }) };
    }
  }

  private async failure(response: Response, safeUrl: string, symbol: string | undefined): Promise<Attempt> {
    const status = response.status;
    const retryAfter = response.headers.get('Retry-After');
    // Drain the body so the connection is released (Workers cap simultaneous connections).
    await response.text().catch(() => '');
    const details = { provider: this.provider, symbol, status };
    if (status === 404) throw new SymbolNotFoundError(`${this.provider}: 404 for ${safeUrl}`, details);
    const message = `${this.provider}: HTTP ${status} for ${safeUrl}`;
    if (!RETRY_STATUSES.has(status)) throw new ProviderError(message, details);
    const error = status === 429 ? new RateLimitError(message, details) : new RetryableProviderError(message, details);
    return { ok: false, error, retryAfter };
  }
}

/** A `fetch` that allows at most `limit` calls, so a step can never exceed the platform's subrequest cap. */
export interface BudgetedFetch {
  fetch: FetchLike;
  readonly limit: number;
  readonly used: () => number;
  readonly remaining: () => number;
}

export function budgetedFetch(inner: FetchLike, limit: number): BudgetedFetch {
  let used = 0;
  return {
    limit,
    fetch: (url, init) => {
      if (used >= limit) return Promise.reject(new SubrequestBudgetError(limit));
      used += 1;
      return inner(url, init);
    },
    used: () => used,
    remaining: () => Math.max(0, limit - used),
  };
}
