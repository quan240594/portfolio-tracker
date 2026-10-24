import type { PricesConfig } from '@portfolio/prices';
import type { PriceHistoryCoverage, T212QuoteState, T212QuoteStatus } from '@portfolio/shared';

export interface PriceSourceStatus {
  name: 'twelvedata' | 'eodhd' | 'coingecko' | 'alphavantage' | 'frankfurter' | 't212';
  configured: boolean;
  /** The Worker secret that switches the source on (none for the keyless ECB source). */
  secret: string | null;
  covers: string;
}

/**
 * `GET /api/prices/status`: which market-data sources are on. Missing provider keys are a normal, reported state: the
 * symbols that need a missing source are skipped by the price jobs (never failed) and keep their last stored price.
 */
export interface PricesStatus {
  /** `ok`: every source is on; `partial`: some keys are missing; `no-keys`: only the keyless FX source works. */
  state: 'ok' | 'partial' | 'no-keys';
  sources: PriceSourceStatus[];
  /** The Worker secrets still to set to switch every source on. */
  missingSecrets: string[];
  message: string;
  /** The Trading 212 quote refresh of the signed-in user; null while no refresh has run (no connected account, or not yet). */
  t212Quotes: T212QuotesReport | null;
  /**
   * How much end-of-day history is stored for each open position of the signed-in user, and why a gap is there (see "Price history
   * coverage" in docs/architecture.md). Null without a signed-in user or when it could not be read.
   */
  history: PriceHistoryCoverage | null;
}

/** What the last Trading 212 quote refresh did: the freshness of the prices of the held positions. Never contains credentials. */
export interface T212QuotesReport {
  state: T212QuoteState;
  /** ISO time of the last attempt, and of the last one that stored quotes. */
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  /** Quotes stored by the last successful run. */
  quoted: number | null;
  lastError: string | null;
  /** Scheduled runs wait until this time after a failure. */
  nextAttemptAt: string | null;
}

const SOURCES = [
  { name: 'twelvedata', secret: 'TWELVEDATA_API_KEY', key: 'twelvedata', covers: 'quotes, history and profiles of US-listed symbols' },
  { name: 'eodhd', secret: 'EODHD_API_KEY', key: 'eodhd', covers: 'quotes, history, dividends and splits of exchange-suffixed (for example .AS, .DE) symbols' },
  { name: 'coingecko', secret: 'COINGECKO_API_KEY', key: 'coingecko', covers: 'crypto quotes and history' },
  { name: 'alphavantage', secret: 'ALPHAVANTAGE_API_KEY', key: 'alphavantage', covers: 'US company profiles and the earnings calendar' },
] as const;

const T212_COVERS = 'live prices of the positions held at Trading 212 (no key needed; refreshed every 15 minutes on weekdays while the account is connected)';

const report = (status: T212QuoteStatus): T212QuotesReport => ({
  state: status.state,
  lastAttemptAt: status.lastAttemptAt,
  lastSuccessAt: status.lastSuccessAt ?? null,
  quoted: status.quoted ?? null,
  lastError: status.lastError ?? null,
  nextAttemptAt: status.nextAttemptAt ?? null,
});

function summary(keyed: number, missingSecrets: readonly string[], t212: T212QuotesReport | null): string {
  if (missingSecrets.length === 0) return 'Every market-data source is configured.';
  const live = t212?.state === 'OK' && t212.lastSuccessAt !== null;
  const prices = live ? 'held positions are priced from Trading 212 (last refresh ' + t212.lastSuccessAt + ')' : 'prices keep their last stored value';
  if (keyed > 0) return 'Some market-data API keys are not set: symbols that need them are skipped; ' + prices + '. Set the secrets listed in missingSecrets to switch them on.';
  const rates = live ? 'exchange rates are refreshed' : 'only exchange rates are refreshed';
  return 'No market-data API key is set: ' + rates + ' and ' + prices + '; charts and history need the secrets listed in missingSecrets.';
}

/** `t212` is the stored status of the signed-in user's Trading 212 quote refresh, when there is one; `history` the coverage of the held symbols. */
export function pricesStatus(config: PricesConfig, t212: T212QuoteStatus | null = null, history: PriceHistoryCoverage | null = null): PricesStatus {
  const sources: PriceSourceStatus[] = SOURCES.map(({ name, secret, key, covers }) => ({ name, configured: config.keys[key] !== undefined, secret, covers }));
  sources.push({ name: 'frankfurter', configured: true, secret: null, covers: 'daily foreign-exchange rates (no key needed)' });
  const t212Report = t212 ? report(t212) : null;
  sources.push({ name: 't212', configured: t212Report?.state === 'OK', secret: null, covers: T212_COVERS });
  const missingSecrets = sources.filter((source) => !source.configured && source.secret !== null).map((source) => source.secret!);
  const keyed = SOURCES.length - missingSecrets.length;
  let state: PricesStatus['state'] = 'ok';
  if (missingSecrets.length > 0) state = keyed === 0 ? 'no-keys' : 'partial';
  return { state, sources, missingSecrets, message: summary(keyed, missingSecrets, t212Report), t212Quotes: t212Report, history };
}
