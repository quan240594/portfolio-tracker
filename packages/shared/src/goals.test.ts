import { describe, expect, it } from 'vitest';
import { projectIncomeGoal } from './analytics.js';
import type { AnalyticsData } from './analytics-compute.js';
import {
  GOALS_ROUTES,
  GOAL_ENTITY,
  MAX_GOAL_HORIZON_YEARS,
  currentYearOf,
  defaultGoalSettings,
  goalKeys,
  goalScopeKey,
  goalSettingsSchemaFor,
  goalYearRange,
  type GoalSettings,
  type GoalStart,
} from './goals-api.js';
import {
  GOAL_CSV_HEADER,
  GOAL_EXTRA_YEARS,
  GOAL_PLAN_LABELS,
  GOAL_SCENARIO_ADJUSTMENTS,
  computeGoalProjection,
  computeGoalStart,
  firstYearReached,
  goalRowsToCsv,
  inflationAdjustedGoal,
  normalizeGoalSettings,
  parseStoredGoal,
  projectGoal,
  projectGoalSeries,
  solveRequiredContribution,
} from './goals.js';

const TODAY = '2026-10-15';
const start: GoalStart = { value: 10_000, income: 400, yieldPct: 4 };

const settings = (over: Partial<GoalSettings> = {}): GoalSettings => ({
  ...defaultGoalSettings(TODAY),
  goalType: 'value',
  targetAmount: 100_000,
  targetYear: 2056,
  monthlyContribution: 0,
  priceReturnPct: 5,
  startYieldPct: null,
  reinvestDividends: false,
  adjustForInflation: false,
  inflationPct: 2,
  ...over,
});

describe('goal contract', () => {
  it('keys the item under the user with the scope in the sort key', () => {
    expect(goalKeys.goal('u1', 'all')).toEqual({ PK: 'USER#u1', SK: 'GOAL#all' });
    expect(goalKeys.goal('u1', 'p-2')).toEqual({ PK: 'USER#u1', SK: 'GOAL#p-2' });
    expect(GOAL_ENTITY).toBe('GOAL');
    expect(goalKeys.prefix).toBe('GOAL#');
    expect(goalScopeKey(undefined)).toBe('all');
    expect(goalScopeKey('p-2')).toBe('p-2');
    expect(Object.values(GOALS_ROUTES)).toEqual(['GET /goals', 'PUT /goals', 'DELETE /goals', 'POST /goals/calculate']);
  });

  it('derives the selectable years from today', () => {
    expect(currentYearOf(TODAY)).toBe(2026);
    expect(goalYearRange(TODAY)).toEqual({ min: 2027, max: 2026 + MAX_GOAL_HORIZON_YEARS });
  });

  it('defaults to an income goal 30 years ahead', () => {
    expect(defaultGoalSettings(TODAY)).toEqual({
      goalType: 'income',
      targetAmount: 24_000,
      targetYear: 2056,
      monthlyContribution: 250,
      priceReturnPct: 5,
      startYieldPct: null,
      dividendGrowthPct: 5,
      yieldOnNewMoneyPct: 3.5,
      inflationPct: 2,
      adjustForInflation: true,
      reinvestDividends: true,
    });
  });

  describe('goalSettingsSchemaFor', () => {
    const schema = goalSettingsSchemaFor(TODAY);
    const ok = { goalType: 'value', targetAmount: 1000, targetYear: 2040 };

    it('applies defaults to optional fields', () => {
      expect(schema.parse(ok)).toMatchObject({ monthlyContribution: 0, priceReturnPct: 5, startYieldPct: null, inflationPct: 2, adjustForInflation: true, reinvestDividends: true });
    });

    it('strips unknown keys', () => {
      expect(schema.parse({ ...ok, userId: 'evil' })).not.toHaveProperty('userId');
    });

    it.each([
      [{ goalType: 'other' }, 'goalType'],
      [{ targetAmount: 0 }, 'targetAmount'],
      [{ targetAmount: -5 }, 'targetAmount'],
      [{ targetAmount: 2e9 }, 'targetAmount'],
      [{ targetYear: 2026 }, 'targetYear'],
      [{ targetYear: 2087 }, 'targetYear'],
      [{ targetYear: 2040.5 }, 'targetYear'],
      [{ monthlyContribution: -1 }, 'monthlyContribution'],
      [{ monthlyContribution: 2e6 }, 'monthlyContribution'],
      [{ priceReturnPct: 31 }, 'priceReturnPct'],
      [{ dividendGrowthPct: -1 }, 'dividendGrowthPct'],
      [{ yieldOnNewMoneyPct: 40 }, 'yieldOnNewMoneyPct'],
      [{ inflationPct: 31 }, 'inflationPct'],
      [{ startYieldPct: 31 }, 'startYieldPct'],
      [{ reinvestDividends: 'yes' }, 'reinvestDividends'],
    ])('rejects %j', (bad, field) => {
      const res = schema.safeParse({ ...ok, ...bad });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.issues[0]?.path).toEqual([field]);
    });

    it('accepts the boundary years and a null starting yield', () => {
      expect(schema.safeParse({ ...ok, targetYear: 2027, startYieldPct: null }).success).toBe(true);
      expect(schema.safeParse({ ...ok, targetYear: 2086, startYieldPct: 0 }).success).toBe(true);
    });
  });
});

