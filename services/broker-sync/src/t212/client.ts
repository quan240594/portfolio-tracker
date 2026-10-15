import { T212_BASE_URLS, paginate, retryAttempts, type Trading212Credentials } from '@portfolio/shared';
import type { z } from 'zod';
import { AUTH_REJECTED_MESSAGE, BrokerError } from '../errors.js';
import { redact } from '../redact.js';
import {
  accountSummarySchema,
  cashTransactionSchema,
  dividendSchema,
  exchangeSchema,
  historicalOrderSchema,
  pageSchema,
  positionSchema,
  tradableInstrumentSchema,
  type AccountSummary,
  type CashTransaction,
  type Exchange,
  type HistoricalOrder,
  type HistoryDividend,
  type OpenPosition,
  type TradableInstrument,
} from './schemas.js';

/** One page of validated items; `invalid` counts records that did not match the expected shape. */
export interface Page<T> {
  items: T[];
  invalid: number;
}

/** What the sync needs from Trading 212 (read-only). Implemented by Trading212Client and by test fakes. */
export interface Trading212Api {
  accountSummary(): Promise<AccountSummary>;
  /** Open positions (used to reconcile the imported transactions). */
  positions(): Promise<Page<OpenPosition>>;
  /** Newest first. */
  historyOrders(): AsyncGenerator<Page<HistoricalOrder>, void, undefined>;
  historyDividends(): AsyncGenerator<Page<HistoryDividend>, void, undefined>;
  /** Newest first. The endpoint only accepts `time` together with a `cursor`, so there is no start-time filter. */
  historyTransactions(): AsyncGenerator<Page<CashTransaction>, void, undefined>;
  instruments(): Promise<TradableInstrument[]>;
  exchanges(): Promise<Exchange[]>;
}

export interface ClientOptions {
  credentials: Trading212Credentials;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Uniform [0, 1) used for backoff jitter. */
  random?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Longest single wait (rate-limit reset or backoff). */
  maxWaitMs?: number;
  maxPages?: number;
  /** Diagnostics hook (endpoint path, status, rate-limit headers, waits); never receives credentials or bodies. */
  onEvent?: (event: ClientEvent) => void;
}

export interface ClientEvent {
  endpoint: string;
  status?: number;
  remaining?: string | null;
  limit?: string | null;
  resetInMs?: number;
  waitMs?: number;
}

const API_PREFIX = '/api/v0/equity/';
const PAGE_LIMIT = 50;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const secureRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `x-ratelimit-reset` as an absolute time in ms. Trading 212 sends a Unix timestamp in seconds; a small value is
 * interpreted as "seconds from now" so either reading of the header keeps the client within its limits.
 */
export function resetAt(header: string | null, now: number): number | undefined {
  const n = Number(header);
  if (header === null || header.trim() === '' || !Number.isFinite(n) || n < 0) return undefined;
  if (n > 1e12) return n;
  return n > 1e9 ? n * 1000 : now + n * 1000;
}

export class Trading212Client implements Trading212Api {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;
  private readonly maxPages: number;
  /** Per endpoint: earliest time (ms) the next call is allowed, from `x-ratelimit-remaining: 0`. */
  private readonly notBefore = new Map<string, number>();

  constructor(private readonly options: ClientOptions) {
    const { apiKey, apiSecret, environment } = options.credentials;
    this.origin = T212_BASE_URLS[environment];
    const token = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    this.authorization = `Basic ${token}`;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? secureRandom;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxWaitMs = options.maxWaitMs ?? 70_000;
    this.maxPages = options.maxPages ?? 500;
  }

  accountSummary(): Promise<AccountSummary> {
    return this.get(`${API_PREFIX}account/summary`, accountSummarySchema);
  }

  positions(): Promise<Page<OpenPosition>> {
    return this.list(`${API_PREFIX}positions`, positionSchema);
  }

  historyOrders() {
    return this.pages(`${API_PREFIX}history/orders?limit=${PAGE_LIMIT}`, historicalOrderSchema);
  }

  historyDividends() {
    return this.pages(`${API_PREFIX}history/dividends?limit=${PAGE_LIMIT}`, dividendSchema);
  }

  historyTransactions() {
    return this.pages(`${API_PREFIX}history/transactions?limit=${PAGE_LIMIT}`, cashTransactionSchema);
  }

  async instruments(): Promise<TradableInstrument[]> {
    return (await this.list(`${API_PREFIX}metadata/instruments`, tradableInstrumentSchema)).items;
  }

  async exchanges(): Promise<Exchange[]> {
    return (await this.list(`${API_PREFIX}metadata/exchanges`, exchangeSchema)).items;
  }

