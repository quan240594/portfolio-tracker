/**
 * Goal planner maths (pure, no I/O): projects a portfolio-value or passive-income goal year by year for three
 * scenarios, adjusts the target for inflation and solves the monthly contribution needed to hit the target year.
 * See docs/architecture.md "Goals".
 *
 * Model (monthly steps, year-end points):
 * - Value goals: value × (1+price return)^(1/12) + contribution, and — when dividends are reinvested — plus the
 *   dividends of the month. The dividend run-rate grows at the dividend growth rate; every contribution and
 *   reinvested dividend buys extra income at the yield on new money (the same income model as the Analytics goal).
 * - Income goals: the Analytics income projection (`projectIncomeGoal`), so both agree for equal inputs. The price
 *   return plays no role there: income grows by dividend growth and by what contributions/reinvestment buy.
 * - Contributions are flat nominal amounts; only the target is indexed with inflation.
 */
import { projectIncomeGoal, roundTo } from './analytics.js';
import { computeGoal, type AnalyticsData } from './analytics-compute.js';
import { analyticsGoalQuerySchema } from './analytics-api.js';
import {
  GOAL_PLAN_IDS,
  MAX_GOAL_CONTRIBUTION,
  MAX_GOAL_HORIZON_YEARS,
  currentYearOf,
  defaultGoalSettings,
  goalSettingsBaseSchema,
  goalYearRange,
  type GoalPlanId,
  type GoalPlanResult,
  type GoalProjection,
  type GoalRow,
  type GoalSettings,
  type GoalStart,
} from './goals-api.js';

export const GOAL_PLAN_LABELS: Record<GoalPlanId, string> = { plan: 'Your plan', safe: 'Safe', alternative: 'Alternative' };

/**
 * Percentage-point adjustments of the safe and alternative scenarios relative to "Your plan". Dividend cuts are not
 * modelled: the safe scenario only grows dividends more slowly. Price return only affects portfolio-value goals.
 */
export const GOAL_SCENARIO_ADJUSTMENTS: Record<GoalPlanId, { priceReturnPct: number; dividendGrowthPct: number; yieldOnNewMoneyPct: number }> = {
  plan: { priceReturnPct: 0, dividendGrowthPct: 0, yieldOnNewMoneyPct: 0 },
  safe: { priceReturnPct: -2, dividendGrowthPct: -1, yieldOnNewMoneyPct: -0.5 },
  alternative: { priceReturnPct: 2, dividendGrowthPct: 1, yieldOnNewMoneyPct: 0.5 },
};

/** Years projected beyond the target year, so a late goal still shows when it is reached. */
export const GOAL_EXTRA_YEARS = 20;

interface SimParams {
  startValue: number;
  startIncome: number;
  monthlyContribution: number;
  priceReturnPct: number;
  dividendGrowthPct: number;
  yieldOnNewMoneyPct: number;
  reinvestDividends: boolean;
}

const monthlyFactor = (pct: number): number => (1 + pct / 100) ** (1 / 12);

/** Year-end portfolio values (index 0 = today) of the monthly value model. */
function simulateValue(p: SimParams, years: number): number[] {
  const priceFactor = monthlyFactor(p.priceReturnPct);
  const growthFactor = monthlyFactor(p.dividendGrowthPct);
  const newYield = p.yieldOnNewMoneyPct / 100;
  let value = p.startValue;
  let income = p.startIncome;
  const values = [roundTo(value)];
  for (let month = 1; month <= years * 12; month++) {
    income *= growthFactor;
    const reinvested = p.reinvestDividends ? income / 12 : 0;
    value = value * priceFactor + p.monthlyContribution + reinvested;
    income += (p.monthlyContribution + reinvested) * newYield;
    if (month % 12 === 0) values.push(roundTo(value));
  }
  return values;
}

/** Year-end annual income (index 0 = today) from the Analytics income projection (its "base" scenario, unshifted). */
function simulateIncome(p: SimParams, years: number): number[] {
  const base = projectIncomeGoal({
    targetIncome: 1,
    startIncome: p.startIncome,
    dividendGrowthPct: p.dividendGrowthPct,
    yieldOnNewMoneyPct: p.yieldOnNewMoneyPct,
    monthlyContribution: p.monthlyContribution,
    reinvestDividends: p.reinvestDividends,
    years,
  }).find((s) => s.id === 'base')!;
  return base.points.map((pt) => pt.income);
}