describe('projectGoalSeries', () => {
  it('compounds € 10.000 at 5 % to 16.288,95 after ten years without contributions', () => {
    const values = projectGoalSeries(settings(), start, 'plan', 10);
    expect(values).toHaveLength(11);
    expect(values[0]).toBe(10_000);
    expect(values[1]).toBe(10_500);
    expect(values[10]).toBe(16_288.95);
  });

  it('adds contributions at the end of each month', () => {
    const n = 120;
    const mp = 1.05 ** (1 / 12);
    const expected = 10_000 * 1.05 ** 10 + 100 * ((mp ** n - 1) / (mp - 1));
    expect(projectGoalSeries(settings({ monthlyContribution: 100 }), start, 'plan', 10).at(-1)).toBeCloseTo(expected, 1);
  });

  it('reinvests the dividends of the month when enabled', () => {
    const without = projectGoalSeries(settings({ priceReturnPct: 0 }), start, 'plan', 1)[1]!;
    const withDiv = projectGoalSeries(settings({ priceReturnPct: 0, reinvestDividends: true }), start, 'plan', 1)[1]!;
    expect(without).toBe(10_000);
    // 400 a year growing 5 % + reinvested at 3,5 %: a bit above 400
    expect(withDiv).toBeGreaterThan(10_400);
    expect(withDiv).toBeLessThan(10_450);
  });

  it('uses an overridden starting yield for the dividend run-rate', () => {
    const portfolioYield = projectGoalSeries(settings({ priceReturnPct: 0, reinvestDividends: true }), start, 'plan', 5).at(-1)!;
    const lower = projectGoalSeries(settings({ priceReturnPct: 0, reinvestDividends: true, startYieldPct: 1 }), start, 'plan', 5).at(-1)!;
    expect(lower).toBeLessThan(portfolioYield);
    expect(lower).toBeGreaterThan(10_000);
  });

  it('applies the scenario adjustments, never below zero', () => {
    const safe = projectGoalSeries(settings(), start, 'safe', 10).at(-1)!;
    const alt = projectGoalSeries(settings(), start, 'alternative', 10).at(-1)!;
    expect(safe).toBe(Math.round(10_000 * 1.03 ** 10 * 100) / 100);
    expect(alt).toBe(Math.round(10_000 * 1.07 ** 10 * 100) / 100);
    expect(projectGoalSeries(settings({ priceReturnPct: 1 }), start, 'safe', 3).at(-1)).toBe(10_000);
  });

  it('agrees with the Analytics income goal for equivalent inputs', () => {
    const s = settings({ goalType: 'income', targetAmount: 5000, monthlyContribution: 300, dividendGrowthPct: 6, yieldOnNewMoneyPct: 4, reinvestDividends: true });
    const analytics = projectIncomeGoal({
      targetIncome: 5000,
      startIncome: start.income,
      dividendGrowthPct: 6,
      yieldOnNewMoneyPct: 4,
      monthlyContribution: 300,
      reinvestDividends: true,
      years: 25,
    }).find((x) => x.id === 'base')!;
    expect(projectGoalSeries(s, start, 'plan', 25)).toEqual(analytics.points.map((p) => p.income));

    const projection = projectGoal({ settings: s, start, today: TODAY, baseCurrency: 'EUR' });
    expect(projection.scenarios[0]!.yearsToGoal).toBe(Math.ceil(analytics.yearsToGoal!));
  });

  it('starts income goals from the overridden yield on the portfolio value', () => {
    const s = settings({ goalType: 'income', startYieldPct: 2, monthlyContribution: 0, dividendGrowthPct: 0 });
    expect(projectGoalSeries(s, start, 'plan', 2)).toEqual([200, 200, 200]);
  });
});

