import type { AlarmStorageHost, SqlStorageLike } from '@portfolio/cloudflare';

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