  private async get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
    const parsed = schema.safeParse(await this.request(path));
    if (!parsed.success) throw new BrokerError('T212_BAD_RESPONSE', `Unexpected response shape from ${path.split('?')[0]}`);
    return parsed.data;
  }

  private async list<S extends z.ZodTypeAny>(path: string, schema: S): Promise<Page<z.output<S>>> {
    const body = await this.request(path);
    if (!Array.isArray(body)) throw new BrokerError('T212_BAD_RESPONSE', `Unexpected response shape from ${path.split('?')[0]}`);
    return validateItems(body, schema);
  }

  private async *pages<S extends z.ZodTypeAny>(firstPath: string, schema: S): AsyncGenerator<Page<z.output<S>>, void, undefined> {
    let fetched = 0;
    // The cursor is the raw `nextPagePath`; it is validated when the following page is requested, i.e. after the previous page was yielded.
    const pages = paginate<Page<z.output<S>>, string>(async (cursor) => {
      const path = cursor === undefined ? firstPath : this.nextPath(cursor);
      if (fetched++ >= this.maxPages) throw new BrokerError('T212_BAD_RESPONSE', 'Pagination did not terminate');
      const envelope = pageSchema.safeParse(await this.request(path));
      if (!envelope.success) throw new BrokerError('T212_BAD_RESPONSE', `Unexpected response shape from ${path.split('?')[0]}`);
      return { page: validateItems(envelope.data.items, schema), next: envelope.data.nextPagePath || undefined };
    });
    yield* pages;
  }

  /** `nextPagePath` must stay on the API host and under the equity API; anything else is not followed. */
  private nextPath(nextPagePath: string): string {
    const url = new URL(nextPagePath, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith(API_PREFIX)) {
      throw new BrokerError('T212_BAD_RESPONSE', 'Unexpected pagination link');
    }
    return `${url.pathname}${url.search}`;
  }

  private async request(path: string): Promise<unknown> {
    const endpoint = path.split('?')[0]!;
    let lastError = new BrokerError('T212_NETWORK', 'Could not reach Trading 212 (no attempt was made)');
    let rateLimitWaitMs: number | undefined;
    const attempts = retryAttempts(
      async () => {
        await this.waitForLimit(endpoint);
        return this.attempt(path, endpoint);
      },
      {
        maxAttempts: this.maxAttempts,
        delayMs: (retry) => Math.min(rateLimitWaitMs ?? this.backoff(retry - 1), this.maxWaitMs),
        sleep: (waitMs) => {
          this.options.onEvent?.({ endpoint, waitMs });
          return this.sleep(waitMs);
        },
      },
    );
    for await (const outcome of attempts) {
      if (outcome.done) return outcome.body;
      lastError = outcome.error;
      rateLimitWaitMs = outcome.waitMs;
    }
    throw lastError;
  }

  private async waitForLimit(endpoint: string): Promise<void> {
    const wait = (this.notBefore.get(endpoint) ?? 0) - this.now();
    if (wait > 0) {
      this.options.onEvent?.({ endpoint, waitMs: wait });
      await this.sleep(Math.min(wait, this.maxWaitMs));
    }
  }

  private backoff(attempt: number): number {
    return Math.min(500 * 2 ** attempt, 8000) * (0.5 + this.random() / 2);
  }

  private async attempt(path: string, endpoint: string): Promise<{ done: true; body: unknown } | { done: false; error: BrokerError; waitMs?: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.origin}${path}`, {
        method: 'GET',
        headers: { authorization: this.authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'error';
      return { done: false, error: new BrokerError('T212_NETWORK', `Could not reach Trading 212 (${reason})`) };
    }
    const reset = resetAt(res.headers.get('x-ratelimit-reset'), this.now());
    this.options.onEvent?.({
      endpoint,
      status: res.status,
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
      ...(reset === undefined ? {} : { resetInMs: reset - this.now() }),
    });
    if (res.headers.get('x-ratelimit-remaining') === '0' && reset !== undefined) this.notBefore.set(endpoint, reset);

    if (res.ok) return this.readBody(res);
    if (res.status === 401 || res.status === 403) throw new BrokerError('T212_AUTH_REJECTED', AUTH_REJECTED_MESSAGE, res.status);
    if (!RETRYABLE.has(res.status)) throw new BrokerError('T212_HTTP_ERROR', await this.describe(res, endpoint), res.status);
    const code = res.status === 429 ? 'T212_RATE_LIMITED' : 'T212_HTTP_ERROR';
    const waitMs = res.status === 429 && reset !== undefined ? Math.max(reset - this.now(), 1000) : undefined;
    return { done: false, error: new BrokerError(code, `Trading 212 answered HTTP ${res.status} for ${endpoint}`, res.status), ...(waitMs === undefined ? {} : { waitMs }) };
  }

  private async readBody(res: Response): Promise<{ done: true; body: unknown } | { done: false; error: BrokerError }> {
    try {
      return { done: true, body: await res.json() };
    } catch {
      return { done: false, error: new BrokerError('T212_BAD_RESPONSE', 'Trading 212 returned a body that is not JSON', res.status) };
    }
  }

  private async describe(res: Response, endpoint: string): Promise<string> {
    const text = await res.text().catch(() => '');
    const detail = redact(text.slice(0, 200), this.options.credentials).trim();
    const suffix = detail ? `: ${detail}` : '';
    return `Trading 212 answered HTTP ${res.status} for ${endpoint}${suffix}`;
  }
}

function validateItems<S extends z.ZodTypeAny>(raw: readonly unknown[], schema: S): Page<z.output<S>> {
  const items: z.output<S>[] = [];
  let invalid = 0;
  for (const entry of raw) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) items.push(parsed.data);
    else invalid++;
  }
  return { items, invalid };
}