describe('inflationAdjustedGoal', () => {
  it('grows the target by the inflation rate every year', () => {
    const goal = inflationAdjustedGoal(100_000, 2, 10);
    expect(goal).toHaveLength(11);
    expect(goal[0]).toBe(100_000);
    expect(goal[1]).toBe(102_000);
    expect(goal[10]).toBe(121_899.44);
  });

  it('keeps the target flat when the adjustment is off', () => {
    expect(inflationAdjustedGoal(50_000, 2, 3, false)).toEqual([50_000, 50_000, 50_000, 50_000]);
  });
});

describe('firstYearReached', () => {
  it('returns the first index at or above the goal', () => {
    expect(firstYearReached([1, 2, 3, 4], [5, 5, 3, 3])).toBe(2);
    expect(firstYearReached([5, 1], [5, 5])).toBe(0);
  });

  it('returns null when never reached', () => {
    expect(firstYearReached([1, 2], [5, 5])).toBeNull();
  });
});

describe('solveRequiredContribution', () => {
  it('finds the exact whole-euro threshold of a closed-form case', () => {
    expect(solveRequiredContribution((c) => c * 12 >= 3000)).toBe(250);
    expect(solveRequiredContribution((c) => c >= 0.4)).toBe(1);
  });

  it('returns 0 when nothing is needed and null when even the cap is not enough', () => {
    expect(solveRequiredContribution(() => true)).toBe(0);
    expect(solveRequiredContribution(() => false)).toBeNull();
    expect(solveRequiredContribution((c) => c >= 600, 500)).toBeNull();
    expect(solveRequiredContribution((c) => c >= 500, 500)).toBe(500);
  });
});

describe('normalizeGoalSettings / parseStoredGoal', () => {
  it('moves a passed or too distant target year into the window', () => {
    expect(normalizeGoalSettings(settings({ targetYear: 2020 }), TODAY).targetYear).toBe(2027);
    expect(normalizeGoalSettings(settings({ targetYear: 2500 }), TODAY).targetYear).toBe(2086);
    expect(normalizeGoalSettings(settings({ targetYear: 2040 }), TODAY).targetYear).toBe(2040);
  });

  it('falls back to the defaults for unreadable items', () => {
    expect(parseStoredGoal({ goalType: 'nope' }, TODAY)).toEqual(defaultGoalSettings(TODAY));
    expect(parseStoredGoal(null, TODAY)).toEqual(defaultGoalSettings(TODAY));
  });

  it('reads valid items and ignores bookkeeping fields', () => {
    const stored = { ...settings({ targetYear: 2000 }), userId: 'u', portfolioId: 'all', createdAt: 'x', updatedAt: 'y' };
    const parsed = parseStoredGoal(stored, TODAY);
    expect(parsed).toEqual(settings({ targetYear: 2027 }));
    expect(parsed).not.toHaveProperty('userId');
  });
});

