import {
  MAX_GOAL_CONTRIBUTION,
  MAX_GOAL_RATE_PCT,
  MAX_GOAL_TARGET,
  currentYearOf,
  goalSettingsSchemaFor,
  goalYearRange,
  type GoalSettings,
  type GoalType,
} from '@portfolio/shared';
import { ApiError } from '../../api/client';
import { formatMoney, normalizeDecimalInput } from '../../lib/format';

export interface GoalFormValues {
  goalType: GoalType;
  targetAmount: string;
  targetYear: string;
  monthlyContribution: string;
  priceReturnPct: string;
  /** Empty = use the portfolio's current yield. */
  startYieldPct: string;
  dividendGrowthPct: string;
  yieldOnNewMoneyPct: string;
  inflationPct: string;
  adjustForInflation: boolean;
  reinvestDividends: boolean;
}

export type GoalField = Exclude<keyof GoalFormValues, 'goalType' | 'adjustForInflation' | 'reinvestDividends'>;
export type GoalFieldErrors = Partial<Record<GoalField, string>>;

/** Fields in the expandable "Returns and inflation" section. */
export const ADVANCED_FIELDS: readonly GoalField[] = ['priceReturnPct', 'startYieldPct', 'dividendGrowthPct', 'yieldOnNewMoneyPct', 'inflationPct'];

interface FieldRule {
  label: string;
  min: number;
  max: number;
}

const RATE = { min: 0, max: MAX_GOAL_RATE_PCT };

export const GOAL_FIELD_RULES: Record<GoalField, FieldRule> = {
  targetAmount: { label: 'Target amount', min: 1, max: MAX_GOAL_TARGET },
  targetYear: { label: 'Target year', min: 1900, max: 3000 },
  monthlyContribution: { label: 'Monthly contribution', min: 0, max: MAX_GOAL_CONTRIBUTION },
  priceReturnPct: { label: 'Price return', ...RATE },
  startYieldPct: { label: 'Dividend yield', ...RATE },
  dividendGrowthPct: { label: 'Dividend growth', ...RATE },
  yieldOnNewMoneyPct: { label: 'Yield on new money', ...RATE },
  inflationPct: { label: 'Inflation', ...RATE },
};

const asText = (n: number): string => String(n).replace('.', ',');

export function settingsToForm(s: GoalSettings): GoalFormValues {
  return {
    goalType: s.goalType,
    targetAmount: asText(s.targetAmount),
    targetYear: String(s.targetYear),
    monthlyContribution: asText(s.monthlyContribution),
    priceReturnPct: asText(s.priceReturnPct),
    startYieldPct: s.startYieldPct === null ? '' : asText(s.startYieldPct),
    dividendGrowthPct: asText(s.dividendGrowthPct),
    yieldOnNewMoneyPct: asText(s.yieldOnNewMoneyPct),
    inflationPct: asText(s.inflationPct),
    adjustForInflation: s.adjustForInflation,
    reinvestDividends: s.reinvestDividends,
  };
}

/** Typed text → number (Dutch or plain decimals); empty and unreadable text become NaN, which the schema rejects. */
const toNumber = (text: string): number => (text.trim() === '' ? Number.NaN : Number(normalizeDecimalInput(text)));

const rangeMessage = ({ label, min, max }: FieldRule): string =>
  `${label} must be a number between ${min.toLocaleString('nl-NL')} and ${max.toLocaleString('nl-NL')}.`;

export type GoalFormResult = { settings: GoalSettings } | { errors: GoalFieldErrors };

/** Validates the typed values with the API's own schema (target years relative to `today`, YYYY-MM-DD). */
export function parseGoalForm(values: GoalFormValues, today: string): GoalFormResult {
  const parsed = goalSettingsSchemaFor(today).safeParse({
    goalType: values.goalType,
    targetAmount: toNumber(values.targetAmount),
    targetYear: toNumber(values.targetYear),
    monthlyContribution: toNumber(values.monthlyContribution),
    priceReturnPct: toNumber(values.priceReturnPct),
    startYieldPct: values.startYieldPct.trim() === '' ? null : toNumber(values.startYieldPct),
    dividendGrowthPct: toNumber(values.dividendGrowthPct),
    yieldOnNewMoneyPct: toNumber(values.yieldOnNewMoneyPct),
    inflationPct: toNumber(values.inflationPct),
    adjustForInflation: values.adjustForInflation,
    reinvestDividends: values.reinvestDividends,
  });
  if (parsed.success) return { settings: parsed.data };
  const errors: GoalFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as GoalField;
    errors[field] ??= field === 'targetYear' ? issue.message : rangeMessage(GOAL_FIELD_RULES[field]);
  }
  return { errors };
}

/** Field errors of an API 400 (zod issues in `details`); empty for anything else. */
export function apiFieldErrors(err: unknown): GoalFieldErrors {
  const issues = err instanceof ApiError && Array.isArray(err.details) ? (err.details as { path?: unknown[] }[]) : [];
  const errors: GoalFieldErrors = {};
  for (const issue of issues) {
    const field = String(issue.path?.[0]) as GoalField;
    if (field in GOAL_FIELD_RULES) errors[field] ??= rangeMessage(GOAL_FIELD_RULES[field]);
  }
  return errors;
}

export const sameSettings = (a: GoalSettings, b: GoalSettings): boolean =>
  (Object.keys(a) as (keyof GoalSettings)[]).every((k) => a[k] === b[k]);

/** Selectable target years, nearest first. */
export function yearOptions(today: string): number[] {
  const { min, max } = goalYearRange(today);
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** Derived hint under the target amount. */
export function targetHint(s: GoalSettings, today: string, currency: string): string {
  if (s.goalType === 'income') return `${formatMoney(s.targetAmount / 12, currency, { maxDigits: 0 })} per month`;
  if (!s.adjustForInflation) return 'Not adjusted for inflation';
  const grown = s.targetAmount * (1 + s.inflationPct / 100) ** (s.targetYear - currentYearOf(today));
  return `${formatMoney(grown, currency, { maxDigits: 0 })} in ${s.targetYear} after inflation`;
}