/** Starting income: the portfolio's forward income, or value × the overridden starting yield. */
function startIncomeOf(settings: GoalSettings, start: GoalStart): number {
  return settings.startYieldPct === null ? start.income : roundTo((start.value * settings.startYieldPct) / 100);
}

const clampRate = (pct: number): number => Math.max(0, pct);

function paramsFor(settings: GoalSettings, start: GoalStart, id: GoalPlanId, monthlyContribution = settings.monthlyContribution): SimParams {
  const adj = GOAL_SCENARIO_ADJUSTMENTS[id];
  return {
    startValue: start.value,
    startIncome: startIncomeOf(settings, start),
    monthlyContribution,
    priceReturnPct: clampRate(settings.priceReturnPct + adj.priceReturnPct),
    dividendGrowthPct: clampRate(settings.dividendGrowthPct + adj.dividendGrowthPct),
    yieldOnNewMoneyPct: clampRate(settings.yieldOnNewMoneyPct + adj.yieldOnNewMoneyPct),
    reinvestDividends: settings.reinvestDividends,
  };
}

/** Value or income per year for one scenario, depending on the goal type. */
export function projectGoalSeries(settings: GoalSettings, start: GoalStart, id: GoalPlanId, years: number, monthlyContribution?: number): number[] {
  const params = paramsFor(settings, start, id, monthlyContribution);
  return settings.goalType === 'income' ? simulateIncome(params, years) : simulateValue(params, years);
}

/** The goal per year: the target, grown by the inflation rate every year when `adjustForInflation` is on. */
export function inflationAdjustedGoal(targetAmount: number, inflationPct: number, years: number, adjust = true): number[] {
  return Array.from({ length: years + 1 }, (_, k) => roundTo(adjust ? targetAmount * (1 + inflationPct / 100) ** k : targetAmount));
}

/** Index (= years from now) of the first year in which the values reach the goal; null when they never do. */
export function firstYearReached(values: readonly number[], goal: readonly number[]): number | null {
  const index = values.findIndex((v, i) => v >= goal[i]!);
  return index === -1 ? null : index;
}

/**
 * Smallest whole-euro monthly contribution for which `reaches` holds, found by bisection over 0..`cap` (`reaches` must be
 * monotone: more money never hurts). 0 when no contribution is needed, null when even `cap` is not enough.
 */
export function solveRequiredContribution(reaches: (monthly: number) => boolean, cap = MAX_GOAL_CONTRIBUTION): number | null {
  if (reaches(0)) return 0;
  if (!reaches(cap)) return null;
  let low = 0; // never reaches
  let high = cap; // always reaches
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (reaches(mid)) high = mid;
    else low = mid;
  }
  return high;
}

/** Brings stored/requested settings into the selectable window: a target year that has passed moves to next year. */
export function normalizeGoalSettings(settings: GoalSettings, today: string): GoalSettings {
  const { min, max } = goalYearRange(today);
  return { ...settings, targetYear: Math.min(max, Math.max(min, settings.targetYear)) };
}

/** Settings of a stored item: invalid or unknown shapes fall back to the defaults. */
export function parseStoredGoal(item: unknown, today: string): GoalSettings {
  const parsed = goalSettingsBaseSchema.safeParse(item);
  return normalizeGoalSettings(parsed.success ? parsed.data : defaultGoalSettings(today), today);
}

/** Today's value, forward income and yield of the scope, from the Analytics goal calculator (no own maths). */
export function computeGoalStart(data: AnalyticsData): GoalStart {
  const { inputs } = computeGoal(data, analyticsGoalQuerySchema.parse({}));
  return { value: inputs.currentValue, income: inputs.currentIncome, yieldPct: inputs.currentYieldPct };
}

export interface ProjectGoalInput {
  settings: GoalSettings;
  start: GoalStart;
  /** YYYY-MM-DD; the current day of the projection. */
  today: string;
  baseCurrency: string;
}

function planResult(
  id: GoalPlanId,
  settings: GoalSettings,
  start: GoalStart,
  yearsToGoal: number | null,
  startYear: number,
): GoalPlanResult {
  const p = paramsFor(settings, start, id);
  return {
    id,
    label: GOAL_PLAN_LABELS[id],
    priceReturnPct: p.priceReturnPct,
    dividendGrowthPct: p.dividendGrowthPct,
    yieldOnNewMoneyPct: p.yieldOnNewMoneyPct,
    yearsToGoal,
    reachedYear: yearsToGoal === null ? null : startYear + yearsToGoal,
  };
}

