import { TICKER_ALIASES, CONSENSUS_KEEP_QUARTERS, type ConsensusFigure } from '@portfolio/shared';
import { z } from 'zod';
import { asFloat, isRecord } from '../parse.js';
import { exchangeSuffix, isCrypto } from '../symbols.js';
import { ALPHAVANTAGE_URL } from './alphavantage.js';
import { classifyNotice, errorMessageOf, noticeOf, type NoticeKind } from './av-notice.js';

/**
 * Analyst consensus from Alpha Vantage `EARNINGS_ESTIMATES`: per fiscal quarter (and year) the mean, the high, the low and the number of
 * analysts of the EPS and revenue estimates, for past quarters back to about 2017 and the next unreported ones. One call per symbol, from the
 * provider's 25 calls a day. Free-plan access is not guaranteed for a real key: an answer that says "premium endpoint" is its own outcome
 * (`premium`), a rate-limit notice another (`rate-limited`), and neither is ever mistaken for "no coverage".
 *
 * The answer, abbreviated (values are strings, a missing value is `null`, counts carry decimals):
 * `{ "symbol": "IBM", "estimates": [ { "date": "2026-12-31", "horizon": "fiscal quarter", "eps_estimate_average": "4.6278",
 *   "eps_estimate_high": "4.9", "eps_estimate_low": "4.4", "eps_estimate_analyst_count": "14.0000", "revenue_estimate_average": "20391352200.00",
 *   "revenue_estimate_high": ..., "revenue_estimate_low": ..., "revenue_estimate_analyst_count": "13.00", ... } ] }`
 */

/** One fiscal quarter of an answer. */
export interface EstimateQuarter {
  quarterEnd: string;
  eps?: ConsensusFigure;
  revenue?: ConsensusFigure;
  /** From `EARNINGS` (`parseEarnings`) only: the EPS the provider recorded as reported, and its own surprise (a cross-check, never the beat or miss). */
  reportedEps?: number;
  providerSurprise?: number;
}

/** The kind of limit a `rate-limited` answer is: the day's quota, a burst (too fast), or a notice that is neither (`other`). */
export type EstimateLimit = Extract<NoticeKind, 'daily' | 'burst' | 'other'>;

export type EstimatesAnswer =
  | { status: 'ok'; quarters: EstimateQuarter[]; /** `EARNINGS` only: quarterly entries in the answer, before the keep limit and whether or not they carry an estimate. */ available?: number }
  | { status: 'no-coverage' }
  | { status: 'premium'; detail?: string }
  | { status: 'rate-limited'; scope?: EstimateLimit; detail?: string }
  | { status: 'error'; reason: string; /** The key was refused. */ invalidKey?: true };

/** A number from a JSON number or a numeric string; "None", "", null and garbage are absent (never an error). */
const lenient = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => asFloat(value) ?? undefined);

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horizon: z.string(),
  eps_estimate_average: lenient,
  eps_estimate_high: lenient,
  eps_estimate_low: lenient,
  eps_estimate_analyst_count: lenient,
  revenue_estimate_average: lenient,
  revenue_estimate_high: lenient,
  revenue_estimate_low: lenient,
  revenue_estimate_analyst_count: lenient,
});

type Entry = z.infer<typeof entrySchema>;

const answerSchema = z.object({ estimates: z.array(z.unknown()) });

interface FigureFields {
  average: number | undefined;
  high: number | undefined;
  low: number | undefined;
  count: number | undefined;
}

function figureOf({ average, high, low, count }: FigureFields): ConsensusFigure | undefined {
  if (average === undefined) return undefined;
  return {
    average,
    ...(high === undefined ? {} : { high }),
    ...(low === undefined ? {} : { low }),
    ...(count === undefined || count < 0 ? {} : { analysts: Math.round(count) }),
  };
}

function quarterOf(entry: Entry): EstimateQuarter | undefined {
  const eps = figureOf({ average: entry.eps_estimate_average, high: entry.eps_estimate_high, low: entry.eps_estimate_low, count: entry.eps_estimate_analyst_count });
  const revenue = figureOf({ average: entry.revenue_estimate_average, high: entry.revenue_estimate_high, low: entry.revenue_estimate_low, count: entry.revenue_estimate_analyst_count });
  if (eps === undefined && revenue === undefined) return undefined;
  return { quarterEnd: entry.date, ...(eps === undefined ? {} : { eps }), ...(revenue === undefined ? {} : { revenue }) };
}

