/**
 * Currency helpers for broker imports (pure, shared by the Trading 212 sync service and the CSV converter).
 *
 * Trading 212 quotes some venues in minor units (`GBX` pence). Every stored price/amount must be in an ISO-4217
 * major currency, so those are divided by 100 and relabelled (same rule as the prices service).
 */
import { roundTo } from './analytics.js';


const MINOR_UNITS: Readonly<Record<string, { currency: string; divisor: number }>> = {
  GBX: { currency: 'GBP', divisor: 100 },
  ZAC: { currency: 'ZAR', divisor: 100 },
  ILA: { currency: 'ILS', divisor: 100 },
};

/** Upper-cased code; `GBp` (Yahoo style) is treated as `GBX`. */
const canonicalCode = (code: string): string => (code === 'GBp' ? 'GBX' : code.trim().toUpperCase());

export interface NormalizedCurrency {
  /** ISO-4217 major currency. */
  currency: string;
  /** Divide amounts quoted in the original currency by this to get major units (1 or 100). */
  divisor: number;
}

export function normalizeCurrency(code: string): NormalizedCurrency {
  const upper = canonicalCode(code);
  return MINOR_UNITS[upper] ?? { currency: upper, divisor: 1 };
}

/** Largest relative deviation between the reported FX rate and the one implied by the trade amounts. */
export const FX_TOLERANCE = 0.05;

export interface FxRateInput {
  /** Rate as reported by the broker; its direction is not trusted. */
  reported: number | undefined;
  /** |amount| in the account currency. */
  accountAmount: number | undefined;
  /** |amount| in the instrument's (major) currency. */
  localAmount: number;
}

/**
 * Units of instrument currency per 1 unit of account currency, or undefined when it cannot be established.
 *
 * Brokers disagree on the direction of "exchange rate" and the field is documented loosely, so the reported value
 * (or its inverse) is only accepted when it matches the rate implied by the amounts (`localAmount / accountAmount`,
 * which includes fees) within FX_TOLERANCE. Anything else yields undefined, i.e. "let the ECB fixing apply".
 */
export function resolveFxRate({ reported, accountAmount, localAmount }: FxRateInput): number | undefined {
  if (!reported || !Number.isFinite(reported) || reported <= 0) return undefined;
  if (!accountAmount || !Number.isFinite(accountAmount) || accountAmount <= 0 || localAmount <= 0) return undefined;
  const implied = localAmount / accountAmount;
  const [direct, inverse] = [reported, 1 / reported].map((candidate) => [candidate, Math.abs(candidate - implied) / implied] as const);
  const [best, error] = inverse![1] < direct![1] ? inverse! : direct!;
  return error <= FX_TOLERANCE ? roundTo(best, 6) : undefined;
}

export interface FeePart {
  amount: number;
  currency: string;
}

/** Sums fee parts in the instrument's major currency; parts in other currencies need the account->instrument rate. */
export function sumFees(parts: readonly FeePart[], instrumentCurrency: string, accountCurrency: string, rate: number | undefined) {
  let fee = 0;
  let unconverted = 0;
  for (const { amount, currency } of parts) {
    const c = normalizeCurrency(currency);
    if (c.currency === instrumentCurrency) fee += Math.abs(amount) / c.divisor;
    else if (rate !== undefined && c.currency === accountCurrency) fee += Math.abs(amount) * rate;
    else unconverted++;
  }
  return { fee: roundTo(fee, 6), unconverted };
}
