/**
 * Goals REST contract: one saved goal per user and scope (a portfolio or all portfolios combined), always projected
 * with today's portfolio numbers. Scope = `?portfolioId=` (omitted or `all` = every portfolio combined). Errors use the
 * standard envelope (400 VALIDATION_ERROR with field issues, 404 for an unknown portfolio).
 *
 * - GET    /goals            saved settings (or the defaults) + the computed projection
 * - PUT    /goals            body = settings; validates, saves and returns the same as GET
 * - DELETE /goals            removes the saved goal (204, also when none was saved)
 * - POST   /goals/calculate  body = settings; stateless preview, nothing is written
 *
 * Percentages are plain numbers (5 = 5 %) in fields suffixed `Pct`; amounts are in the base currency.
 */
import { z } from 'zod';
import { ALL_PORTFOLIOS } from './schemas.js';

export const GOALS_ROUTES = {
  goalsGet: 'GET /goals',
  goalsPut: 'PUT /goals',
  goalsDelete: 'DELETE /goals',
  goalsCalculate: 'POST /goals/calculate',
} as const;

// --- Single-table item (PK USER#{userId}, SK GOAL#{portfolioIdOrAll}, entityType GOAL) ------------------------------

export const GOAL_ENTITY = 'GOAL';

export const goalKeys = {
  goal: (userId: string, scope: string) => ({ PK: `USER#${userId}`, SK: `GOAL#${scope}` }),
  /** Every goal of a user. */
  prefix: 'GOAL#',
} as const;

// --- Settings --------------------------------------------------------------------------------------------------------

export const GOAL_TYPES = ['value', 'income'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];
export const GOAL_TYPE_LABELS: Record<GoalType, string> = { value: 'Portfolio value', income: 'Passive income' };

/** The target year must lie between next year and this many years ahead. */
export const MAX_GOAL_HORIZON_YEARS = 60;
export const MAX_GOAL_TARGET = 1e9;
export const MAX_GOAL_CONTRIBUTION = 1e6;
export const MAX_GOAL_RATE_PCT = 30;
export const DEFAULT_GOAL_YEARS_AHEAD = 30;
/** Default target per goal type: a portfolio of € 500.000, or € 24.000 (= € 2.000 per month) of dividends a year. */
export const DEFAULT_GOAL_TARGETS: Record<GoalType, number> = { value: 500_000, income: 24_000 };

const rate = z.number().min(0).max(MAX_GOAL_RATE_PCT);

/** Shape of the settings without the target-year window (which depends on the current year). */
export const goalSettingsBaseSchema = z.object({
  goalType: z.enum(GOAL_TYPES),
  /** Portfolio value, or annual dividend income, in today's euros (see `adjustForInflation`). */
  targetAmount: z.number().positive().max(MAX_GOAL_TARGET),
  targetYear: z.number().int().min(1900).max(3000),
  monthlyContribution: z.number().min(0).max(MAX_GOAL_CONTRIBUTION).default(0),
  /** Expected yearly price return of the holdings; only used by portfolio-value goals. */
  priceReturnPct: rate.default(5),
  /** Starting dividend yield on the portfolio; null = the portfolio's current forward yield. */
  startYieldPct: rate.nullable().default(null),
  dividendGrowthPct: rate.default(5),
  yieldOnNewMoneyPct: rate.default(3.5),
  inflationPct: rate.default(2),
  /** Grow the target by the inflation rate every year (target is in today's euros). */
  adjustForInflation: z.boolean().default(true),
  reinvestDividends: z.boolean().default(true),
});
export type GoalSettings = z.infer<typeof goalSettingsBaseSchema>;
export type GoalSettingsInput = z.input<typeof goalSettingsBaseSchema>;

export const currentYearOf = (today: string): number => Number(today.slice(0, 4));

/** Inclusive range of selectable target years for a given "today" (YYYY-MM-DD). */
export const goalYearRange = (today: string): { min: number; max: number } => {
  const year = currentYearOf(today);
  return { min: year + 1, max: year + MAX_GOAL_HORIZON_YEARS };
};

