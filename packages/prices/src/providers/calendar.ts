import type { DividendEvent, StoredEarningsEvent, StoredSplitEvent } from '@portfolio/shared';
import type { CorporateActionsSource, EarningsSource } from '@portfolio/platform';
import { csvRecords, parseCsv } from '../csv.js';
import { ProviderError, RateLimitError, SymbolNotFoundError } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { TokenBucket } from '../limits.js';
import { asFloat, byText, definedOnly, isoDateOrNull, isRecord, ownValue } from '../parse.js';
import { hasExchangeSuffix, isCrypto } from '../symbols.js';
import { EODHD_URL, toEodhdSymbol, type EodhdProvider } from './eodhd.js';
import { ALPHAVANTAGE_URL } from './alphavantage.js';
import type { DailyQuota } from '../limits.js';

/**
 * Calendar data sources (free tier, researched in docs/architecture.md "Calendar"):
 *
 * | Data               | Source                                   | Free-tier fit                           |
 * |--------------------|------------------------------------------|-----------------------------------------|
 * | Earnings dates     | Alpha Vantage `EARNINGS_CALENDAR` (CSV)  | one call lists all US companies, 3-12 m |
 * | Splits             | EODHD `/splits/{symbol}`                 | 1 call per symbol of the 20 calls/day   |
 * | Dividends (refresh)| EODHD `/div/{symbol}`                    | 1 call per symbol, same budget          |
 */
const TIME_OF_DAY: Readonly<Record<string, 'BMO' | 'AMC'>> = { 'pre-market': 'BMO', 'post-market': 'AMC' };

/** Alpha Vantage symbol of a canonical one; null when it has no (US) listing (exchange suffixes and crypto). */
export function alphaVantageSymbol(symbol: string): string | null {
  if (isCrypto(symbol) || hasExchangeSuffix(symbol)) return null;
  return symbol.replaceAll('-', '.');
}

function raiseForJsonBody(body: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }
  const message = isRecord(payload) ? String(payload.Information || payload.Note || payload['Error Message'] || '') : '';
  if (message.includes('call frequency') || message.includes('requests per day') || message.toLowerCase().includes('rate limit')) {
    throw new RateLimitError('alphavantage: rate limited', { provider: 'alphavantage' });
  }
  throw new ProviderError('alphavantage: unexpected JSON response for EARNINGS_CALENDAR', { provider: 'alphavantage' });
}

const estimate = (value: string | undefined): number | undefined => asFloat((value ?? '').trim() || null) ?? undefined;

/**
 * Rows of the `EARNINGS_CALENDAR` CSV for the symbols in `mapping` (Alpha Vantage symbol -> canonical). Columns:
 * `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay`. Rows without a valid report date are skipped,
 * an empty/"None"/malformed estimate is absent and the time of day is `pre-market`, `post-market` or empty.
 */
export function parseEarningsCsv(input: string, mapping: ReadonlyMap<string, string>): StoredEarningsEvent[] {
  const body = input.replace(/^\uFEFF/, '');
  if (body.trimStart().startsWith('{')) raiseForJsonBody(body);
  const { header, records } = csvRecords(parseCsv(body));
  if (!header.includes('symbol') || !header.includes('reportDate')) throw new ProviderError('alphavantage: unexpected response for EARNINGS_CALENDAR', { provider: 'alphavantage' });
  const events = new Map<string, StoredEarningsEvent>();
  for (const row of records) {
    const event = earningsEvent(row, mapping);
    if (event !== null) events.set(`${event.symbol}\u0000${event.date}`, event);
  }
  return [...events.keys()].toSorted(byText).map((key) => events.get(key)!);
}

/** One CSV row as an event; null for rows of untracked symbols and rows without a valid report date. */
function earningsEvent(row: Record<string, string | undefined>, mapping: ReadonlyMap<string, string>): StoredEarningsEvent | null {
  const symbol = mapping.get((row.symbol ?? '').trim().toUpperCase());
  const date = isoDateOrNull(row.reportDate);
  if (symbol === undefined || date === null) return null;
  const currency = (row.currency ?? '').trim().toUpperCase();
  return definedOnly<StoredEarningsEvent>({
    symbol,
    date,
    name: (row.name ?? '').trim() || undefined,
    fiscalPeriodEnd: isoDateOrNull(row.fiscalDateEnding) ?? undefined,
    epsEstimate: estimate(row.estimate),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined,
    timeOfDay: ownValue(TIME_OF_DAY, (row.timeOfTheDay ?? '').trim().toLowerCase()) ?? 'unknown',
    source: 'alphavantage',
  });
}