/** The fiscal quarters of an answer, newest first, at most `CONSENSUS_KEEP_QUARTERS`; entries that are malformed, yearly or without a figure are skipped. */
function quartersOf(entries: readonly unknown[]): EstimateQuarter[] {
  const seen = new Set<string>();
  const quarters: EstimateQuarter[] = [];
  for (const raw of entries) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success || !/quarter/i.test(parsed.data.horizon) || seen.has(parsed.data.date)) continue;
    const quarter = quarterOf(parsed.data);
    if (quarter === undefined) continue;
    seen.add(quarter.quarterEnd);
    quarters.push(quarter);
  }
  return quarters.toSorted((a, b) => b.quarterEnd.localeCompare(a.quarterEnd)).slice(0, CONSENSUS_KEEP_QUARTERS);
}

/** Alpha Vantage answers a refusal with HTTP 200 and one of `Information`, `Note` or `Error Message`; the full sanitised text is kept as the detail. */
function refusalOf(json: Record<string, unknown>): EstimatesAnswer | undefined {
  const notice = noticeOf(json);
  if (notice !== undefined) return answerFor(notice.kind, notice.message);
  const message = errorMessageOf(json);
  if (message === undefined) return undefined;
  // An `Error Message` is an unknown symbol (no coverage) unless it says the key was refused.
  return classifyNotice(message) === 'invalid-key' ? answerFor('invalid-key', message) : { status: 'no-coverage' };
}

function answerFor(kind: NoticeKind, message: string): EstimatesAnswer {
  if (kind === 'premium') return { status: 'premium', detail: message };
  if (kind === 'invalid-key') return { status: 'error', reason: `the API key was refused: ${message}`, invalidKey: true };
  return { status: 'rate-limited', scope: kind, detail: message };
}

// --- The free `EARNINGS` function: EPS estimate per past quarter, nothing else ----------------------------------------------

const earningsEntrySchema = z.object({
  fiscalDateEnding: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reportedEPS: lenient,
  estimatedEPS: lenient,
  surprise: lenient,
});

const earningsAnswerSchema = z.object({ quarterlyEarnings: z.array(z.unknown()) });

/**
 * What an `EARNINGS` answer says, as EPS-only quarters (the average is `estimatedEPS`; there is no range, no analyst count and no revenue). The free
 * key reads this function. Abbreviated, values are strings and a missing one is `"None"`:
 * `{ "symbol": "IBM", "annualEarnings": [...], "quarterlyEarnings": [ { "fiscalDateEnding": "2026-03-31", "reportedDate": "2026-04-22",
 *   "reportedEPS": "1.91", "estimatedEPS": "1.81", "surprise": "0.1", "surprisePercentage": "5.5249", "reportTime": "post-market" }, ... ] }`
 * `available` counts every quarterly entry (about 80); `quarters` are the newest `CONSENSUS_KEEP_QUARTERS` that carry an estimate. Never throws.
 */
export function parseEarnings(json: unknown): EstimatesAnswer {
  if (!isRecord(json)) return { status: 'error', reason: 'the answer was not a JSON object' };
  const refusal = refusalOf(json);
  if (refusal !== undefined) return refusal;
  const answer = earningsAnswerSchema.safeParse(json);
  if (!answer.success) return Object.keys(json).length === 0 || 'annualEarnings' in json ? { status: 'no-coverage' } : { status: 'error', reason: 'the answer has no list of quarterly earnings' };
  if (answer.data.quarterlyEarnings.length === 0) return { status: 'no-coverage' };
  return { status: 'ok', quarters: epsQuartersOf(answer.data.quarterlyEarnings), available: answer.data.quarterlyEarnings.length };
}

