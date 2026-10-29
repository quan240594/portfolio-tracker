import { RateLimitError } from '../errors.js';
import { RESET_MARGIN_MS } from '../limits.js';

/**
 * What Alpha Vantage says when it refuses a request. A refusal is HTTP 200 with a JSON object carrying `Information`, `Note` or `Error Message`
 * (no status code tells them apart), so the text is the only evidence. Texts seen on the free plan:
 *  - daily quota: "Our standard API rate limit is 25 requests per day ..."
 *  - burst: "Burst pattern detected. Please consider spreading out your free API requests more sparingly (1 request per second) ..."
 *  - premium endpoint: "This is a premium endpoint ..."
 *  - "Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume."
 *  - a bad key: "the parameter apikey is invalid or missing ..."
 * Anything else in `Information` or `Note` is treated as a limit too: it is never mistaken for a plain failure or for "no coverage".
 */
export type NoticeKind = 'premium' | 'invalid-key' | 'daily' | 'burst' | 'other';

export interface AlphaVantageNotice {
  kind: NoticeKind;
  /** The provider's text, sanitised (one line, no URL, at most `NOTICE_MAX` characters). */
  message: string;
}

export const NOTICE_MAX = 300;
/** A burst is over in seconds; asking again after two minutes is safe. */
export const BURST_RETRY_MS = 2 * 60_000;
/** An unrecognised limit text: back off a quarter of an hour, doubling on repeats. */
export const OTHER_RETRY_MS = 15 * 60_000;
export const INVALID_KEY_RETRY_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

const PREMIUM = /premium endpoint/i;
const INVALID_KEY = /api\s?key.{0,40}(?:invalid|missing)|invalid api\s?key/i;
const BURST = /burst|per second|more sparingly|call frequency|per minute/i;
const DAILY = /per day|25 requests|\bdaily\b|a day/i;

/** The text as one short, safe line: no URL (so no `apikey=` parameter), no control characters, at most 300 characters. */
export function sanitizeNotice(text: string): string {
  return text
    .replaceAll(/https?:\/\/\S+/gi, '(link)')
    .replaceAll(/apikey=\S+/gi, 'apikey=(hidden)')
    .replaceAll(/[^\x20-\x7e]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, NOTICE_MAX);
}

/** Which refusal a text is. The order matters: the premium-plan sales text of a quota notice must not read as "premium endpoint". */
export function classifyNotice(text: string): NoticeKind {
  if (PREMIUM.test(text)) return 'premium';
  if (INVALID_KEY.test(text)) return 'invalid-key';
  if (BURST.test(text)) return 'burst';
  return DAILY.test(text) ? 'daily' : 'other';
}

/** The refusal in an answer's `Information` or `Note`; `undefined` when there is none. (`Error Message` is not a limit: see `errorMessageOf`.) */
export function noticeOf(json: Readonly<Record<string, unknown>>): AlphaVantageNotice | undefined {
  const text = [json.Information, json.Note].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return text === undefined ? undefined : { kind: classifyNotice(text), message: sanitizeNotice(text) };
}

/** The `Error Message` of an answer (an unknown symbol or a bad call), sanitised; `undefined` when there is none. */
export function errorMessageOf(json: Readonly<Record<string, unknown>>): string | undefined {
  const text = json['Error Message'];
  return typeof text === 'string' && text.trim() !== '' ? sanitizeNotice(text) : undefined;
}

const BASE_RETRY_MS: Readonly<Record<'burst' | 'other' | 'invalid-key', number>> = { burst: BURST_RETRY_MS, other: OTHER_RETRY_MS, 'invalid-key': INVALID_KEY_RETRY_MS };

/** The next UTC midnight after `nowMs`, plus a margin: when a daily allowance is back. */
export const nextDayStartMs = (nowMs: number): number => Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS + RESET_MARGIN_MS;

/**
 * When to ask again after a refusal: a daily quota or a premium endpoint at the next UTC midnight; a burst after two minutes, a bad key after an
 * hour and anything else after 15 minutes, each doubling with every `strikes` (earlier refusals the same day) but never past the next UTC midnight.
 */
export function resumeAtMs(kind: NoticeKind, nowMs: number, strikes = 0): number {
  const reset = nextDayStartMs(nowMs);
  if (kind === 'daily' || kind === 'premium') return reset;
  return Math.min(nowMs + BASE_RETRY_MS[kind] * 2 ** strikes, reset);
}

const LABEL: Readonly<Record<NoticeKind, string>> = {
  premium: 'premium endpoint',
  'invalid-key': 'invalid key',
  daily: 'daily limit',
  burst: 'burst limit',
  other: 'rate limited',
};

/** A `RateLimitError` for a refusal: a daily quota has scope `day`, any other refusal names how long to wait; the message keeps the provider's text. */
export function limitError(notice: AlphaVantageNotice, symbol?: string): RateLimitError {
  const wait = notice.kind === 'daily' || notice.kind === 'premium' ? undefined : BASE_RETRY_MS[notice.kind];
  return new RateLimitError(`alphavantage: ${LABEL[notice.kind]}: ${notice.message}`, {
    provider: 'alphavantage',
    ...(symbol === undefined ? {} : { symbol }),
    ...(notice.kind === 'daily' ? { scope: 'day' as const } : {}),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
  });
}