/** The most optimistic other scenario that reaches the goal sooner than "Your plan" (the safe one never beats the alternative). */
function earlierScenarioOf(scenarios: readonly GoalPlanResult[]): GoalPlanResult | null {
  const [plan, safe, alternative] = scenarios;
  const planYears = plan?.yearsToGoal ?? Number.POSITIVE_INFINITY;
  const sooner = (s: GoalPlanResult | undefined) => s?.yearsToGoal !== null && s?.yearsToGoal !== undefined && s.yearsToGoal < planYears;
  return [alternative, safe].find(sooner) ?? null;
}

function requiredContributionOf(settings: GoalSettings, start: GoalStart, targetYears: number, goalAtTarget: number): GoalProjection['requiredContribution'] {
  const reaches = (monthly: number) => projectGoalSeries(settings, start, 'plan', targetYears, monthly).at(-1)! >= goalAtTarget;
  const monthly = solveRequiredContribution(reaches);
  if (monthly === null) return { status: 'unattainable', monthly: null };
  return { status: monthly === 0 ? 'none-needed' : 'required', monthly };
}

/** Projects the goal for the three scenarios from today's portfolio numbers. */
export function projectGoal({ settings: requested, start, today, baseCurrency }: ProjectGoalInput): GoalProjection {
  const settings = normalizeGoalSettings(requested, today);
  const startYear = currentYearOf(today);
  const targetYears = settings.targetYear - startYear;
  const horizonYears = Math.min(MAX_GOAL_HORIZON_YEARS, targetYears + GOAL_EXTRA_YEARS);
  const goal = inflationAdjustedGoal(settings.targetAmount, settings.inflationPct, horizonYears, settings.adjustForInflation);
  const series = GOAL_PLAN_IDS.map((id) => projectGoalSeries(settings, start, id, horizonYears));
  const scenarios = GOAL_PLAN_IDS.map((id, i) => planResult(id, settings, start, firstYearReached(series[i]!, goal), startYear));
  const monthlyYear = settings.monthlyContribution * 12;

  const rows: GoalRow[] = goal.map((g, k) => ({
    yearOffset: k,
    year: startYear + k,
    goal: g,
    contributed: roundTo(monthlyYear * k),
    plan: series[0]![k]!,
    safe: series[1]![k]!,
    alternative: series[2]![k]!,
  }));

  const yearsToGoal = scenarios[0]!.yearsToGoal;
  const reached = yearsToGoal !== null;
  const onTime = reached && yearsToGoal <= targetYears;
  const goalAtTarget = goal[targetYears]!;

  return {
    baseCurrency,
    goalType: settings.goalType,
    asOf: today,
    startYear,
    targetYear: settings.targetYear,
    targetYears,
    horizonYears,
    start: { value: start.value, income: startIncomeOf(settings, start), yieldPct: settings.startYieldPct ?? start.yieldPct },
    currentAmount: roundTo(settings.goalType === 'income' ? startIncomeOf(settings, start) : start.value),
    targetAmount: settings.targetAmount,
    targetAmountAtTargetYear: goalAtTarget,
    monthlyContribution: settings.monthlyContribution,
    scenarios,
    rows,
    verdict: {
      reached,
      yearsToGoal,
      reachedYear: scenarios[0]!.reachedYear,
      onTime,
      yearsLater: reached && !onTime ? yearsToGoal - targetYears : null,
      yearsEarly: onTime && yearsToGoal < targetYears ? targetYears - yearsToGoal : null,
    },
    earlierScenario: earlierScenarioOf(scenarios),
    requiredContribution: requiredContributionOf(settings, start, targetYears, goalAtTarget),
  };
}

/** The projection for the scope's current data (what GET/PUT/POST /goals return). */
export function computeGoalProjection(data: AnalyticsData, settings: GoalSettings): GoalProjection {
  return projectGoal({ settings, start: computeGoalStart(data), today: data.today, baseCurrency: data.fx.base });
}

export const GOAL_CSV_HEADER = 'year,goal,contributions,your_plan,safe,alternative';

/** The year-by-year table as CSV (dot decimals, base currency, oldest year first). */
export function goalRowsToCsv(rows: readonly GoalRow[]): string {
  const lines = rows.map((r) => [r.year, r.goal, r.contributed, r.plan, r.safe, r.alternative].join(','));
  return [GOAL_CSV_HEADER, ...lines].join('\n') + '\n';
}
