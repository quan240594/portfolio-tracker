import type { PricesConfig } from '@portfolio/prices';

export interface PriceSourceStatus {
  name: 'twelvedata' | 'eodhd' | 'coingecko' | 'alphavantage' | 'frankfurter';
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
}

const SOURCES = [
  { name: 'twelvedata', secret: 'TWELVEDATA_API_KEY', key: 'twelvedata', covers: 'quotes, history and profiles of US-listed symbols' },
  { name: 'eodhd', secret: 'EODHD_API_KEY', key: 'eodhd', covers: 'quotes, history, dividends and splits of exchange-suffixed (for example .AS, .DE) symbols' },
  { name: 'coingecko', secret: 'COINGECKO_API_KEY', key: 'coingecko', covers: 'crypto quotes and history' },
  { name: 'alphavantage', secret: 'ALPHAVANTAGE_API_KEY', key: 'alphavantage', covers: 'US company profiles and the earnings calendar' },
] as const;

export function pricesStatus(config: PricesConfig): PricesStatus {
  const sources: PriceSourceStatus[] = SOURCES.map(({ name, secret, key, covers }) => ({ name, configured: config.keys[key] !== undefined, secret, covers }));
  sources.push({ name: 'frankfurter', configured: true, secret: null, covers: 'daily foreign-exchange rates (no key needed)' });
  const missingSecrets = sources.filter((source) => !source.configured && source.secret !== null).map((source) => source.secret!);
  const keyed = SOURCES.length - missingSecrets.length;
  if (missingSecrets.length === 0) return { state: 'ok', sources, missingSecrets, message: 'Every market-data source is configured.' };
  const message =
    keyed === 0
      ? 'No market-data API key is set: only exchange rates are refreshed and prices keep their last stored value. Set the secrets listed in missingSecrets to switch sources on.'
      : 'Some market-data API keys are not set: symbols that need them are skipped and keep their last stored price. Set the secrets listed in missingSecrets to switch them on.';
  return { state: keyed === 0 ? 'no-keys' : 'partial', sources, missingSecrets, message };
}
