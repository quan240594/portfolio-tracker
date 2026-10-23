import type { DividendEvent, EodPrice, InstrumentProfile, Quote } from '@portfolio/shared';
import { sequentially } from '@portfolio/shared';
import { silentLogger, type Logger } from '@portfolio/platform';
import { SymbolNotFoundError } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { TokenBucket } from '../limits.js';
import { makeEod, makeQuote } from '../models.js';
import { asFloat, byText, chunks, isRecord, ownValue, titleCase, type JsonRecord } from '../parse.js';
import { cryptoParts } from '../symbols.js';
import { daysBetweenDays, fromEpochSeconds, utcDay } from '../time.js';
import { clampRange, quotesToBatch, type PriceBatch, type PriceSource } from './base.js';

/** CoinGecko demo API: crypto pairs like `BTC-EUR` (quotes and daily history, no dividends). Demo plan: 30 calls a minute. */
export const COINGECKO_URL = 'https://api.coingecko.com/api/v3';
export const COINGECKO_MAX_IDS = 50;

export const COIN_IDS: Readonly<Record<string, string>> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  XRP: 'ripple',
  DOT: 'polkadot',
  DOGE: 'dogecoin',
  LTC: 'litecoin',
};

const COIN_NAMES: Readonly<Record<string, string>> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum',
  solana: 'Solana',
  cardano: 'Cardano',
  ripple: 'XRP',
  polkadot: 'Polkadot',
  dogecoin: 'Dogecoin',
  litecoin: 'Litecoin',
};

/** The built-in ticker map extended by `extra`, a `TICKER=coingecko-id,...` list (e.g. `AVAX=avalanche-2,LINK=chainlink`). */
export function coinIds(extra = ''): Record<string, string> {
  const ids: Record<string, string> = { ...COIN_IDS };
  for (const pair of extra.split(',')) {
    const eq = pair.indexOf('=');
    if (eq >= 0) ids[pair.slice(0, eq).trim().toUpperCase()] = pair.slice(eq + 1).trim().toLowerCase();
  }
  return ids;
}

export interface CoinGeckoOptions {
  apiKey: string;
  http: HttpClient;
  now: () => Date;
  bucket: TokenBucket;
  /** Extra `TICKER=id` pairs (config `COINGECKO_COIN_IDS`). */
  extraCoinIds?: string;
  logger?: Logger;
}

export class CoinGeckoProvider implements PriceSource {
  readonly name = 'coingecko';
  private readonly ids: Record<string, string>;
  private readonly logger: Logger;

  constructor(private readonly options: CoinGeckoOptions) {
    this.ids = coinIds(options.extraCoinIds);
    this.logger = options.logger ?? silentLogger;
  }

  private coin(symbol: string): { id: string; vs: string } {
    const [ticker, vs] = cryptoParts(symbol);
    const id = ownValue(this.ids, ticker);
    if (id === undefined) throw new SymbolNotFoundError(`${this.name}: no coin id mapping for ${ticker}`, { provider: this.name, symbol });
    return { id, vs: vs.toLowerCase() };
  }

  private async get(path: string, params: Record<string, unknown>, symbol?: string): Promise<unknown> {
    await this.options.bucket.acquire(1);
    return this.options.http.getJson(`${COINGECKO_URL}${path}`, params, { 'x-cg-demo-api-key': this.options.apiKey }, symbol);
  }

  private async fetchQuotes(symbols: readonly string[]): Promise<Record<string, Quote>> {
    const wanted = new Map<string, { id: string; vs: string }>();
    for (const symbol of symbols) {
      try {
        wanted.set(symbol, this.coin(symbol));
      } catch (error) {
        if (!(error instanceof SymbolNotFoundError)) throw error;
        this.logger.warn('coingecko unknown coin', { symbol, error: error.message });
      }
    }
    if (wanted.size === 0) return {};
    const coins = [...wanted.values()];
    const data = await this.get('/simple/price', {
      ids: [...new Set(coins.map((c) => c.id))].toSorted(byText).join(','),
      vs_currencies: [...new Set(coins.map((c) => c.vs))].toSorted(byText).join(','),
      include_24hr_change: 'true',
      include_last_updated_at: 'true',
    });
    const out: Record<string, Quote> = {};
    for (const [symbol, { id, vs }] of wanted) {
      const entry = isRecord(data) && isRecord(data[id]) ? data[id] : {};
      const quote = this.quoteFromEntry(symbol, vs, entry);
      if (quote !== null) out[symbol] = quote;
    }
    return out;
  }

  /** The quote of one coin entry of `/simple/price`; the previous close is derived from the 24 h change. */
  private quoteFromEntry(symbol: string, vs: string, entry: JsonRecord): Quote | null {
    const price = asFloat(entry[vs]);
    if (price === null) return null;
    const change = asFloat(entry[`${vs}_24h_change`]);
    const previous = change !== null && change > -100 ? price / (1 + change / 100) : price;
    const updated = fromEpochSeconds(asFloat(entry.last_updated_at), this.options.now());
    return makeQuote({ symbol, price, previousClose: Number(previous.toFixed(8)), currency: vs.toUpperCase(), asOf: updated.toISOString(), source: this.name });
  }

  /** One `/simple/price` call per 50 coins. */
  getQuotes(symbols: readonly string[]): Promise<PriceBatch> {
    return quotesToBatch(this.name, symbols, async (wanted) => {
      const out: Record<string, Quote> = {};
      for await (const quotes of sequentially(chunks(wanted, COINGECKO_MAX_IDS), (group) => this.fetchQuotes(group))) Object.assign(out, quotes);
      return out;
    });
  }

  async getEodHistory(symbol: string, start: string, end: string): Promise<EodPrice[]> {
    const { id, vs } = this.coin(symbol);
    const days = Math.max(1, Math.min(365, daysBetweenDays(start, utcDay(this.options.now())) + 1));
    const data = await this.get(`/coins/${id}/market_chart`, { vs_currency: vs, days, interval: 'daily' }, symbol);
    const lastOfDay = new Map<string, number>();
    for (const point of isRecord(data) && Array.isArray(data.prices) ? (data.prices as unknown[]) : []) {
      if (!Array.isArray(point) || point.length !== 2) continue;
      const millis = asFloat(point[0]);
      const price = asFloat(point[1]);
      if (millis !== null && price !== null) lastOfDay.set(utcDay(new Date(Math.trunc(millis))), price);
    }
    const rows = [...lastOfDay].map(([date, close]) => makeEod({ symbol, date, close, currency: vs.toUpperCase() }));
    return clampRange(rows, start, end);
  }

  getProfile(symbol: string): Promise<InstrumentProfile | null> {
    const { id, vs } = this.coin(symbol);
    return Promise.resolve({ symbol, name: ownValue(COIN_NAMES, id) ?? titleCase(id.replaceAll('-', ' ')), assetClass: 'CRYPTO', currency: vs.toUpperCase() });
  }

  getDividends(): Promise<DividendEvent[]> {
    return Promise.resolve([]);
  }
}
