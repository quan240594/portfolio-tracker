import type { DividendEvent, EodPrice, InstrumentProfile } from '@portfolio/shared';
import { sequentially } from '@portfolio/shared';
import { silentLogger, type Logger } from '@portfolio/platform';
import { ProviderError, ProviderUnavailableError } from '../errors.js';
import { isCrypto, routeOf, type Route } from '../symbols.js';
import { failureOf, notFound, type PriceBatch, type PriceSource } from './base.js';

export interface RoutingSources {
  twelvedata?: PriceSource;
  eodhd?: PriceSource;
  coingecko?: PriceSource;
  alphavantage?: PriceSource;
}

const REQUIRED: Readonly<Record<Route, keyof RoutingSources>> = { crypto: 'coingecko', listed: 'eodhd', us: 'twelvedata' };

/**
 * `live` provider: sends every symbol to the right free-tier source.
 *
 * | Symbol kind               | quotes / EOD | profile                     | dividends |
 * |---------------------------|--------------|-----------------------------|-----------|
 * | crypto `BTC-EUR`          | CoinGecko    | CoinGecko (static)          | none      |
 * | exchange suffix `ASML.AS` | EODHD        | EODHD search                | EODHD     |
 * | bare US ticker `AAPL`     | Twelve Data  | Alpha Vantage, then Twelve Data | EODHD |
 *
 * A source is optional (no API key, no source). Symbols whose source is missing are reported as `unavailable`.
 */
export class RoutingProvider implements PriceSource {
  readonly name = 'live';
  private readonly warned = new Set<string>();
  private readonly logger: Logger;

  constructor(
    private readonly sources: RoutingSources,
    logger: Logger = silentLogger,
  ) {
    this.logger = logger;
  }

  private warnOnce(needed: string): void {
    if (this.warned.has(needed)) return;
    this.logger.warn('provider not configured (missing API key); skipping symbols', { provider: needed });
    this.warned.add(needed);
  }

  private unavailable(symbol: string, needed: string): ProviderUnavailableError {
    this.warnOnce(needed);
    return new ProviderUnavailableError(`no ${needed} API key configured`, { provider: needed, symbol });
  }

  private priceSource(symbol: string): PriceSource {
    const needed = REQUIRED[routeOf(symbol)];
    const source = this.sources[needed];
    if (source === undefined) throw this.unavailable(symbol, needed);
    return source;
  }

  /** The quotes of symbols that all take the same route. */
  private async routeQuotes(route: Route, group: readonly string[]): Promise<PriceBatch> {
    const needed = REQUIRED[route];
    const source = this.sources[needed];
    if (source === undefined) {
      this.warnOnce(needed);
      return { quotes: {}, failed: [], unavailable: [...group] };
    }
    let batch: PriceBatch;
    try {
      batch = await source.getQuotes(group);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      this.logger.warn('quote batch failed', { provider: source.name, symbols: group, error: error.message });
      return { quotes: {}, failed: group.map((symbol) => failureOf(symbol, error)), unavailable: [] };
    }
    const failed = group.filter((symbol) => batch.quotes[symbol] === undefined).map((symbol) => batch.failed.find((f) => f.symbol === symbol) ?? notFound(source.name, symbol));
    return { quotes: batch.quotes, failed, unavailable: batch.unavailable };
  }

  async getQuotes(symbols: readonly string[]): Promise<PriceBatch> {
    const groups = new Map<Route, string[]>();
    for (const symbol of symbols) {
      const route = routeOf(symbol);
      groups.set(route, [...(groups.get(route) ?? []), symbol]);
    }
    const result: PriceBatch = { quotes: {}, failed: [], unavailable: [] };
    for await (const batch of sequentially([...groups], ([route, group]) => this.routeQuotes(route, group))) {
      Object.assign(result.quotes, batch.quotes);
      result.failed.push(...batch.failed);
      result.unavailable.push(...batch.unavailable);
    }
    return result;
  }

  getEodHistory(symbol: string, start: string, end: string): Promise<EodPrice[]> {
    try {
      return this.priceSource(symbol).getEodHistory(symbol, start, end);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getProfile(symbol: string): Promise<InstrumentProfile | null> {
    if (routeOf(symbol) !== 'us') return this.priceSource(symbol).getProfile(symbol);
    const { alphavantage, twelvedata } = this.sources;
    if (alphavantage === undefined && twelvedata === undefined) throw this.unavailable(symbol, 'twelvedata');
    if (alphavantage !== undefined) {
      try {
        const profile = await alphavantage.getProfile(symbol);
        if (profile !== null) return profile;
      } catch (error) {
        if (!(error instanceof ProviderError) || twelvedata === undefined) throw error;
        this.logger.info('alphavantage profile failed; falling back', { symbol, error: error.message });
      }
    }
    return twelvedata === undefined ? null : twelvedata.getProfile(symbol);
  }

  getDividends(symbol: string, start: string, end: string): Promise<DividendEvent[]> {
    if (isCrypto(symbol)) return Promise.resolve([]);
    if (this.sources.eodhd === undefined) {
      this.warnOnce('eodhd');
      return Promise.resolve([]);
    }
    return this.sources.eodhd.getDividends(symbol, start, end);
  }
}
