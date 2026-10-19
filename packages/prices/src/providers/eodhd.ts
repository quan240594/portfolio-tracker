import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { sequentially } from '@portfolio/shared';
import { silentLogger, type Logger } from '@portfolio/platform';
import { z } from 'zod';
import { ProviderError, RateLimitError, SymbolNotFoundError } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { DailyQuota, TokenBucket } from '../limits.js';
import { makeDividend, makeQuote, normalizeCurrency } from '../models.js';
import { asFloat, asText, byText, chunks, dayOf, definedOnly, isRecord, nonEmpty, validIsin } from '../parse.js';
import { baseTicker, countryFor, currencyFor, exchangeFor, exchangeSuffix, EXCHANGES, priceCurrencyFor } from '../symbols.js';
import { fromEpochSeconds } from '../time.js';
import { assetClassFromType } from './twelvedata.js';
import { clampRange, quotesToBatch, type PriceBatch, type PriceSource } from './base.js';

/**
 * EODHD: exchange-suffixed (EU etc.) listings for quotes, EOD and profile, and dividends for every equity. The free plan
 * allows about 20 calls a day (each ticker of a batched real-time request counts), so a persisted daily quota guards it.
 */
export const EODHD_URL = 'https://eodhd.com/api';
export const EODHD_MAX_BATCH = 15;
const NO_PARAMS: Readonly<Record<string, unknown>> = {};

/** `ASML.AS` -> `ASML.AS`, `SAP.DE` -> `SAP.XETRA`, `VOD.L` -> `VOD.LSE`, `AAPL` -> `AAPL.US`. */
export function toEodhdSymbol(symbol: string): string {
  const suffix = exchangeSuffix(symbol);
  if (suffix === null) return `${symbol}.US`;
  return `${baseTicker(symbol)}.${EXCHANGES[suffix]?.code ?? suffix}`;
}

const num = z.unknown().transform(asFloat);
const realtimeRow = z.object({ code: z.unknown(), close: num, previousClose: num, timestamp: num }).passthrough();
const eodRow = z.object({ date: z.unknown(), close: num }).passthrough();
const dividendRow = z.object({ date: z.unknown(), paymentDate: z.unknown(), value: num, currency: z.unknown() }).passthrough();

export interface EodhdOptions {
  apiKey: string;
  http: HttpClient;
  now: () => Date;
  bucket: TokenBucket;
  quota: DailyQuota;
  logger?: Logger;
}

export class EodhdProvider implements PriceSource {
  readonly name = 'eodhd';
  private readonly logger: Logger;

  constructor(private readonly options: EodhdOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** One authenticated GET; the daily quota is spent first. HTTP 402 is EODHD's "daily limit reached". */
  async get(path: string, params: Readonly<Record<string, unknown>> = NO_PARAMS, calls = 1, symbol?: string): Promise<unknown> {
    await this.options.quota.consume(calls);
    await this.options.bucket.acquire(1);
    try {
      return await this.options.http.getJson(`${EODHD_URL}${path}`, { ...params, fmt: 'json', api_token: this.options.apiKey }, undefined, symbol);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 402) throw new RateLimitError(`${this.name}: daily API limit reached`, { provider: this.name, symbol });
      throw error;
    }
  }

  private quoteFromRaw(raw: unknown, mapping: ReadonlyMap<string, string>): Quote | null {
    const parsed = realtimeRow.safeParse(raw);
    if (!parsed.success) return null;
    const canonical = mapping.get(asText(parsed.data.code));
    if (canonical === undefined || parsed.data.close === null) return null;
    const asOf = fromEpochSeconds(parsed.data.timestamp, this.options.now());
    return makeQuote({ symbol: canonical, price: parsed.data.close, previousClose: parsed.data.previousClose ?? parsed.data.close, currency: priceCurrencyFor(canonical), asOf: asOf.toISOString(), source: this.name });
  }

