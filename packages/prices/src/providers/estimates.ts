import { TICKER_ALIASES, CONSENSUS_KEEP_QUARTERS, type ConsensusFigure } from '@portfolio/shared';
import { z } from 'zod';
import { asFloat, isRecord } from '../parse.js';
import { exchangeSuffix, isCrypto } from '../symbols.js';
import { ALPHAVANTAGE_URL } from './alphavantage.js';

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
}

export type EstimatesAnswer =
  | { status: 'ok'; quarters: EstimateQuarter[] }
  | { status: 'no-coverage' | 'premium' | 'rate-limited' }
  | { status: 'error'; reason: string };

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

const PREMIUM = /premium endpoint/i;
const RATE_LIMITED = /rate limit|requests per day|call frequency|calls per (?:minute|day)|spreading out/i;

/** A provider message as a short reason: one line, no URL, at most 100 characters. */
function brief(message: string): string {
  return message.replaceAll(/https?:\/\/\S+/gi, '').replaceAll(/\s+/g, ' ').trim().slice(0, 100);
}

/** Alpha Vantage answers a refusal with HTTP 200 and one of `Information`, `Note` or `Error Message`. */
function noticeOf(json: Record<string, unknown>): EstimatesAnswer | undefined {
  const message = [json.Information, json.Note].find((value): value is string => typeof value === 'string' && value !== '');
  if (message !== undefined) {
    if (PREMIUM.test(message)) return { status: 'premium' };
    if (RATE_LIMITED.test(message)) return { status: 'rate-limited' };
    return { status: 'error', reason: brief(message) || 'the provider sent a notice' };
  }
  return typeof json['Error Message'] === 'string' ? { status: 'no-coverage' } : undefined;
}

/** What an `EARNINGS_ESTIMATES` answer says. Never throws: anything unexpected is an `error` with a short reason. */
export function parseEarningsEstimates(json: unknown): EstimatesAnswer {
  if (!isRecord(json)) return { status: 'error', reason: 'the answer was not a JSON object' };
  const notice = noticeOf(json);
  if (notice !== undefined) return notice;
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
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** A host's own limit on outbound requests (Cloudflare: `Subrequest ...`): the caller defers the step, it is not the provider's answer. */
const isHostLimit = (error: unknown): boolean => error instanceof Error && error.name.startsWith('Subrequest');

export class AlphaVantageEstimatesClient {
  constructor(private readonly options: EstimatesClientOptions) {}

  /** One call: the consensus of a ticker. Budgeting is the caller's (`EstimateBudget`). */
  async fetchEstimates(ticker: string): Promise<EstimatesAnswer> {
    const { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options;
    const url = `${ALPHAVANTAGE_URL}?function=EARNINGS_ESTIMATES&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isHostLimit(error)) throw error;
      return { status: 'error', reason: 'the request failed' };
    }
    if (response.status === 429) return { status: 'rate-limited' };
    if (!response.ok) return { status: 'error', reason: `the provider answered ${response.status}` };
    try {
      return parseEarningsEstimates(await response.json());
    } catch {
      return { status: 'error', reason: 'the answer was not JSON' };
    }
  }
}
