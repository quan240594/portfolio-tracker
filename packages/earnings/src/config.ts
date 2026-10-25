import { DEFAULT_AI_MODEL } from './ai.js';
import { EARNINGS_BACKFILL_DEFAULT_QUARTERS, EARNINGS_BACKFILL_MAX_QUARTERS } from '@portfolio/shared';

/** Default and maximum neurons the feature may spend per UTC day (the Free plan allows 10,000; 80 % is where the budget guard blocks). */
export const DEFAULT_DAILY_NEURONS = 6000;
export const MAX_DAILY_NEURONS = 8000;

export interface EarningsConfig {
  /** The complete `User-Agent` for every SEC request (`SEC_CONTACT`); absent or invalid = the feature reports "not configured". */
  secUserAgent?: string;
  /** Why `SEC_CONTACT` was not accepted, for the status page (never the value). */
  secProblem?: 'missing' | 'invalid';
  model: string;
  dailyNeurons: number;
  /** Quarterly releases per holding the backfill reads (`EARNINGS_BACKFILL_QUARTERS`, 1 to 8, default 4). */
  backfillQuarters: number;
  /** Whether the optional Alpha Vantage key (EPS estimates) exists. */
  estimatesConfigured: boolean;
}

export interface EarningsEnv {
  SEC_CONTACT?: string;
  EARNINGS_AI_MODEL?: string;
  EARNINGS_AI_DAILY_NEURONS?: string;
  EARNINGS_BACKFILL_QUARTERS?: string;
  ALPHAVANTAGE_API_KEY?: string;
}

const MODEL_PATTERN = /^@(?:cf|hf)\/[A-Za-z0-9._/-]{3,100}$/;
const PRINTABLE_ASCII = /^[\u0020-\u007e]+$/;

/**
 * The SEC asks every automated client for a declared `User-Agent` with contact information. The value must be printable ASCII (no line
 * breaks, so it cannot inject headers), 10 to 200 characters, and carry an e-mail address or a URL.
 */
export function validSecContact(value: string | undefined): value is string {
  if (value === undefined) return false;
  const text = value.trim();
  return text.length >= 10 && text.length <= 200 && PRINTABLE_ASCII.test(text) && (text.includes('@') || text.includes('http'));
}

export function parseEarningsConfig(env: EarningsEnv): EarningsConfig {
  const contact = env.SEC_CONTACT?.trim();
  const requested = Number.parseInt(env.EARNINGS_AI_DAILY_NEURONS ?? '', 10);
  const dailyNeurons = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, MAX_DAILY_NEURONS) : DEFAULT_DAILY_NEURONS;
  const model = env.EARNINGS_AI_MODEL?.trim();
  const quarters = Number.parseInt(env.EARNINGS_BACKFILL_QUARTERS ?? '', 10);
  const valid = validSecContact(contact);
  return {
    ...(valid ? { secUserAgent: contact } : {}),
    ...(valid ? {} : { secProblem: contact === undefined || contact === '' ? ('missing' as const) : ('invalid' as const) }),
    model: model !== undefined && MODEL_PATTERN.test(model) ? model : DEFAULT_AI_MODEL,
    dailyNeurons,
    backfillQuarters: Number.isFinite(quarters) && quarters >= 1 ? Math.min(quarters, EARNINGS_BACKFILL_MAX_QUARTERS) : EARNINGS_BACKFILL_DEFAULT_QUARTERS,
    estimatesConfigured: (env.ALPHAVANTAGE_API_KEY ?? '').trim() !== '',
  };
}
