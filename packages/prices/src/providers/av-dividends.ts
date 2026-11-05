import type { DividendEvent } from '@portfolio/shared';
import { ProviderError } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { TokenBucket } from '../limits.js';
import type { EstimateBudget } from '../estimate-budget.js';
import { asFloat, isoDateOrNull, isRecord } from '../parse.js';
import { limitError, errorMessageOf, noticeOf } from './av-notice.js';
import { ALPHAVANTAGE_URL } from './alphavantage.js';

/**
 * The free fallback for declared dividends: Alpha Vantage `function=DIVIDENDS` ("historical and future (declared) dividend distributions" with
 * `ex_dividend_date`, `declaration_date`, `record_date`, `payment_date` and `amount`; https://www.alphavantage.co/documentation/#dividends).
 * The documentation does not mark it premium, but Alpha Vantage's free key refuses some functions at call time (EARNINGS_ESTIMATES), so the
 * first real call is the probe: a refusal that names a premium endpoint (or a bad key) makes the feed `unavailable` on this key, and the job asks
 * again only after a week. Its calls come out of the shared 25 a day through a small budget of their own.
 */
export type FeedAnswer =
  | { status: 'ok'; events: DividendEvent[] }
  /** The key cannot read the feed (a premium endpoint, an invalid key). */
  | { status: 'unavailable'; reason: string }
  /** The feed would be asked, but the day's allowance for it is spent (its own cap, or too few of the shared 25 calls left). */
  | { status: 'skipped'; reason: 'budget' | 'low-allowance' }
  /** A rate limit (daily or burst): the feed may well be available. */
  | { status: 'limited'; reason: string };

/** The fallback source of dividend events behind the job's port. */
export interface DividendFeed {
  readonly name: 'alphavantage';
  fetch(symbol: string, start: string, end: string): Promise<FeedAnswer>;
}

export interface AlphaVantageDividendsOptions {
  apiKey: string;
  http: HttpClient;
  bucket: TokenBucket;
  budget: EstimateBudget;
}

/** Calls of the shared Alpha Vantage allowance the dividends fallback may spend a day, and the reserve it leaves (the calendar, the profiles and the estimates need some). */
export const DIVIDEND_FEED_DAILY_CALLS = 4;
export const DIVIDEND_FEED_MIN_REMAINING = 6;
export const DIVIDEND_FEED_KEY_ITEM = { PK: 'USAGE', SK: 'alphavantage#dividends' } as const;

/** Alpha Vantage lists the dividends of US-listed companies, in dollars. */
const FEED_CURRENCY = 'USD';

function eventOf(symbol: string, row: unknown): DividendEvent | null {
  if (!isRecord(row)) return null;
  const exDate = isoDateOrNull(row.ex_dividend_date);
  const amount = asFloat(row.amount);
  if (exDate === null || amount === null || amount <= 0) return null;
  const payDate = isoDateOrNull(row.payment_date) ?? undefined;
  const declarationDate = isoDateOrNull(row.declaration_date) ?? undefined;
  const declared = declarationDate !== undefined || payDate !== undefined;
  return { symbol, exDate, amount, currency: FEED_CURRENCY, source: 'alphavantage', ...(payDate === undefined ? {} : { payDate }), ...(declarationDate === undefined ? {} : { declarationDate }), ...(declared ? { declared } : {}) };
}

export class AlphaVantageDividends implements DividendFeed {
  readonly name = 'alphavantage';

  constructor(private readonly options: AlphaVantageDividendsOptions) {}

  async fetch(symbol: string, start: string, end: string): Promise<FeedAnswer> {
    const room = await this.options.budget.room();
    if (!room.allowed) return { status: 'skipped', reason: room.reason === 'job-cap' ? 'budget' : 'low-allowance' };
    if (!(await this.options.budget.spend())) return { status: 'skipped', reason: 'budget' };
    await this.options.bucket.acquire(1);
    const raw = await this.options.http.getJson(ALPHAVANTAGE_URL, { function: 'DIVIDENDS', symbol: symbol.replaceAll('-', '.'), apikey: this.options.apiKey }, undefined, symbol);
    const data = isRecord(raw) ? raw : {};
    const notice = noticeOf(data);
    if (notice !== undefined) return this.refusal(notice, symbol);
    if (errorMessageOf(data) !== undefined) return { status: 'ok', events: [] };
    if (!Array.isArray(data.data)) throw new ProviderError('alphavantage: unexpected response for DIVIDENDS', { provider: 'alphavantage', symbol });
    const events = new Map<string, DividendEvent>();
    for (const row of data.data) {
      const event = eventOf(symbol, row);
      if (event !== null && event.exDate >= start && event.exDate <= end) events.set(event.exDate, event);
    }
    return { status: 'ok', events: [...events.values()].toSorted((a, b) => a.exDate.localeCompare(b.exDate)) };
  }

  private refusal(notice: NonNullable<ReturnType<typeof noticeOf>>, symbol: string): FeedAnswer {
    if (notice.kind === 'premium' || notice.kind === 'invalid-key') return { status: 'unavailable', reason: notice.message };
    return { status: 'limited', reason: limitError(notice, symbol).message };
  }
}
