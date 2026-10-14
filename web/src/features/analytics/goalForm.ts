import { DEFAULT_GOAL, MAX_GOAL_YEARS, analyticsGoalQuerySchema, type AnalyticsGoalParams } from '@portfolio/shared';
import { normalizeDecimalInput } from '../../lib/format';

export interface GoalFormValues {
  targetIncome: string;
  dividendGrowthPct: string;
  yieldOnNewMoneyPct: string;
  monthlyContribution: string;
  currentYieldPct: string;
  years: string;
  reinvestDividends: boolean;
}

export type GoalField = Exclude<keyof GoalFormValues, 'reinvestDividends'>;

interface FieldRule {
  label: string;
  min: number;
  max: number;
  integer?: boolean;
}

export const GOAL_FIELD_RULES: Record<GoalField, FieldRule> = {
  targetIncome: { label: 'Target annual income', min: 1, max: 1e9 },
  dividendGrowthPct: { label: 'Dividend growth', min: 0, max: 30 },
  yieldOnNewMoneyPct: { label: 'Yield on new money', min: 0, max: 20 },
  monthlyContribution: { label: 'Monthly contribution', min: 0, max: 1e7 },
  currentYieldPct: { label: 'Starting yield', min: 0, max: 50 },
  years: { label: 'Horizon', min: 1, max: MAX_GOAL_YEARS, integer: true },
};

const asText = (n: number) => String(n).replace('.', ',');

export const DEFAULT_GOAL_FORM: GoalFormValues = {
  targetIncome: asText(DEFAULT_GOAL.targetIncome),
  dividendGrowthPct: asText(DEFAULT_GOAL.dividendGrowthPct),
  yieldOnNewMoneyPct: asText(DEFAULT_GOAL.yieldOnNewMoneyPct),
  monthlyContribution: asText(DEFAULT_GOAL.monthlyContribution),
  currentYieldPct: '',
  years: asText(DEFAULT_GOAL.years),
  reinvestDividends: true,
};

export type GoalFormResult = { params: AnalyticsGoalParams } | { errors: Partial<Record<GoalField, string>> };

const rangeMessage = ({ label, min, max, integer }: FieldRule) =>
  `${label} must be ${integer ? 'a whole number' : 'a number'} between ${min.toLocaleString('nl-NL')} and ${max.toLocaleString('nl-NL')}.`;

/** Validates the typed values (Dutch or plain decimals) with the API's own schema. */
export function parseGoalForm(values: GoalFormValues): GoalFormResult {
  const parsed = analyticsGoalQuerySchema.omit({ portfolioId: true }).safeParse({
    targetIncome: normalizeDecimalInput(values.targetIncome),
    dividendGrowthPct: normalizeDecimalInput(values.dividendGrowthPct),
    yieldOnNewMoneyPct: normalizeDecimalInput(values.yieldOnNewMoneyPct),
    monthlyContribution: normalizeDecimalInput(values.monthlyContribution),
    currentYieldPct: normalizeDecimalInput(values.currentYieldPct),
    years: normalizeDecimalInput(values.years),
    reinvestDividends: String(values.reinvestDividends),
  });
  if (parsed.success) return { params: parsed.data };
  const errors: Partial<Record<GoalField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as GoalField;
    errors[field] ??= rangeMessage(GOAL_FIELD_RULES[field]);
  }
  return { errors };
}
