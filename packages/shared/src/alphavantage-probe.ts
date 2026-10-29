import { z } from 'zod';
import type { ProviderBudgetReport } from './earnings-dates.js';

/**
 * The owner-only "Test Alpha Vantage now" action of Settings > Diagnostics: one real `EARNINGS_ESTIMATES` call for a fixed US ticker with the real
 * key, and what the provider said, so the owner sees on screen which limit the key hits. It costs one of the 25 calls of the UTC day, is refused when
 * fewer than `PROBE_MIN_CALLS` are left by the app's own count and when it ran less than `PROBE_INTERVAL_SECONDS` ago.
 */
export const ALPHAVANTAGE_PROBE_ROUTES = {
  alphaVantageProbeStatus: 'GET /diagnostics/alphavantage-probe',
  alphaVantageProbe: 'POST /diagnostics/alphavantage-probe',
} as const;

export const PROBE_SYMBOL = 'IBM';
export const PROBE_MIN_CALLS = 3;
export const PROBE_INTERVAL_SECONDS = 600;

/** What Alpha Vantage said: figures (`ok`), no estimates on the free key (`premium`), the day's quota (`daily-limit`), too fast (`burst-limit`), another limit text (`rate-limited`), a refused key, an unknown symbol, or no usable answer. */
export const PROBE_OUTCOMES = ['ok', 'premium', 'daily-limit', 'burst-limit', 'rate-limited', 'invalid-key', 'no-coverage', 'error'] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

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

const count = z.number().int().nonnegative();
const budgetSchema = z.object({ provider: z.literal('Alpha Vantage'), day: z.string().min(1), used: count, limit: count, remaining: count, calendarUsed: count, calendarLimit: count });
const resultSchema = z.object({
  at: z.string().min(1),
  symbol: z.string().min(1),
  call: z.literal('EARNINGS_ESTIMATES'),
  outcome: z.enum(PROBE_OUTCOMES),
  summary: z.string(),
  message: z.string().optional(),
  quarters: count.optional(),
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