describe('projectGoal', () => {
  const run = (over: Partial<GoalSettings> = {}, s: GoalStart = start) => projectGoal({ settings: settings(over), start: s, today: TODAY, baseCurrency: 'EUR' });

  it('lays out one row per year up to the horizon, starting today', () => {
    const p = run({ targetYear: 2036 });
    expect(p.startYear).toBe(2026);
    expect(p.targetYears).toBe(10);
    expect(p.horizonYears).toBe(10 + GOAL_EXTRA_YEARS);
    expect(p.rows).toHaveLength(p.horizonYears + 1);
    expect(p.rows[0]).toMatchObject({ yearOffset: 0, year: 2026, goal: 100_000, contributed: 0, plan: 10_000, safe: 10_000, alternative: 10_000 });
    expect(p.rows[10]).toMatchObject({ year: 2036, plan: 16_288.95 });
    expect(p.scenarios.map((s) => s.label)).toEqual(['Your plan', 'Safe', 'Alternative']);
    expect(p.baseCurrency).toBe('EUR');
    expect(p.asOf).toBe(TODAY);
    expect(p.goalType).toBe('value');
  });

  it('caps the horizon at the maximum', () => {
    expect(run({ targetYear: 2086 }).horizonYears).toBe(MAX_GOAL_HORIZON_YEARS);
  });

  it('accumulates contributions per month', () => {
    const p = run({ monthlyContribution: 250 });
    expect(p.rows[2]!.contributed).toBe(6000);
    expect(p.monthlyContribution).toBe(250);
  });

  it('reports the scenario parameters after adjustment', () => {
    const p = run({ priceReturnPct: 5, dividendGrowthPct: 5, yieldOnNewMoneyPct: 3.5 });
    expect(p.scenarios.map((s) => [s.priceReturnPct, s.dividendGrowthPct, s.yieldOnNewMoneyPct])).toEqual([
      [5, 5, 3.5],
      [3, 4, 3],
      [7, 6, 4],
    ]);
    expect(GOAL_SCENARIO_ADJUSTMENTS.safe.priceReturnPct).toBe(-2);
    expect(GOAL_PLAN_LABELS.alternative).toBe('Alternative');
  });

  it('marks the plan as on time and early when reached before the target year', () => {
    const p = run({ goalType: 'value', targetAmount: 20_000, targetYear: 2056, monthlyContribution: 0 });
    // 10.000 × 1,05^n ≥ 20.000 → n = 15 (2,0789)
    expect(p.scenarios[0]).toMatchObject({ yearsToGoal: 15, reachedYear: 2041 });
    expect(p.verdict).toEqual({ reached: true, yearsToGoal: 15, reachedYear: 2041, onTime: true, yearsLater: null, yearsEarly: 30 - 15 });
    expect(p.earlierScenario?.id).toBe('alternative');
  });

  it('reports years later when the goal is reached after the target year', () => {
    const p = run({ targetAmount: 20_000, targetYear: 2036 });
    expect(p.verdict).toMatchObject({ reached: true, onTime: false, yearsLater: 5, yearsEarly: null, reachedYear: 2041 });
  });

  it('is on time without being early when reached exactly in the target year', () => {
    const p = run({ targetAmount: 16_288.95, targetYear: 2036 });
    expect(p.verdict).toMatchObject({ onTime: true, yearsLater: null, yearsEarly: null, yearsToGoal: 10 });
  });

  it('reports not reached within the horizon', () => {
    const p = run({ targetAmount: 1e9, targetYear: 2036 });
    expect(p.verdict).toEqual({ reached: false, yearsToGoal: null, reachedYear: null, onTime: false, yearsLater: null, yearsEarly: null });
    expect(p.scenarios.every((s) => s.yearsToGoal === null)).toBe(true);
    expect(p.earlierScenario).toBeNull();
    expect(p.requiredContribution.status).toBe('unattainable');
    expect(p.requiredContribution.monthly).toBeNull();
  });

  it('flags an already reached goal', () => {
    const p = run({ targetAmount: 5000 });
    expect(p.verdict).toMatchObject({ reached: true, yearsToGoal: 0, reachedYear: 2026, onTime: true, yearsEarly: 30 });
    expect(p.requiredContribution).toEqual({ status: 'none-needed', monthly: 0 });
    expect(p.earlierScenario).toBeNull();
  });

  it('picks the alternative scenario when the plan is late', () => {
    const p = run({ targetAmount: 40_000, targetYear: 2036 });
    const [plan, safe, alternative] = p.scenarios;
    // plan: 1,05^29 ≥ 4; safe (3 %) needs 47 years, beyond the 30 projected
    expect(plan!.yearsToGoal).toBe(29);
    expect(safe!.yearsToGoal).toBeNull();
    expect(alternative!.yearsToGoal).toBeLessThan(29);
    expect(p.earlierScenario?.id).toBe('alternative');
  });

  it('offers the alternative scenario when only it reaches the goal', () => {
    const p = run({ targetAmount: 100_000, targetYear: 2056, priceReturnPct: 3 });
    expect(p.scenarios.map((s) => s.yearsToGoal)).toEqual([null, null, 48]);
    expect(p.earlierScenario?.id).toBe('alternative');
  });

  it('solves the required contribution for the target year', () => {
    const p = run({ priceReturnPct: 0, targetAmount: 100_000, targetYear: 2036 });
    // 10.000 + 120 × c ≥ 100.000 → c = 750
    expect(p.requiredContribution).toEqual({ status: 'required', monthly: 750 });
    const withSolved = run({ priceReturnPct: 0, targetAmount: 100_000, targetYear: 2036, monthlyContribution: 750 });
    expect(withSolved.rows[10]!.plan).toBe(100_000);
    expect(run({ priceReturnPct: 0, targetAmount: 100_000, targetYear: 2036, monthlyContribution: 749 }).rows[10]!.plan).toBeLessThan(100_000);
  });

  it('solves a compounding closed-form case', () => {
    const p = run({ priceReturnPct: 6, targetAmount: 100_000, targetYear: 2046 });
    const mp = 1.06 ** (1 / 12);
    const n = 240;
    const exact = (100_000 - 10_000 * 1.06 ** 20) * ((mp - 1) / (mp ** n - 1));
    expect(p.requiredContribution.monthly).toBe(Math.ceil(exact));
  });

  it('inflates the goal and therefore the required contribution', () => {
    const flat = run({ priceReturnPct: 0, targetAmount: 100_000, targetYear: 2036 });
    const inflated = run({ priceReturnPct: 0, targetAmount: 100_000, targetYear: 2036, adjustForInflation: true });
    expect(inflated.targetAmountAtTargetYear).toBe(121_899.44);
    expect(flat.targetAmountAtTargetYear).toBe(100_000);
    expect(inflated.requiredContribution.monthly!).toBeGreaterThan(flat.requiredContribution.monthly!);
    expect(inflated.rows[10]!.goal).toBe(121_899.44);
    expect(inflated.targetAmount).toBe(100_000);
  });

  it('projects income goals from the starting income', () => {
    const p = run({ goalType: 'income', targetAmount: 1000, targetYear: 2056, monthlyContribution: 200, dividendGrowthPct: 5, yieldOnNewMoneyPct: 4, reinvestDividends: true });
    expect(p.goalType).toBe('income');
    expect(p.currentAmount).toBe(400);
    expect(p.rows[0]!.plan).toBe(400);
    expect(p.rows[1]!.plan).toBeGreaterThan(400);
    expect(p.verdict.reached).toBe(true);
    expect(p.start).toEqual({ value: 10_000, income: 400, yieldPct: 4 });
  });

  it('reports the overridden starting yield for income goals', () => {
    const p = run({ goalType: 'income', startYieldPct: 2.5, targetAmount: 1000 });
    expect(p.start).toEqual({ value: 10_000, income: 250, yieldPct: 2.5 });
    expect(p.currentAmount).toBe(250);
  });

  it('reports today’s value for value goals', () => {
    expect(run().currentAmount).toBe(10_000);
  });

  it('works for an empty portfolio', () => {
    const p = run({ monthlyContribution: 100 }, { value: 0, income: 0, yieldPct: 0 });
    expect(p.rows[0]!.plan).toBe(0);
    expect(p.rows[1]!.plan).toBeGreaterThan(1200);
  });

  it('moves a passed target year to next year', () => {
    const p = run({ targetYear: 2020 });
    expect(p.targetYear).toBe(2027);
    expect(p.targetYears).toBe(1);
  });
});

