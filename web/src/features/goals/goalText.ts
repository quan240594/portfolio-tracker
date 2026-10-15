import { GOAL_TYPE_LABELS, MAX_GOAL_CONTRIBUTION, type GoalPlanResult, type GoalProjection, type GoalType } from '@portfolio/shared';
import { formatMoney } from '../../lib/format';

export const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** What the goal measures, for labels. */
export const GOAL_MEASURE: Record<GoalType, { title: string; today: string; column: string }> = {
  value: { title: GOAL_TYPE_LABELS.value, today: 'Portfolio value today', column: 'Portfolio value' },
  income: { title: GOAL_TYPE_LABELS.income, today: 'Annual passive income today', column: 'Annual income' },
};

/** Headline verdict of "Your plan". */
export function verdictText(p: GoalProjection): string {
  const { yearsToGoal, reachedYear } = p.verdict;
  if (yearsToGoal === null) return 'Not reached within the horizon';
  if (yearsToGoal === 0) return 'Goal already reached';
  return `Achievable in ${plural(yearsToGoal, 'year')} (by ${reachedYear})`;
}

export interface GoalInsight {
  id: 'plan' | 'earlier' | 'contribution';
  tone: 'good' | 'warn' | 'info';
  text: string;
}

function planInsight(p: GoalProjection): GoalInsight {
  const { onTime, yearsLater, yearsEarly, reachedYear, yearsToGoal } = p.verdict;
  if (yearsToGoal === null) return { id: 'plan', tone: 'warn', text: `Your plan does not reach the goal within ${plural(p.horizonYears, 'year')}` };
  if (yearsToGoal === 0) return { id: 'plan', tone: 'good', text: 'You have already reached this goal' };
  if (!onTime) return { id: 'plan', tone: 'warn', text: `Your plan reaches the goal in ${reachedYear}, ${plural(yearsLater!, 'year')} later than you specified` };
  const early = yearsEarly === null ? '' : `, ${plural(yearsEarly, 'year')} early`;
  return { id: 'plan', tone: 'good', text: `Your plan reaches the goal by ${p.targetYear}${early}` };
}

function earlierInsight(s: GoalPlanResult): GoalInsight {
  return { id: 'earlier', tone: 'info', text: `The ${s.label} scenario reaches the goal sooner, in ${s.reachedYear}` };
}

function contributionInsight(p: GoalProjection, currency: string): GoalInsight {
  const { status, monthly } = p.requiredContribution;
  if (status === 'none-needed') return { id: 'contribution', tone: 'good', text: 'Already on track: no monthly contribution needed to reach the goal in time' };
  if (status === 'unattainable') {
    const cap = formatMoney(MAX_GOAL_CONTRIBUTION, currency, { maxDigits: 0 });
    return { id: 'contribution', tone: 'warn', text: `Not reachable by ${p.targetYear}, even with ${cap} per month` };
  }
  const amount = formatMoney(monthly!, currency, { maxDigits: 0 });
  return { id: 'contribution', tone: 'info', text: `${amount} per month needed to reach the goal by ${p.targetYear}` };
}

/** Insight chips: plan verdict against the chosen year, a sooner scenario, and the contribution needed. */
export function goalInsights(p: GoalProjection): GoalInsight[] {
  return [planInsight(p), ...(p.earlierScenario ? [earlierInsight(p.earlierScenario)] : []), contributionInsight(p, p.baseCurrency)];
}

const signedPoints = (n: number): string => `${n > 0 ? '+' : '\u2212'}${Math.abs(n).toLocaleString('nl-NL')}`;

/** "−2 points price return, −1 point …" for a scenario adjustment. */
export function adjustmentText(adj: { priceReturnPct: number; dividendGrowthPct: number; yieldOnNewMoneyPct: number }): string {
  return `${signedPoints(adj.priceReturnPct)} points price return, ${signedPoints(adj.dividendGrowthPct)} points dividend growth, ${signedPoints(adj.yieldOnNewMoneyPct)} points yield on new money`;
}
