import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { ProviderError, RateLimitError } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { DailyQuota, TokenBucket } from '../limits.js';
import { makeProfile } from '../models.js';
import { asFloat, cleanText, isRecord, nonEmpty, ownValue, positiveNumber, titleCase, websiteDomain, type JsonRecord } from '../parse.js';
import { utcDay } from '../time.js';
import { COUNTRY_NAMES, assetClassFromType } from './twelvedata.js';
import { failureOf, type PriceBatch, type PriceSource } from './base.js';

/** Alpha Vantage: used for US instrument profiles (`OVERVIEW`) only; the free tier is 25 calls a day. */
export const ALPHAVANTAGE_URL = 'https://www.alphavantage.co/query';

const PLACEHOLDERS = new Set(['NONE', 'N/A', '-']);

function sectorTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || PLACEHOLDERS.has(value.toUpperCase())) return undefined;
  return value === value.toUpperCase() && value !== value.toLowerCase() ? titleCase(value) : value;
}

export interface AlphaVantageOptions {
  apiKey: string;
  http: HttpClient;
  now: () => Date;
  bucket: TokenBucket;
  quota: DailyQuota;
}

export class AlphaVantageProvider implements PriceSource {
  readonly name = 'alphavantage';

  constructor(private readonly options: AlphaVantageOptions) {}

  async getProfile(symbol: string): Promise<InstrumentProfile | null> {
    await this.options.quota.consume(1);
    await this.options.bucket.acquire(1);
    const raw = await this.options.http.getJson(ALPHAVANTAGE_URL, { function: 'OVERVIEW', symbol: symbol.replaceAll('-', '.'), apikey: this.options.apiKey }, undefined, symbol);
    const data = isRecord(raw) ? raw : {};
    // Alpha Vantage reports throttling and quota as HTTP 200 with a Note/Information message.
    if ('Note' in data || 'Information' in data) throw new RateLimitError(`${this.name}: rate limited`, { provider: this.name, symbol });
    if ('Error Message' in data || !nonEmpty(data.Symbol)) return null;
    return this.profileFrom(symbol, data);
  }

  private profileFrom(symbol: string, data: JsonRecord): InstrumentProfile {
    const country = nonEmpty(data.Country);
    // The trailing-twelve-month P/E and the company details come from the same OVERVIEW call: no extra provider traffic.
    const peRatio = positiveNumber(data.PERatio) ?? undefined;
    return makeProfile({
      symbol,
      name: nonEmpty(data.Name) ?? symbol,
      assetClass: assetClassFromType(data.AssetType),
      currency: (nonEmpty(data.Currency) ?? 'USD').toUpperCase(),
      sector: sectorTitle(data.Sector),
      country: country === undefined ? undefined : (ownValue(COUNTRY_NAMES, country) ?? country),
      exchange: nonEmpty(data.Exchange),
      peRatio,
      fundamentalsAsOf: peRatio === undefined ? undefined : utcDay(this.options.now()),
      description: cleanText(data.Description),
      website: websiteDomain(data.OfficialSite),
      marketCap: positiveNumber(data.MarketCapitalization) ?? undefined,
      eps: asFloat(data.EPS) ?? undefined,
      beta: asFloat(data.Beta) ?? undefined,
    });
  }

  private unsupported(what: string, symbol: string): ProviderError {
    return new ProviderError(`${this.name}: ${what} not used (profiles only)`, { provider: this.name, symbol });
  }

  getQuotes(symbols: readonly string[]): Promise<PriceBatch> {
    const error = this.unsupported('quotes', symbols.join(','));
    return Promise.resolve({ quotes: {} as Record<string, Quote>, failed: symbols.map((symbol) => failureOf(symbol, error)), unavailable: [] });
  }

  getEodHistory(symbol: string): Promise<EodPrice[]> {
    return Promise.reject(this.unsupported('EOD history', symbol));
  }

  getDividends(symbol: string): Promise<DividendEvent[]> {
    return Promise.reject(this.unsupported('dividends', symbol));
  }
}