describe('goalRowsToCsv', () => {
  it('writes a header and one line per year', () => {
    const p = projectGoal({ settings: settings({ targetYear: 2027, monthlyContribution: 100 }), start, today: TODAY, baseCurrency: 'EUR' });
    const lines = goalRowsToCsv(p.rows).split('\n');
    expect(lines[0]).toBe(GOAL_CSV_HEADER);
    expect(lines[1]).toBe('2026,100000,0,10000,10000,10000');
    expect(lines).toHaveLength(p.rows.length + 2);
    expect(goalRowsToCsv(p.rows).endsWith('\n')).toBe(true);
    expect(lines[2]).toMatch(/^2027,100000,1200,/);
  });

  it('is just the header without rows', () => {
    expect(goalRowsToCsv([])).toBe(`${GOAL_CSV_HEADER}\n`);
  });
});

describe('computeGoalStart / computeGoalProjection', () => {
  const data: AnalyticsData = {
    transactions: [
      { id: 't1', userId: 'demo', portfolioId: 'default', date: '2025-01-02', type: 'BUY', symbol: 'AAA', quantity: 10, price: 100, fee: 0, currency: 'EUR', createdAt: '2025-01-02T00:00:01Z' },
      { id: 't2', userId: 'demo', portfolioId: 'default', date: '2025-12-01', type: 'DIVIDEND', symbol: 'AAA', quantity: 10, price: 10, fee: 0, currency: 'EUR', createdAt: '2025-12-01T00:00:01Z' },
    ],
    quotes: { AAA: { symbol: 'AAA', price: 121, previousClose: 120, currency: 'EUR', asOf: '2026-01-02', source: 't' } },
    profiles: { AAA: { symbol: 'AAA', name: 'Alpha Inc', assetClass: 'STOCK', sector: 'Technology', country: 'United States', currency: 'EUR' } },
    fx: { base: 'EUR', rates: { USD: 1.25 }, asOf: '2026-01-02T00:00:00Z' },
    eod: {},
    dividendEvents: [],
    today: '2026-01-02',
  };

  it('takes value, forward income and yield from the analytics calculators', () => {
    expect(computeGoalStart(data)).toEqual({ value: 1210, income: 100, yieldPct: 8.26 });
  });

  it('projects from those numbers on the data’s date', () => {
    const p = computeGoalProjection(data, settings({ targetYear: 2036 }));
    expect(p.asOf).toBe('2026-01-02');
    expect(p.baseCurrency).toBe('EUR');
    expect(p.start).toEqual({ value: 1210, income: 100, yieldPct: 8.26 });
    expect(p.rows[0]!.plan).toBe(1210);
  });

  it('is empty-safe', () => {
    expect(computeGoalStart({ ...data, transactions: [], quotes: {}, profiles: {} })).toEqual({ value: 0, income: 0, yieldPct: 0 });
  });
});
