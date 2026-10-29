import { z } from 'zod';
import type { ProviderBudgetReport } from './earnings-dates.js';

/**
 * The owner-only "Test Alpha Vantage now" action of Settings > Diagnostics: one real `EARNINGS_ESTIMATES` call for a fixed US ticker with the real
 * key, then (at least 1.5 s later) a control call of the free `EARNINGS` function with the same key, and what the provider said to each, side by side, so
 * the owner sees on screen whether the key is throttled or simply cannot read the estimates. It costs two of the 25 calls of the UTC day (one when the
 * first answer already says the day's quota is used), is refused when fewer than `PROBE_MIN_CALLS` are left by the app's own count and when it ran
 * less than `PROBE_INTERVAL_SECONDS` ago.
 */
export const ALPHAVANTAGE_PROBE_ROUTES = {
  alphaVantageProbeStatus: 'GET /diagnostics/alphavantage-probe',
  alphaVantageProbe: 'POST /diagnostics/alphavantage-probe',
} as const;

export const PROBE_SYMBOL = 'IBM';
export const PROBE_MIN_CALLS = 4;
export const PROBE_INTERVAL_SECONDS = 600;

/** What Alpha Vantage said: figures (`ok`), no estimates on the free key (`premium`), the day's quota (`daily-limit`), too fast (`burst-limit`), another limit text (`rate-limited`), a refused key, an unknown symbol, or no usable answer. */
export const PROBE_OUTCOMES = ['ok', 'premium', 'daily-limit', 'burst-limit', 'rate-limited', 'invalid-key', 'no-coverage', 'error'] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/** What the two calls together say: the key reads `EARNINGS` but not `EARNINGS_ESTIMATES` (a paid plan is needed), it is throttled, both work, or it cannot be told. */
export const PROBE_CONCLUSIONS = ['estimates-unavailable', 'throttled', 'both-ok', 'inconclusive'] as const;
export type ProbeConclusionKind = (typeof PROBE_CONCLUSIONS)[number];

export interface AlphaVantageProbeResult {
  /** When the call was made. */
  at: string;
  symbol: string;
  /** The provider function that was called. */
  call: 'EARNINGS_ESTIMATES';
  outcome: ProbeOutcome;
  /** The outcome in words: `ok: 12 quarters`, `premium endpoint: the free key cannot use it`, `rate limit (burst)` ... */
  summary: string;
  /** The provider's own words, sanitised (one line, no URL, at most 300 characters); absent for `ok`. */
  message?: string;
  /** Quarters in the answer (for `ok`). */
  quarters?: number;
  /** The control call (the free `EARNINGS` function, same key and ticker, at least 1.5 s later); absent for a result stored before it existed and when the first answer made it pointless. */
  control?: AlphaVantageProbeControl;
  /** The two outcomes side by side: `EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: ok, 80 quarters`. */
  comparison?: string;
  /** What they mean for this key. */
  conclusion?: { kind: ProbeConclusionKind; text: string };
}

export interface AlphaVantageProbeControl {
  call: 'EARNINGS';
  outcome: ProbeOutcome;
  summary: string;
  message?: string;
  /** Quarterly entries in the answer (for `ok`). */
  quarters?: number;
}

export type ProbeRefusal = 'not-configured' | 'rate-limited' | 'budget-low';

export interface AlphaVantageProbeStatus {
  /** False when this deployment cannot run the probe (the AWS stack, or no Alpha Vantage key). */
  available: boolean;
  /** Why not (null when available). */
  reason: string | null;
  /** When the probe may run again (null when it may now, or never). */
  nextAllowedAt: string | null;
  budget: ProviderBudgetReport | null;
  /** The last probe, if there was one. */
  last: AlphaVantageProbeResult | null;
  /** True for the demo and mock mode: the result is a sample, no call was made. */
  sample?: boolean;
}

export type RunAlphaVantageProbeResponse = AlphaVantageProbeResult & { budget: ProviderBudgetReport | null };

/** The words for an outcome, for the summary line. */
export function probeSummary(outcome: ProbeOutcome, quarters?: number): string {
  switch (outcome) {
    case 'ok':
      return `ok: ${quarters ?? 0} ${quarters === 1 ? 'quarter' : 'quarters'}`;
    case 'premium':
      return 'premium endpoint: the free key cannot use it';
    case 'daily-limit':
      return 'rate limit (daily): the 25 calls of the day are used';
    case 'burst-limit':
      return 'rate limit (burst): requests came too fast';
    case 'rate-limited':
      return 'rate limit (unspecified): the provider asked to slow down';
    case 'invalid-key':
      return 'invalid key: the provider refused the API key';
    case 'no-coverage':
      return 'no data: the provider has no estimates for the test ticker';
    default:
      return 'error: no usable answer';
  }
}

