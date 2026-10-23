import type { AlarmStorageHost, SqlStorageLike } from '@portfolio/cloudflare';
import type { AiLike } from '@portfolio/earnings';

/** The structural slice of the Workers runtime this package uses: no Cloudflare type package, so everything runs in Node too. */
export interface HubStorage extends AlarmStorageHost {
  readonly sql: SqlStorageLike & { readonly databaseSize?: number };
}

/** `ctx` of the Hub Durable Object. */
export interface HubState {
  readonly storage: HubStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface HubStub {
  fetch(request: Request): Promise<Response>;
}

/** The Hub's `DurableObjectNamespace` binding. */
export interface HubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): HubStub;
}

/** The static assets binding. */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** Variables and secrets the Hub reads (`wrangler secret put SECRETS_KEY`; the rest are plain `vars`). */
export interface HubEnv {
  /** Base64 master key of the encrypted secret store (`generateSecretsKey()`), a Worker secret. */
  SECRETS_KEY?: string;
  /** The public origin of the app (`https://...`), also the origin of the upload URLs. */
  ORIGIN?: string;
  /** Base currency of the portfolios; defaults to EUR. */
  BASE_CURRENCY?: string;
  /** JSON object: Trading 212 ticker or ISIN -> canonical symbol. Optional. */
  T212_SYMBOL_OVERRIDES?: string;
  /**
   * Price service (all optional, see `parsePricesConfig`): provider keys are Worker secrets; a missing key switches that source
   * off and the app reports it (`GET /api/prices/status`) instead of failing.
   */
  TWELVEDATA_API_KEY?: string;
  EODHD_API_KEY?: string;
  COINGECKO_API_KEY?: string;
  ALPHAVANTAGE_API_KEY?: string;
  /**
   * Web Push (dividend notifications): `VAPID_PUBLIC_KEY` is a plain variable (65-byte uncompressed P-256 key, base64url),
   * `VAPID_PRIVATE_KEY` a Worker secret (PKCS #8, base64url; `pnpm --filter @portfolio/cloudflare-app run vapid:generate`). Both missing
   * (or either) switches the feature off: the API answers `configured: false` and the web app explains it.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Optional, comma separated: push-service hosts a subscription endpoint may use (`*.` = subdomains); defaults to the browsers' push services. */
  PUSH_ALLOWED_HOSTS?: string;
  /**
   * Earnings summaries (all optional; the feature is off until both exist): `SEC_CONTACT` is the complete User-Agent every SEC request declares
   * (name and contact information, passed at deploy time like ORIGIN, never committed), `AI` is the Workers AI binding (`"ai": { "binding": "AI" }`),
   * `EARNINGS_AI_MODEL` a Workers AI text model (default `@cf/meta/llama-3.1-8b-instruct-fp8`), `EARNINGS_AI_DAILY_NEURONS` the daily cap (default 6000, at most 8000).
   */
  SEC_CONTACT?: string;
  EARNINGS_AI_MODEL?: string;
  EARNINGS_AI_DAILY_NEURONS?: string;
  AI?: AiLike;
  /** Plain variables of the price service: `TICKER=coingecko-id` pairs, daily call budgets, EU refresh hours, FX back-fill start, calendar tuning. */
  COINGECKO_COIN_IDS?: string;
  EODHD_DAILY_LIMIT?: string;
  ALPHAVANTAGE_DAILY_LIMIT?: string;
  EU_REFRESH_HOURS?: string;
  FX_HISTORY_START?: string;
  CALENDAR_EARNINGS_HORIZON?: string;
  CALENDAR_ALPHAVANTAGE_DAILY_CALLS?: string;
  CALENDAR_EODHD_DAILY_CALLS?: string;
  CALENDAR_RECHECK_DAYS?: string;
  CALENDAR_REFRESH_DIVIDENDS?: string;
  CALENDAR_SPLIT_LOOKBACK_DAYS?: string;
  /**
   * Company logos (all optional, see `parseLogosConfig`): `LOGO_SOURCES` (comma separated, order = priority, `off` = none; default
   * `t212,logodev,google,duckduckgo`; `google,duckduckgo` switches the undocumented Trading 212 logo bucket off), `LOGO_HOURLY_LIMIT` (default 30),
   * `LOGO_NEGATIVE_TTL_DAYS` (default 7), `LOGO_T212_BASE` (an https `*.amazonaws.com` origin; `LOGO_ALLOW_ANY_HOST=1` is for tests only) and the
   * Worker secret `LOGO_DEV_TOKEN` that switches the token-based source on.
   */
  LOGO_SOURCES?: string;
  LOGO_HOURLY_LIMIT?: string;
  LOGO_NEGATIVE_TTL_DAYS?: string;
  LOGO_DEV_TOKEN?: string;
  LOGO_T212_BASE?: string;
  LOGO_ALLOW_ANY_HOST?: string;
}

/** Everything the Worker reads on top of the Hub's variables. */
export interface WorkerEnv extends HubEnv {
  HUB: HubNamespace;
  ASSETS?: AssetsBinding;
  GITHUB_CLIENT_ID?: string;
  /** Worker secret. */
  GITHUB_CLIENT_SECRET?: string;
  /** Worker secret, at least 32 characters. */
  SESSION_SECRET?: string;
  /** The numeric GitHub user id of the one owner. */
  OWNER_GITHUB_ID?: string;
}

export interface ScheduledControllerLike {
  readonly cron?: string;
  readonly scheduledTime?: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