/** Settings schema for requests: the base shape plus the target-year window relative to `today`. */
export const goalSettingsSchemaFor = (today: string) =>
  goalSettingsBaseSchema.superRefine((s, ctx) => {
    const { min, max } = goalYearRange(today);
    if (s.targetYear < min || s.targetYear > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetYear'], message: `Target year must be between ${min} and ${max}` });
    }
  });

export function defaultGoalSettings(today: string): GoalSettings {
  return goalSettingsBaseSchema.parse({
    goalType: 'income',
    targetAmount: DEFAULT_GOAL_TARGETS.income,
    targetYear: currentYearOf(today) + DEFAULT_GOAL_YEARS_AHEAD,
    monthlyContribution: 250,
  });
}

/** Stored goal item (without the key attributes). `portfolioId` is a portfolio id or `all`. */
export interface GoalItem extends GoalSettings {
  userId: string;
  portfolioId: string;
  createdAt: string;
  updatedAt: string;
}

export const goalScopeKey = (portfolioId: string | undefined): string => portfolioId ?? ALL_PORTFOLIOS;

// --- Projection ------------------------------------------------------------------------------------------------------

export const GOAL_PLAN_IDS = ['plan', 'safe', 'alternative'] as const;
export type GoalPlanId = (typeof GOAL_PLAN_IDS)[number];

export interface GoalStart {
  /** Market value of the holdings today. */
  value: number;
  /** Forward 12-month dividend income today (or value × the overridden starting yield). */
  income: number;
  /** Starting yield used, percent. */
  yieldPct: number;
}

export interface GoalPlanResult {
  id: GoalPlanId;
  label: string;
  /** Parameters actually used, after the scenario adjustment. */
  priceReturnPct: number;
  dividendGrowthPct: number;
  yieldOnNewMoneyPct: number;
  /** Whole years from now until the goal is first reached (0 = already), null when not within the horizon. */
  yearsToGoal: number | null;
  /** Calendar year in which the goal is first reached. */
  reachedYear: number | null;
}

export interface GoalRow {
  /** Years from now (0 = today). */
  yearOffset: number;
  year: number;
  /** The (inflation-adjusted) goal in that year. */
  goal: number;
  /** Cumulative contributions, excluding reinvested dividends. */
  contributed: number;
  /** Portfolio value or annual passive income per scenario, depending on the goal type. */
  plan: number;
  safe: number;
  alternative: number;
}

export type GoalContributionStatus = 'none-needed' | 'required' | 'unattainable';

export interface GoalProjection {
  baseCurrency: string;
  goalType: GoalType;
  asOf: string;
  startYear: number;
  /** Chosen target year (moved to the nearest selectable year when the saved one has passed). */
  targetYear: number;
  targetYears: number;
  /** Years projected (the target horizon plus a margin to show when a late goal is reached). */
  horizonYears: number;
  start: GoalStart;
  /** Today's value or income, whichever the goal type measures. */
  currentAmount: number;
  /** Target in today's euros. */
  targetAmount: number;
  /** The goal in the target year (inflation-adjusted when enabled). */
  targetAmountAtTargetYear: number;
  monthlyContribution: number;
  scenarios: GoalPlanResult[];
  rows: GoalRow[];
  verdict: {
    reached: boolean;
    yearsToGoal: number | null;
    reachedYear: number | null;
    /** Reached in or before the target year. */
    onTime: boolean;
    /** Years after the target year, when reached late. */
    yearsLater: number | null;
    /** Years before the target year, when reached early. */
    yearsEarly: number | null;
  };
  /** The other scenario that reaches the goal sooner than "Your plan" (or reaches it when the plan does not). */
  earlierScenario: GoalPlanResult | null;
  requiredContribution: { status: GoalContributionStatus; monthly: number | null };
}

export interface GoalCalculateResponse {
  settings: GoalSettings;
  projection: GoalProjection;
}

export interface GoalResponse extends GoalCalculateResponse {
  saved: boolean;
  updatedAt: string | null;
}
