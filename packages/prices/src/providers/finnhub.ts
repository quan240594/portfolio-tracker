import type { StoredEarningsEvent } from '@portfolio/shared';
import { ProviderError, RateLimitError, type ProviderErrorDetails } from '../errors.js';
import type { HttpClient } from '../http.js';
import type { MinuteQuota, ProviderGate } from '../limits.js';
import { asFloat, asText, byText, definedOnly, isRecord, isoDateOrNull, ownValue, type JsonRecord } from '../parse.js';
import { addDays } from '../time.js';
import { earningsTargets, type EarningsTarget } from './calendar.js';

/**
 * Finnhub `/calendar/earnings` (official docs: https://finnhub.io/docs/api/earnings-calendar), asked for ONE company at a time:
 * `?symbol=AMZN&from=<today - 3 days>&to=<today + 90 days>`. The all-company calendar of a week is cut off at 1500 rows (the first week of a
 * season lost held companies); the per-company answer is exact and small. Free plan: the endpoint is not premium; 60 calls a minute (30 a
 * second on every plan), and the app never makes more than 30 a minute.
 * Response: `{"earningsCalendar":[{"date","epsActual","epsEstimate","hour","quarter","revenueActual","revenueEstimate","symbol","year"}]}` where
 * `hour` is `bmo` (before the market opens), `amc` (after it closes) or `dmh` (during market hours); a company without a date in the window
 * gets an empty list. US-listed companies only. No field says that a date is confirmed by the company, and none gives a clock time.
 * The key travels in the `X-Finnhub-Token` header only.
 */
export const FINNHUB_URL = 'https://finnhub.io/api/v1';
/** Dates within this many days (from today) are the ones Finnhub is trusted to know for sure: a stored date it does not list there has moved. */
export const FINNHUB_WINDOW_DAYS = 21;
/** A report from this many days back is kept, so a company that has just reported is told from one that is due. */
export const FINNHUB_LOOKBACK_DAYS = 3;
/** The next report is looked for this many days ahead (a quarter and a bit). */
export const FINNHUB_LOOKAHEAD_DAYS = 90;
/** Time between two calls of a run: 2.1 s keeps a minute at 29 calls at most, under the 30 a minute the app allows itself. */
export const FINNHUB_PACE_MS = 2100;
/** Calls a minute, counted across job steps and runs. */
export const FINNHUB_CALLS_PER_MINUTE = 30;
/** After a 429 nothing is asked of Finnhub for this long. */
export const FINNHUB_BACKOFF_MS = 10 * 60_000;

const HOUR: Readonly<Record<string, 'BMO' | 'AMC' | 'DMH'>> = { bmo: 'BMO', amc: 'AMC', dmh: 'DMH' };

/** Finnhub refused the key (HTTP 401 or 403, or an "Invalid API key" answer): every later call of the run would be refused too. */
export class FinnhubRefusedError extends ProviderError {
  override name = 'FinnhubRefusedError';
}

/** The calls of this minute are used up (by this run or another): the step waits `delayMs` and asks again. Not an error of the provider. */
export class FinnhubPacingError extends Error {
  override name = 'FinnhubPacingError';

  constructor(readonly delayMs: number) {
    super(`finnhub: waiting ${delayMs} ms for the next free call`);
  }
}

const refusedDetails = (status?: number): ProviderErrorDetails => ({ provider: 'finnhub', ...(status === undefined ? {} : { status }) });

/** Finnhub knows no company names, so only a company's own US ticker and a curated alias vouch for a holding. Finnhub ticker -> app symbols. */
export function finnhubTargets(symbols: readonly string[]): Map<string, EarningsTarget[]> {
  const targets = new Map<string, EarningsTarget[]>();
  for (const [ticker, entries] of earningsTargets(symbols)) {
    const vouched = entries.filter((target) => target.via !== 'base');
    if (vouched.length > 0) targets.set(ticker, vouched);
  }
  return targets;
}

/** A row that has a date: the report day, the category and the fiscal period (`year * 4 + quarter`) when the row gives one. */
export interface DatedRow {
  date: string;
  timeOfDay: 'BMO' | 'AMC' | 'DMH' | undefined;
  epsEstimate: number | undefined;
  period: number | undefined;
}

function periodOf(row: JsonRecord): number | undefined {
  const year = asFloat(row.year);
  const quarter = asFloat(row.quarter);
  if (year === null || quarter === null || !Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) return undefined;
  return year * 4 + quarter;
}

function datedRow(row: JsonRecord): DatedRow | undefined {
  const date = isoDateOrNull(asText(row.date).slice(0, 10));
  if (date === null) return undefined;
  return { date, timeOfDay: ownValue(HOUR, asText(row.hour).trim().toLowerCase()), epsEstimate: asFloat(row.epsEstimate) ?? undefined, period: periodOf(row) };
}

/**
 * The rows worth keeping: the next upcoming one (the first dated today or later) and the most recent one inside the look-back (a report that
 * has just happened). An upcoming row of a fiscal period that is not newer than the one just reported is a stale duplicate and is ignored.
 */