export interface AlphaVantageEarningsOptions {
  apiKey: string;
  http: HttpClient;
  bucket: TokenBucket;
  quota: DailyQuota;
  /** `3month`, `6month` or `12month`. */
  horizon?: string;
}

/** One call lists the upcoming earnings of every US company; only the tracked symbols are kept. */
export class AlphaVantageEarnings implements EarningsSource {
  readonly name = 'alphavantage';
  readonly budgeted = true;

  constructor(private readonly options: AlphaVantageEarningsOptions) {}

  async fetch(symbols: readonly string[], today: string): Promise<StoredEarningsEvent[]> {
    const mapping = new Map<string, string>();
    for (const symbol of symbols) {
      const av = alphaVantageSymbol(symbol);
      if (av !== null) mapping.set(av, symbol);
    }
    if (mapping.size === 0) return [];
    await this.options.quota.consume(1);
    await this.options.bucket.acquire(1);
    const body = await this.options.http.getText(ALPHAVANTAGE_URL, { function: 'EARNINGS_CALENDAR', horizon: this.options.horizon ?? '12month', apikey: this.options.apiKey }, { Accept: 'text/csv, */*' });
    return parseEarningsCsv(body, mapping).filter((event) => event.date >= today);
  }
}

/** `"4.000000/1.000000"` (new / old shares) -> `{fromFactor: 1, toFactor: 4}`; null when malformed. */
export function parseSplitRatio(raw: unknown): { fromFactor: number; toFactor: number } | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('/');
  if (parts.length !== 2) return null;
  const toFactor = asFloat(parts[0]!.trim());
  const fromFactor = asFloat(parts[1]!.trim());
  if (toFactor === null || fromFactor === null || toFactor <= 0 || fromFactor <= 0) return null;
  return { fromFactor, toFactor };
}

export function parseSplits(data: unknown, symbol: string, start: string): StoredSplitEvent[] {
  const splits = new Map<string, StoredSplitEvent>();
  for (const row of Array.isArray(data) ? data : []) {
    if (!isRecord(row)) continue;
    const date = isoDateOrNull(String(row.date ?? '').slice(0, 10));
    const ratio = parseSplitRatio(row.split);
    if (date === null || ratio === null || date < start) continue;
    splits.set(date, { symbol, date, ...ratio, source: 'eodhd' });
  }
  return [...splits.keys()].toSorted(byText).map((date) => splits.get(date)!);
}

export interface EodhdActionsOptions {
  apiKey: string;
  http: HttpClient;
  bucket: TokenBucket;
  quota: DailyQuota;
  /** The EODHD price provider that serves the dividends. */
  dividends: Pick<EodhdProvider, 'getDividends'>;
}

/** Splits from `/splits/{symbol}` and dividends through the EODHD provider; every call counts against the daily quota. */
export class EodhdCorporateActions implements CorporateActionsSource {
  readonly name = 'eodhd';
  readonly budgeted = true;

  constructor(private readonly options: EodhdActionsOptions) {}

  async getSplits(symbol: string, start: string): Promise<StoredSplitEvent[]> {
    await this.options.quota.consume(1);
    await this.options.bucket.acquire(1);
    let data: unknown;
    try {
      data = await this.options.http.getJson(`${EODHD_URL}/splits/${toEodhdSymbol(symbol)}`, { from: start, fmt: 'json', api_token: this.options.apiKey }, undefined, symbol);
    } catch (error) {
      if (error instanceof SymbolNotFoundError) return [];
      // EODHD signals an exhausted daily limit with 402 Payment Required.
      if (error instanceof ProviderError && error.status === 402) throw new RateLimitError(`${this.name}: daily API limit reached`, { provider: this.name, symbol });
      throw error;
    }
    return parseSplits(data, symbol, start);
  }

  getDividends(symbol: string, start: string, end: string): Promise<DividendEvent[]> {
    return this.options.dividends.getDividends(symbol, start, end);
  }
}