const LIMITED: readonly ProbeOutcome[] = ['daily-limit', 'burst-limit', 'rate-limited'];

/** The words of an outcome in the side-by-side line: `ok, 80 quarters`, `refused (generic limit text)`. */
export function probeShort(outcome: ProbeOutcome, quarters?: number): string {
  switch (outcome) {
    case 'ok':
      return `ok, ${quarters ?? 0} ${quarters === 1 ? 'quarter' : 'quarters'}`;
    case 'premium':
      return 'refused (premium endpoint)';
    case 'daily-limit':
      return 'refused (daily limit)';
    case 'burst-limit':
      return 'refused (burst limit)';
    case 'rate-limited':
      return 'refused (generic limit text)';
    case 'invalid-key':
      return 'refused (invalid key)';
    case 'no-coverage':
      return 'no data for the test ticker';
    default:
      return 'no usable answer';
  }
}

/** `EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: ok, 80 quarters`; just the first part when there was no control call. */
export function probeComparison(estimates: Pick<AlphaVantageProbeResult, 'outcome' | 'quarters'>, control?: Pick<AlphaVantageProbeControl, 'outcome' | 'quarters'>): string {
  const first = `EARNINGS_ESTIMATES: ${probeShort(estimates.outcome, estimates.quarters)}`;
  return control === undefined ? first : `${first} / EARNINGS: ${probeShort(control.outcome, control.quarters)}`;
}

export const CONCLUSION_TEXT: Readonly<Record<ProbeConclusionKind, string>> = {
  'estimates-unavailable': 'Your key can read EARNINGS but not EARNINGS_ESTIMATES: estimates (and revenue consensus) need a paid Alpha Vantage plan. The app shows the EPS estimate from EARNINGS instead.',
  throttled: 'Both calls were limited: you are being throttled, try later.',
  'both-ok': 'Both calls worked: your key can read EARNINGS and EARNINGS_ESTIMATES.',
  inconclusive: 'The two calls gave different or unusable answers, so the cause cannot be told. Try again later.',
};

/**
 * What the outcomes of the two calls mean. The estimates refused with the generic limit text (or as a premium endpoint) while the free `EARNINGS`
 * function answered is a key that cannot read the estimates; both limited is a throttle; a daily-quota text needs no control call.
 */
export function probeConclusion(estimates: ProbeOutcome, control?: ProbeOutcome): { kind: ProbeConclusionKind; text: string } | undefined {
  const kind = conclusionKind(estimates, control);
  return kind === undefined ? undefined : { kind, text: CONCLUSION_TEXT[kind] };
}

function conclusionKind(estimates: ProbeOutcome, control: ProbeOutcome | undefined): ProbeConclusionKind | undefined {
  if (control === undefined) return estimates === 'daily-limit' ? 'throttled' : undefined;
  if (estimates === 'ok' && control === 'ok') return 'both-ok';
  if (control === 'ok' && (estimates === 'rate-limited' || estimates === 'premium')) return 'estimates-unavailable';
  return LIMITED.includes(estimates) && LIMITED.includes(control) ? 'throttled' : 'inconclusive';
}

const count = z.number().int().nonnegative();
const budgetSchema = z.object({ provider: z.literal('Alpha Vantage'), day: z.string().min(1), used: count, limit: count, remaining: count, calendarUsed: count, calendarLimit: count });
const controlSchema = z.object({
  call: z.literal('EARNINGS'),
  outcome: z.enum(PROBE_OUTCOMES),
  summary: z.string(),
  message: z.string().optional(),
  quarters: count.optional(),
});
const resultSchema = z.object({
  at: z.string().min(1),
  symbol: z.string().min(1),
  call: z.literal('EARNINGS_ESTIMATES'),
  outcome: z.enum(PROBE_OUTCOMES),
  summary: z.string(),
  message: z.string().optional(),
  quarters: count.optional(),
  control: controlSchema.optional(),
  comparison: z.string().optional(),
  conclusion: z.object({ kind: z.enum(PROBE_CONCLUSIONS), text: z.string() }).optional(),
});

/** Validates `GET /diagnostics/alphavantage-probe` (the web client parses it with this). */
export const alphaVantageProbeStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  nextAllowedAt: z.string().nullable(),
  budget: budgetSchema.nullable(),
  last: resultSchema.nullable(),
  sample: z.boolean().optional(),
});

/** Validates the 200 answer of `POST /diagnostics/alphavantage-probe`. */
export const alphaVantageProbeResultSchema = resultSchema.extend({ budget: budgetSchema.nullable() });