  private async quoteBatch(batch: readonly string[]): Promise<Record<string, Quote>> {
    const mapping = new Map(batch.map((symbol) => [toEodhdSymbol(symbol), symbol]));
    const codes = [...mapping.keys()];
    let data: unknown;
    try {
      data = await this.get(`/real-time/${codes[0]}`, codes.length > 1 ? { s: codes.slice(1).join(',') } : {}, codes.length);
    } catch (error) {
      if (!(error instanceof SymbolNotFoundError)) throw error;
      this.logger.warn('eodhd quote not found', { symbols: batch, error: error.message });
      return {};
    }
    const out: Record<string, Quote> = {};
    for (const raw of Array.isArray(data) ? data : [data]) {
      const quote = this.quoteFromRaw(raw, mapping);
      if (quote) out[quote.symbol] = quote;
    }
    return out;
  }

  private async fetchQuotes(symbols: readonly string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    for await (const quotes of sequentially(chunks(symbols, EODHD_MAX_BATCH), (batch) => this.quoteBatch(batch))) Object.assign(out, quotes);
    return out;
  }

  getQuotes(symbols: readonly string[]): Promise<PriceBatch> {
    return quotesToBatch(this.name, symbols, (wanted) => this.fetchQuotes(wanted));
  }

  async getEodHistory(symbol: string, start: string, end: string): Promise<EodPrice[]> {
    const data = await this.get(`/eod/${toEodhdSymbol(symbol)}`, { from: start, to: end, period: 'd' }, 1, symbol);
    const currency = priceCurrencyFor(symbol);
    const rows: EodPrice[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const row = eodRow.safeParse(raw);
      if (row.success && row.data.close !== null && nonEmpty(row.data.date) !== undefined) rows.push({ symbol, date: dayOf(row.data.date), close: row.data.close, currency });
    }
    return clampRange(rows, start, end);
  }

  async getProfile(symbol: string): Promise<InstrumentProfile | null> {
    const providerSymbol = toEodhdSymbol(symbol);
    const dot = providerSymbol.lastIndexOf('.');
    const code = providerSymbol.slice(0, dot);
    const exchange = providerSymbol.slice(dot + 1);
    const data = await this.get(`/search/${code}`, { exchange, limit: 10 }, 1, symbol);
    const match = (Array.isArray(data) ? (data as unknown[]) : []).find((row) => isRecord(row) && asText(row.Code).toUpperCase() === code && asText(row.Exchange).toUpperCase() === exchange.toUpperCase());
    if (!isRecord(match)) return null;
    const country = nonEmpty(match.Country);
    return definedOnly({
      symbol,
      name: nonEmpty(match.Name) ?? symbol,
      assetClass: assetClassFromType(match.Type),
      currency: (nonEmpty(match.Currency) ?? currencyFor(symbol)).toUpperCase(),
      country: country !== undefined && country !== 'USA' ? country : countryFor(symbol),
      exchange: exchangeFor(symbol) ?? nonEmpty(match.Exchange),
      isin: validIsin(match.ISIN),
    });
  }

  async getDividends(symbol: string, start: string, end: string): Promise<DividendEvent[]> {
    let data: unknown;
    try {
      data = await this.get(`/div/${toEodhdSymbol(symbol)}`, { from: start }, 1, symbol);
    } catch (error) {
      if (error instanceof SymbolNotFoundError) return [];
      throw error;
    }
    const byExDate = new Map<string, DividendEvent>();
    for (const raw of Array.isArray(data) ? data : []) {
      const row = dividendRow.safeParse(raw);
      if (!row.success) continue;
      const exDate = dayOf(row.data.date);
      if (exDate === '' || row.data.value === null || exDate > end || exDate < start) continue;
      const payDate = dayOf(row.data.paymentDate);
      byExDate.set(exDate, makeDividend({ symbol, exDate, payDate: payDate === '' ? undefined : payDate, amount: row.data.value, currency: normalizeCurrency(row.data.currency, priceCurrencyFor(symbol)) }));
    }
    return [...byExDate.keys()].toSorted(byText).map((exDate) => byExDate.get(exDate)!);
  }
}