export function pickRows(rows: readonly DatedRow[], today: string): { recent: DatedRow | undefined; upcoming: DatedRow | undefined } {
  const since = addDays(today, -FINNHUB_LOOKBACK_DAYS);
  const sorted = rows.toSorted((a, b) => byText(a.date, b.date));
  const recent = sorted.findLast((row) => row.date >= since && row.date < today);
  const reported = recent?.period;
  const upcoming = sorted.find((row) => row.date >= today && !(reported !== undefined && row.period !== undefined && row.period <= reported));
  return { recent, upcoming };
}

/** What one company's answer gave. */
export interface FinnhubAnswer {
  /** Rows the answer listed. */
  rows: number;
  /** The events to store: the next upcoming report and a report of the last few days, for each app symbol of the ticker. */
  events: StoredEarningsEvent[];
  /** The next upcoming date, absent when there is none. */
  upcoming?: string;
}

const tickerOf = (row: JsonRecord): string => asText(row.symbol).trim().toUpperCase().replaceAll(/[-/]/g, '.');

/** The error text of a `{"error": "..."}` answer, as the kind of failure it means. */
function errorBody(payload: unknown): ProviderError | undefined {
  if (!isRecord(payload) || typeof payload.error !== 'string') return undefined;
  const text = payload.error.slice(0, 120);
  if (/api key|access to this resource/i.test(text)) return new FinnhubRefusedError(`finnhub: the key was refused or has no access to the earnings calendar (${text})`, refusedDetails());
  if (/limit/i.test(text)) return new RateLimitError(`finnhub: ${text}`, { provider: 'finnhub' });
  return new ProviderError(`finnhub: unexpected response for /calendar/earnings (${text})`, { provider: 'finnhub' });
}

/** The events of one company's answer; rows of another ticker and rows without a valid date are skipped. */
export function parseFinnhubCompany(payload: unknown, ticker: string, targets: readonly Pick<EarningsTarget, 'symbol'>[], today: string): FinnhubAnswer {
  const list = isRecord(payload) && Array.isArray(payload.earningsCalendar) ? (payload.earningsCalendar as unknown[]) : undefined;
  if (list === undefined) throw errorBody(payload) ?? new ProviderError('finnhub: unexpected response for /calendar/earnings', { provider: 'finnhub' });
  const dated = list.flatMap((row) => (isRecord(row) && tickerOf(row) === ticker ? [datedRow(row)] : [])).filter((row): row is DatedRow => row !== undefined);
  const { recent, upcoming } = pickRows(dated, today);
  const events = [recent, upcoming].flatMap((row) =>
    row === undefined ? [] : targets.map((target) => definedOnly<StoredEarningsEvent>({ symbol: target.symbol, date: row.date, epsEstimate: row.epsEstimate, timeOfDay: row.timeOfDay ?? 'unknown', source: 'finnhub' })),
  );
  return { rows: list.length, events, ...(upcoming === undefined ? {} : { upcoming: upcoming.date }) };
}

export interface FinnhubEarningsOptions {
  apiKey: string;
  http: HttpClient;
  /** Calls of the minute, persisted so that every job step and run shares them. */
  minute: MinuteQuota;
  /** The back-off after a 429, persisted for the same reason. */
  gate: ProviderGate;
  /** Epoch milliseconds. */
  now: () => number;
}

/**
 * The upcoming earnings of one company at a time. A call is one plain request; the job makes one per step and waits `FINNHUB_PACE_MS` between
 * steps. Raises `FinnhubRefusedError` (the key), `RateLimitError` (429 or the back-off that follows it: ask nothing else for a while) and
 * `FinnhubPacingError` (the minute's calls are used: wait and ask again); any other error is a failure of that company alone.
 */
export class FinnhubEarnings {
  readonly name = 'finnhub';

  constructor(private readonly options: FinnhubEarningsOptions) {}

  async fetchCompany(ticker: string, targets: readonly Pick<EarningsTarget, 'symbol'>[], today: string): Promise<FinnhubAnswer> {
    await this.options.gate.assertOpen();
    await this.pace();
    try {
      const params = { symbol: ticker, from: addDays(today, -FINNHUB_LOOKBACK_DAYS), to: addDays(today, FINNHUB_LOOKAHEAD_DAYS) };
      const body = await this.options.http.getJson(`${FINNHUB_URL}/calendar/earnings`, params, { 'X-Finnhub-Token': this.options.apiKey });
      return parseFinnhubCompany(body, ticker, targets, today);
    } catch (error) {
      throw await this.classify(error);
    }
  }

  private async pace(): Promise<void> {
    const { minute, now } = this.options;
    try {
      await minute.consume(1);
    } catch (error) {
      if (error instanceof RateLimitError && error.resetAtMs !== undefined) throw new FinnhubPacingError(Math.max(0, error.resetAtMs - now()));
      throw error;
    }
  }

  private async classify(error: unknown): Promise<unknown> {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
      return new FinnhubRefusedError(`finnhub: HTTP ${error.status}: the key was refused or has no access to the earnings calendar`, refusedDetails(error.status));
    }
    if (error instanceof RateLimitError) await this.options.gate.block(this.options.now() + FINNHUB_BACKOFF_MS, 'minute', error.message);
    return error;
  }
}
