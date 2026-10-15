import { defaultGoalSettings, projectGoal, type GoalSettings, type GoalStart } from '@portfolio/shared';
import { GOAL_MEASURE, adjustmentText, goalInsights, plural, verdictText } from './goalText';

const TODAY = '2026-10-15';
const start: GoalStart = { value: 10_000, income: 400, yieldPct: 4 };
const project = (over: Partial<GoalSettings>) =>
  projectGoal({
    settings: { ...defaultGoalSettings(TODAY), goalType: 'value', targetAmount: 100_000, targetYear: 2036, monthlyContribution: 0, reinvestDividends: false, adjustForInflation: false, ...over },
    start,
    today: TODAY,
    baseCurrency: 'EUR',
  });
const texts = (p: ReturnType<typeof project>) => goalInsights(p).map((i) => i.text.replace(/\u00a0/g, ' '));

describe('plural', () => {
  it('pluralises', () => {
    expect([plural(1, 'year'), plural(2, 'year'), plural(0, 'year')]).toEqual(['1 year', '2 years', '0 years']);
  });
});

describe('GOAL_MEASURE', () => {
  it('names what each goal type measures', () => {
    expect(GOAL_MEASURE.value.today).toBe('Portfolio value today');
    expect(GOAL_MEASURE.income.column).toBe('Annual income');
  });
});

describe('verdictText', () => {
  it('says when the goal is reached', () => {
    expect(verdictText(project({ targetAmount: 20_000, targetYear: 2056 }))).toBe('Achievable in 15 years (by 2041)');
    expect(verdictText(project({ targetAmount: 1000 }))).toBe('Goal already reached');
    expect(verdictText(project({ targetAmount: 1e9 }))).toBe('Not reached within the horizon');
  });
});

describe('goalInsights', () => {
  it('reports an early plan and the contribution needed', () => {
    const p = project({ targetAmount: 20_000, targetYear: 2056 });
    expect(goalInsights(p).map((i) => i.tone)).toEqual(['good', 'info', 'good']);
    expect(texts(p)).toEqual([
      'Your plan reaches the goal by 2056, 15 years early',
      expect.stringMatching(/^The Alternative scenario reaches the goal sooner, in 20\d\d$/),
      'Already on track: no monthly contribution needed to reach the goal in time',
    ]);
  });

  it('reports an on-time plan without an early margin', () => {
    expect(texts(project({ targetAmount: 16_288.95, targetYear: 2036 }))[0]).toBe('Your plan reaches the goal by 2036');
  });

  it('reports a late plan, a sooner scenario and the required contribution', () => {
    const p = project({ targetAmount: 40_000, targetYear: 2036 });
    expect(texts(p)).toEqual([
      'Your plan reaches the goal in 2055, 19 years later than you specified',
      expect.stringMatching(/^The Alternative scenario reaches the goal sooner, in 20\d\d$/),
      expect.stringMatching(/^€ [\d.]+ per month needed to reach the goal by 2036$/),
    ]);
    expect(goalInsights(p).map((i) => i.tone)).toEqual(['warn', 'info', 'info']);
  });

  it('reports a goal that is already reached', () => {
    expect(texts(project({ targetAmount: 1000 }))[0]).toBe('You have already reached this goal');
  });

  it('reports an unreachable goal', () => {
    expect(texts(project({ targetAmount: 1e9, targetYear: 2036 }))).toEqual([
      'Your plan does not reach the goal within 30 years',
      'Not reachable by 2036, even with € 1.000.000 per month',
    ]);
  });
});

describe('adjustmentText', () => {
  it('writes signed points', () => {
    expect(adjustmentText({ priceReturnPct: -2, dividendGrowthPct: -1, yieldOnNewMoneyPct: -0.5 })).toBe('\u22122 points price return, \u22121 points dividend growth, \u22120,5 points yield on new money');
    expect(adjustmentText({ priceReturnPct: 2, dividendGrowthPct: 1, yieldOnNewMoneyPct: 0.5 })).toBe('+2 points price return, +1 points dividend growth, +0,5 points yield on new money');
  });
});
