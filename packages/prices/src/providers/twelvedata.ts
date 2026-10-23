import type { AssetClass, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { majorCurrencyCode, sequentially } from '@portfolio/shared';
import { silentLogger, type Logger } from '@portfolio/platform';
import { z } from 'zod';
import { ProviderError, RateLimitError, RetryableProviderError, SymbolNotFoundError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { resetOf, spendCredits, type DailyQuota, type MinuteQuota, type ProviderGate, type TokenBucket } from '../limits.js';
import { makeEod, makeQuote, normalizeCurrency } from '../models.js';
import { asFloat, chunks, cleanText, definedOnly, dayOf, isRecord, nonEmpty, ownValue, websiteDomain, type JsonRecord } from '../parse.js';
import { countryFor } from '../symbols.js';
import { fromEpochSeconds } from '../time.js';
import { clampRange, quotesToBatch, type PriceBatch, type PriceSource } from './base.js';

/**
 * Twelve Data (US equities and ETFs): quotes, daily time series, profile with a reference-data fallback.
 * Free tier: 8 credits per minute, 800 per day; every symbol of a batch `/quote` costs one credit, so batches hold at most 8.
 */
export const TWELVEDATA_URL = 'https://api.twelvedata.com';
export const TWELVEDATA_MAX_BATCH = 8;
export const TWELVEDATA_CREDITS_PER_MINUTE = 8;
export const TWELVEDATA_CREDITS_PER_DAY = 800;

const UNITED_STATES = 'United States';
export const COUNTRY_NAMES: Readonly<Record<string, string>> = { USA: UNITED_STATES, US: UNITED_STATES, 'United States of America': UNITED_STATES };

/** Yahoo class shares `BRK-B` are `BRK.B` at Twelve Data. */
export const toTwelveDataSymbol = (symbol: string): string => symbol.replaceAll('-', '.');

export function assetClassFromType(kind: unknown): AssetClass {
  const type = (typeof kind === 'string' ? kind : '').toLowerCase();
  if (type.includes('etf') || type.includes('fund')) return 'ETF';
  if (type.includes('bond')) return 'BOND';
  if (['stock', 'share', 'equity', 'depositary'].some((word) => type.includes(word))) return 'STOCK';
  return 'OTHER';
}

const num = z.unknown().transform(asFloat);
const quoteEntry = z.object({ close: num, previous_close: num, currency: z.unknown(), last_quote_at: num, timestamp: num }).passthrough();
const seriesRow = z.object({ close: num, datetime: z.unknown() }).passthrough();

export interface TwelveDataOptions {
  apiKey: string;
  http: HttpClient;
  now: () => Date;
  bucket: TokenBucket;
  quota: DailyQuota;
  /** Credits per minute, persisted: without it a step assumes a full minute of credits. */
  minuteQuota?: MinuteQuota;
  /** Persisted "limit reached" blocks, so a provider that said no is not asked again before its reset. */
  gate?: ProviderGate;
  /** What the plan lacks (persisted), so a plan without `/profile` is not asked for it again by every step. */
  plan?: PlanMemory;
  logger?: Logger;
}

/** The plan limits a provider has learned about itself, remembered between job steps. */
export interface PlanMemory {
  profileUnsupported(): Promise<boolean>;
  markProfileUnsupported(): Promise<void>;
}

export class TwelveDataProvider implements PriceSource {
  readonly name = 'twelvedata';
  private profileEndpointSupported = true;
  private readonly logger: Logger;

  constructor(private readonly options: TwelveDataOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  private async get(path: string, params: Record<string, unknown>, credits = 1, symbol?: string): Promise<JsonRecord> {
    await spendCredits(this.options, credits);
    await this.options.bucket.acquire(credits);
    const data = await this.options.http.getJson(`${TWELVEDATA_URL}${path}`, params, { Authorization: `apikey ${this.options.apiKey}` }, symbol);
    await this.raiseForError(data, symbol);
    return isRecord(data) ? data : {};
  }

  /** The error of a 429: the message tells whether the minute's or the day's credits are gone, and when they are back. */
  private limited(message: string, symbol: string | undefined): RateLimitError {
    const scope = /\b(day|daily)\b/i.test(message) ? 'day' : 'minute';
    return new RateLimitError(message, { provider: this.name, symbol, scope, resetAtMs: resetOf(scope, this.options.now().getTime()) });
  }

  /** Twelve Data reports errors as HTTP 200 with `{status: "error", code, message}`. */
  private async raiseForError(data: unknown, symbol: string | undefined): Promise<void> {
    if (!isRecord(data) || data.status !== 'error') return;
    const code = Math.trunc(asFloat(data.code) ?? 0);
    const message = `${this.name}: ${code} ${typeof data.message === 'string' ? data.message : ''}`.trim();
    const details = { provider: this.name, symbol };
    if (code === 429) throw await this.blocked(this.limited(message, symbol));
    if (code >= 500) throw new RetryableProviderError(message, details);
    if (code === 400 || code === 404) throw new SymbolNotFoundError(message, details);
    throw new ProviderError(message, details);
  }

  /** Remembers the limit for every later step and resolves the error to throw. */
  private async blocked(error: RateLimitError): Promise<RateLimitError> {
    if (error.scope !== undefined && error.resetAtMs !== undefined) await this.options.gate?.block(error.resetAtMs, error.scope, error.message);
    return error;
  }

  private parseQuote(symbol: string, raw: JsonRecord): Quote | null {
    const entry = quoteEntry.parse(raw);
    if (entry.close === null) return null;
    const asOf = fromEpochSeconds(entry.last_quote_at || entry.timestamp, this.options.now());
    return makeQuote({ symbol, price: entry.close, previousClose: entry.previous_close ?? entry.close, currency: normalizeCurrency(entry.currency, 'USD'), asOf: asOf.toISOString(), source: this.name });
  }

  /** One batch entry; per-symbol errors are logged and skipped, except rate limiting. */
  private quoteFromEntry(canonical: string, raw: JsonRecord): Quote | null {
    if (raw.status !== 'error') return this.parseQuote(canonical, raw);
    this.logger.warn('twelvedata quote error', { symbol: canonical, code: raw.code, error: raw.message });
    if (Math.trunc(asFloat(raw.code) ?? 0) === 429) throw this.limited(`${this.name}: 429 in batch ${typeof raw.message === 'string' ? raw.message : ''}`.trim(), canonical);
    return null;
  }

  private async quoteBatch(batch: readonly string[]): Promise<Record<string, Quote>> {
    const mapping = new Map(batch.map((symbol) => [toTwelveDataSymbol(symbol), symbol]));
    let data: JsonRecord;
    try {
      data = await this.get('/quote', { symbol: [...mapping.keys()].join(',') }, batch.length);
    } catch (error) {
      if (!(error instanceof SymbolNotFoundError)) throw error;
      this.logger.warn('twelvedata quote not found', { symbols: batch, error: error.message });
      return {};
    }
    // A single symbol is answered with the quote itself, several with an object keyed by symbol.
    const entries: [string, unknown][] = batch.length === 1 ? [[[...mapping.keys()][0]!, data]] : Object.entries(data);
    const out: Record<string, Quote> = {};
    try {
      for (const [providerSymbol, raw] of entries) {
        const canonical = mapping.get(providerSymbol);
        if (canonical === undefined || !isRecord(raw)) continue;
        const quote = this.quoteFromEntry(canonical, raw);
        if (quote) out[canonical] = quote;
      }
    } catch (error) {
      throw error instanceof RateLimitError ? await this.blocked(error) : error;
    }
    return out;
  }

  private async fetchQuotes(symbols: readonly string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    for await (const quotes of sequentially(chunks(symbols, TWELVEDATA_MAX_BATCH), (batch) => this.quoteBatch(batch))) Object.assign(out, quotes);
    return out;
  }

  getQuotes(symbols: readonly string[]): Promise<PriceBatch> {
    return quotesToBatch(this.name, symbols, (wanted) => this.fetchQuotes(wanted));
  }

  async getEodHistory(symbol: string, start: string, end: string): Promise<EodPrice[]> {
    const data = await this.get('/time_series', { symbol: toTwelveDataSymbol(symbol), interval: '1day', start_date: start, end_date: end, outputsize: 5000, order: 'asc' }, 1, symbol);
    const currency = normalizeCurrency(isRecord(data.meta) ? data.meta.currency : undefined, 'USD');
    const rows: EodPrice[] = [];
    for (const value of Array.isArray(data.values) ? (data.values as unknown[]) : []) {
      const row = seriesRow.safeParse(value);
      const date = row.success ? dayOf(row.data.datetime) : '';
      if (row.success && row.data.close !== null && date !== '') rows.push(makeEod({ symbol, date, close: row.data.close, currency }));
    }
    return clampRange(rows, start, end);
  }

  /** Stocks, then ETFs; the US listing wins when several exchanges list the symbol. */
  private async reference(symbol: string): Promise<JsonRecord | null> {
    for await (const found of sequentially(['/stocks', '/etfs'], (path) => this.referenceFrom(path, symbol))) if (found) return found;
    return null;
  }

  private async referenceFrom(path: string, symbol: string): Promise<JsonRecord | null> {
    const data = await this.get(path, { symbol: toTwelveDataSymbol(symbol) }, 1, symbol);
    const items = (Array.isArray(data.data) ? (data.data as unknown[]) : []).filter((item) => isRecord(item));
    if (items.length === 0) return null;
    const american = items.find((item) => item.country === UNITED_STATES || item.country === 'USA');
    const chosen = { ...(american ?? items[0]!) };
    chosen.type ??= path === '/etfs' ? 'ETF' : 'Common Stock';
    return chosen;
  }

  private async profileRaw(symbol: string): Promise<JsonRecord | null> {
    if (!this.profileEndpointSupported || (await this.options.plan?.profileUnsupported())) return null;
    try {
      return await this.get('/profile', { symbol: toTwelveDataSymbol(symbol) }, 1, symbol);
    } catch (error) {
      if (error instanceof SymbolNotFoundError) return null;
      if (!(error instanceof ProviderError) || error.retryable) throw error;
      this.logger.info('twelvedata /profile unavailable, using reference data', { error: error.message });
      this.profileEndpointSupported = false;
      await this.options.plan?.markProfileUnsupported();
      return null;
    }
  }

  async getProfile(symbol: string): Promise<InstrumentProfile | null> {
    let raw = await this.profileRaw(symbol);
    if (!raw || !nonEmpty(raw.name)) raw = await this.reference(symbol);
    if (!raw) return null;
    const country = nonEmpty(raw.country) ?? countryFor(symbol);
    return definedOnly({
      symbol,
      name: nonEmpty(raw.name) ?? symbol,
      assetClass: assetClassFromType(raw.type),
      currency: majorCurrencyCode(normalizeCurrency(raw.currency, 'USD')),
      sector: nonEmpty(raw.sector),
      country: country === undefined ? undefined : (ownValue(COUNTRY_NAMES, country) ?? country),
      exchange: nonEmpty(raw.exchange),
      description: cleanText(raw.description),
      website: websiteDomain(raw.website),
    });
  }

  getDividends(symbol: string): Promise<never> {
    return Promise.reject(new ProviderError(`${this.name}: dividends not supported (use EODHD)`, { provider: this.name, symbol }));
  }
}
