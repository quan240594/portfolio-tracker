import { sequentially, type StoredEarningsEvent } from '@portfolio/shared';
import type { EarningsFetchReport, EarningsSource } from '@portfolio/platform';
import { ProviderError } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { TokenBucket } from '../limits.js';
import { asFloat, asText, byText, definedOnly, isRecord, isoDateOrNull, ownValue } from '../parse.js';
import { addDays } from '../time.js';
import { earningsTargets, type EarningsTarget } from './calendar.js';

/**
 * Finnhub `/calendar/earnings` (official docs: https://finnhub.io/docs/api/earnings-calendar). Free plan: the endpoint is not premium and the
 * free tier covers "1 month of historical earnings and new updates"; the plan allows 60 calls a minute (and 30 a second on every plan).
 * Response: `{"earningsCalendar":[{"date","epsActual","epsEstimate","hour","quarter","revenueActual","revenueEstimate","symbol","year"}]}` where
 * `hour` is `bmo` (before the market opens), `amc` (after it closes) or `dmh` (during market hours). US-listed companies only (the
 * `international` flag is not used). No field says that a date is confirmed by the company, and none gives a clock time.
 */
export const FINNHUB_URL = 'https://finnhub.io/api/v1';
/** Days ahead (from today) the calendar is asked for: what the confirmation window of the calendar needs. */
export const FINNHUB_WINDOW_DAYS = 21;
/** One call asks for this many days, so a response stays small whatever the provider's row cap. */
const CHUNK_DAYS = 7;

const HOUR: Readonly<Record<string, 'BMO' | 'AMC' | 'DMH'>> = { bmo: 'BMO', amc: 'AMC', dmh: 'DMH' };

/** The `[from, to]` days of every call: today..today+6, +7..+13 and +14..+21. */
export function finnhubChunks(today: string): { from: string; to: string }[] {
  const starts = [0, CHUNK_DAYS, 2 * CHUNK_DAYS];
  return starts.map((offset, index) => ({ from: addDays(today, offset), to: addDays(today, index === starts.length - 1 ? FINNHUB_WINDOW_DAYS : offset + CHUNK_DAYS - 1) }));
}

/** Finnhub knows no company names, so only a company's own US ticker and a curated alias vouch for a holding. */
const vouchedTargets = (targets: readonly EarningsTarget[]): EarningsTarget[] => targets.filter((target) => target.via !== 'base');

/** The events of one answer for the tickers in `targets`; rows without a valid date or a ticker we track are skipped. */
export function parseFinnhubRows(payload: unknown, targets: ReadonlyMap<string, readonly EarningsTarget[]>): { rows: number; events: StoredEarningsEvent[]; listed: string[] } {
  const list = isRecord(payload) && Array.isArray(payload.earningsCalendar) ? (payload.earningsCalendar as unknown[]) : undefined;
  if (list === undefined) throw new ProviderError('finnhub: unexpected response for /calendar/earnings', { provider: 'finnhub' });
  const events: StoredEarningsEvent[] = [];
  const listed = new Set<string>();
  for (const row of list) {
    if (!isRecord(row)) continue;
    const ticker = asText(row.symbol).trim().toUpperCase().replaceAll(/[-/]/g, '.');
    const matched = vouchedTargets(targets.get(ticker) ?? []);
    const date = isoDateOrNull(asText(row.date).slice(0, 10));
    for (const target of matched) listed.add(target.symbol);
    if (date === null) continue;
    const timeOfDay = ownValue(HOUR, asText(row.hour).trim().toLowerCase());
    for (const target of matched) {
      events.push(definedOnly<StoredEarningsEvent>({ symbol: target.symbol, date, epsEstimate: asFloat(row.epsEstimate) ?? undefined, timeOfDay: timeOfDay ?? 'unknown', source: 'finnhub' }));
    }
  }
  return { rows: list.length, events, listed: [...listed] };
}

export interface FinnhubEarningsOptions {
  apiKey: string;
  http: HttpClient;
  bucket: TokenBucket;
}

/** The next 21 days of earnings of the tracked US tickers: three calls (one per week), paced, each one a plain JSON list. */
export class FinnhubEarnings implements EarningsSource {
  readonly name = 'finnhub';
  readonly budgeted = true;
  /** Calls one run makes; the job spends this much of the day's budget. */
  readonly callsPerRun = 3;

  constructor(private readonly options: FinnhubEarningsOptions) {}

  async fetch(symbols: readonly string[], today: string): Promise<StoredEarningsEvent[]> {
    return (await this.fetchReport(symbols, today)).events;
  }

  async fetchReport(symbols: readonly string[], today: string): Promise<EarningsFetchReport> {
    const targets = earningsTargets(symbols);
    if (targets.size === 0) return { events: [], rows: 0, listed: [], unvouched: [] };
    const answers: ReturnType<typeof parseFinnhubRows>[] = [];
    for await (const answer of sequentially(finnhubChunks(today), (chunk) => this.read(chunk, targets))) answers.push(answer);
    const events = new Map<string, StoredEarningsEvent>();
    for (const event of answers.flatMap((answer) => answer.events)) events.set(`${event.symbol}\u0000${event.date}`, event);
    return {
      events: [...events.keys()].toSorted(byText).map((key) => events.get(key)!).filter((event) => event.date >= today),
      rows: answers.reduce((sum, answer) => sum + answer.rows, 0),
      listed: [...new Set(answers.flatMap((answer) => answer.listed))].toSorted(byText),
      unvouched: [],
    };
  }

  private async read(chunk: { from: string; to: string }, targets: ReadonlyMap<string, readonly EarningsTarget[]>): Promise<ReturnType<typeof parseFinnhubRows>> {
    await this.options.bucket.acquire(1);
    try {
      const body = await this.options.http.getJson(`${FINNHUB_URL}/calendar/earnings`, chunk, { 'X-Finnhub-Token': this.options.apiKey });
      return parseFinnhubRows(body, targets);
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
        throw new ProviderError(`finnhub: HTTP ${error.status}: the key was refused or has no access to the earnings calendar`, { provider: 'finnhub', status: error.status });
      }
      throw error;
    }
  }
}