function epsQuartersOf(entries: readonly unknown[]): EstimateQuarter[] {
  const seen = new Set<string>();
  const quarters: EstimateQuarter[] = [];
  for (const raw of entries) {
    const parsed = earningsEntrySchema.safeParse(raw);
    if (!parsed.success || parsed.data.estimatedEPS === undefined || seen.has(parsed.data.fiscalDateEnding)) continue;
    const { fiscalDateEnding, estimatedEPS, reportedEPS, surprise } = parsed.data;
    seen.add(fiscalDateEnding);
    quarters.push({
      quarterEnd: fiscalDateEnding,
      eps: { average: estimatedEPS },
      ...(reportedEPS === undefined ? {} : { reportedEps: reportedEPS }),
      ...(surprise === undefined ? {} : { providerSurprise: surprise }),
    });
  }
  return quarters.toSorted((a, b) => b.quarterEnd.localeCompare(a.quarterEnd)).slice(0, CONSENSUS_KEEP_QUARTERS);
}

/** What an `EARNINGS_ESTIMATES` answer says. Never throws: anything unexpected is an `error` with a short reason. */
export function parseEarningsEstimates(json: unknown): EstimatesAnswer {
  if (!isRecord(json)) return { status: 'error', reason: 'the answer was not a JSON object' };
  const refusal = refusalOf(json);
  if (refusal !== undefined) return refusal;
  if (Object.keys(json).length === 0) return { status: 'no-coverage' };
  const answer = answerSchema.safeParse(json);
  if (!answer.success) return { status: 'error', reason: 'the answer has no list of estimates' };
  const quarters = quartersOf(answer.data.estimates);
  return quarters.length === 0 ? { status: 'no-coverage' } : { status: 'ok', quarters };
}

/**
 * The Alpha Vantage ticker of an app symbol: a US ticker is its own (a class share with a dot, `BRK.B`); a suffixed listing (`FOO.DE`) only
 * through the curated alias table, since the bare ticker of another exchange can be another company; crypto has none.
 */
export function estimateTicker(symbol: string): { ticker: string; via: 'direct' | 'alias' } | null {
  if (isCrypto(symbol)) return null;
  const suffix = exchangeSuffix(symbol);
  if (suffix === null) return { ticker: symbol.replaceAll('-', '.'), via: 'direct' };
  const alias = TICKER_ALIASES.get(symbol.slice(0, -(suffix.length + 1)));
  return alias === undefined ? null : { ticker: alias, via: 'alias' };
}

export interface EstimatesClientOptions {
  apiKey: string;
  /** The alarm's counted `fetch`. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Resolves when a request may start (`ProviderPacer.wait`): the provider limits bursts, so calls are spaced. Absent: no waiting. */
  pace?: () => Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** A host's own limit on outbound requests (Cloudflare: `Subrequest ...`): the caller defers the step, it is not the provider's answer. */
const isHostLimit = (error: unknown): boolean => error instanceof Error && error.name.startsWith('Subrequest');

export class AlphaVantageEstimatesClient {
  constructor(private readonly options: EstimatesClientOptions) {}

  /** One call: the consensus of a ticker. Budgeting is the caller's (`EstimateBudget`). */
  fetchEstimates(ticker: string): Promise<EstimatesAnswer> {
    return this.request('EARNINGS_ESTIMATES', ticker, parseEarningsEstimates);
  }

  /** One call: the EPS estimates of the past quarters of a ticker, from the free `EARNINGS` function (EPS only). Budgeting is the caller's. */
  fetchEarnings(ticker: string): Promise<EstimatesAnswer> {
    return this.request('EARNINGS', ticker, parseEarnings);
  }

  private async request(fn: 'EARNINGS' | 'EARNINGS_ESTIMATES', ticker: string, parse: (json: unknown) => EstimatesAnswer): Promise<EstimatesAnswer> {
    const { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options;
    const url = `${ALPHAVANTAGE_URL}?function=${fn}&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`;
    await this.options.pace?.();
    let response: Response;
    try {
      response = await this.options.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isHostLimit(error)) throw error;
      return { status: 'error', reason: 'the request failed' };
    }
    if (response.status === 429) return { status: 'rate-limited', scope: 'other', detail: 'the provider answered 429 (too many requests)' };
    if (!response.ok) return { status: 'error', reason: `the provider answered ${response.status}` };
    try {
      return parse(await response.json());
    } catch {
      return { status: 'error', reason: 'the answer was not JSON' };
    }
  }
}
