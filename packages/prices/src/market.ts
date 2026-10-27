import { silentLogger, type CorporateActionsSource, type EarningsSource, type ItemStore, type Logger } from '@portfolio/platform';
import { alphaVantageGeneralLimit, type PricesConfig } from './config.js';
import { HttpClient, type FetchLike, type Sleep } from './http.js';
import { BlockBook, DailyQuota, MinuteQuota, ProviderGate, StorePlanMemory, StoreQuotaLedger, TokenBucket } from './limits.js';
import { AlphaVantageProvider } from './providers/alphavantage.js';
import { AlphaVantageEarnings, EodhdCorporateActions } from './providers/calendar.js';
import { CoinGeckoProvider } from './providers/coingecko.js';
import { EodhdProvider } from './providers/eodhd.js';
import { FrankfurterFx } from './providers/frankfurter.js';
import { RoutingProvider } from './providers/routing.js';
import type { FxSource, PriceSource } from './providers/base.js';
import { TWELVEDATA_CREDITS_PER_MINUTE, TwelveDataProvider } from './providers/twelvedata.js';
import { utcDay } from './time.js';

/** What every provider needs from the host: all of it injected, nothing read from a global. */
export interface MarketDataDeps {
  store: ItemStore;
  fetch: FetchLike;
  clock: () => Date;
  sleep: Sleep;
  config: PricesConfig;
  logger?: Logger;
  /** Uniform random in [0, 1) for the retry jitter (default: WebCrypto). */
  random?: () => number;
  /** Per-request timeout in milliseconds (default 10 s). */
  timeoutMs?: number;
  /** Builds the signal that aborts a request (default `AbortSignal.timeout`). */
  timeoutSignal?: (ms: number) => AbortSignal;
  /** Replaces the live sources (an offline provider for local runs, fakes in tests). Receives the step's budgeted `fetch`. */
  marketData?: (deps: MarketDataDeps, fetch: FetchLike) => MarketData;
}

/** The sources a job step works with. */
export interface MarketData {
  provider: PriceSource;
  fx: FxSource;
  /** Absent without an Alpha Vantage key. */
  earnings?: EarningsSource;
  /** Absent without an EODHD key. */
  actions?: CorporateActionsSource;
}

/** Longest a client-side rate limiter sleeps inline; a longer wait becomes a RateLimitError and the job reschedules. */
const MAX_INLINE_WAIT_MS = 2000;

/**
 * The providers of one job step. Providers are cheap and stateless (their quotas live in the item store), so a step builds
 * them around its own `fetch`, usually a `budgetedFetch` that enforces the platform's subrequest cap.
 */
export function createMarketData(deps: MarketDataDeps, fetch: FetchLike = deps.fetch): MarketData {
  const { config, clock, sleep } = deps;
  const logger = deps.logger ?? silentLogger;
  const nowMs = (): number => clock().getTime();
  const http = (provider: string): HttpClient => new HttpClient({ provider, fetch, sleep, timeoutMs: deps.timeoutMs, random: deps.random, timeoutSignal: deps.timeoutSignal, logger });
  const ledger = new StoreQuotaLedger(deps.store, sleep);
  const quota = (provider: string, limit: number): DailyQuota => new DailyQuota(ledger, provider, limit, () => utcDay(clock()));
  const bucket = (capacity: number, perSecond: number): TokenBucket => new TokenBucket(capacity, perSecond, nowMs, sleep, MAX_INLINE_WAIT_MS);
  const { keys } = config;
  const blocks = new BlockBook(deps.store, clock);
  const gate = (provider: string): ProviderGate => new ProviderGate(blocks, provider, clock);

  const twelvedata = keys.twelvedata
    ? new TwelveDataProvider({
        apiKey: keys.twelvedata,
        http: http('twelvedata'),
        now: clock,
        bucket: bucket(TWELVEDATA_CREDITS_PER_MINUTE, TWELVEDATA_CREDITS_PER_MINUTE / 60),
        quota: quota('twelvedata', config.dailyLimits.twelvedata),
        minuteQuota: new MinuteQuota(ledger, 'twelvedata', TWELVEDATA_CREDITS_PER_MINUTE, nowMs),
        gate: gate('twelvedata'),
        plan: new StorePlanMemory(deps.store, 'twelvedata', clock),
        logger,
      })
    : undefined;
  const eodhd = keys.eodhd ? new EodhdProvider({ apiKey: keys.eodhd, http: http('eodhd'), now: clock, bucket: bucket(5, 1), quota: quota('eodhd', config.dailyLimits.eodhd), gate: gate('eodhd'), logger }) : undefined;
  const coingecko = keys.coingecko ? new CoinGeckoProvider({ apiKey: keys.coingecko, http: http('coingecko'), now: clock, bucket: bucket(30, 0.5), extraCoinIds: config.coinGeckoCoinIds, logger }) : undefined;
  // Profiles and EPS estimates stop one call short of the daily limit; the calendar's call may use the last one.
  const alphavantage = keys.alphavantage
    ? new AlphaVantageProvider({ apiKey: keys.alphavantage, http: http('alphavantage'), now: clock, bucket: bucket(5, 5 / 60), quota: quota('alphavantage', alphaVantageGeneralLimit(config)) })
    : undefined;

  return {
    provider: new RoutingProvider({ twelvedata, eodhd, coingecko, alphavantage }, logger),
    fx: new FrankfurterFx({ http: http('frankfurter'), now: clock }),
    earnings: keys.alphavantage
      ? new AlphaVantageEarnings({ apiKey: keys.alphavantage, http: http('alphavantage'), bucket: bucket(1, 5 / 60), quota: quota('alphavantage', config.dailyLimits.alphavantage), horizon: config.calendar.earningsHorizon })
      : undefined,
    actions: keys.eodhd && eodhd ? new EodhdCorporateActions({ apiKey: keys.eodhd, http: http('eodhd'), bucket: bucket(5, 1), quota: quota('eodhd', config.dailyLimits.eodhd), dividends: eodhd }) : undefined,
  };
}
