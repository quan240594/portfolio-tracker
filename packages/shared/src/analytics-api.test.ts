import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_ROUTES,
  BENCHMARK_SYMBOLS,
  DEFAULT_BENCHMARK,
  DEFAULT_GOAL,
  analyticsBenchmarkQuerySchema,
  analyticsGoalQuerySchema,
  analyticsReturnsQuerySchema,
  analyticsRiskQuerySchema,
} from './analytics-api.js';

describe('analytics routes', () => {
  it('are GET reads under /analytics', () => {
    for (const spec of Object.values(ANALYTICS_ROUTES)) expect(spec).toMatch(/^GET \/analytics\/[a-z-]+$/);
    expect(BENCHMARK_SYMBOLS).toContain(DEFAULT_BENCHMARK);
  });
});

describe('query schemas', () => {
  it('defaults the period and validates it', () => {
    expect(analyticsReturnsQuerySchema.parse({})).toEqual({ period: 'year' });
    expect(analyticsReturnsQuerySchema.parse({ period: 'month', portfolioId: 'all' })).toEqual({ period: 'month', portfolioId: 'all' });
    expect(analyticsReturnsQuerySchema.safeParse({ period: 'week' }).success).toBe(false);
    expect(analyticsReturnsQuerySchema.safeParse({ portfolioId: 'a#b' }).success).toBe(false);
  });

  it('defaults, trims and upper-cases the benchmark', () => {
    expect(analyticsRiskQuerySchema.parse({}).benchmark).toBe('IWDA.AS');
    expect(analyticsRiskQuerySchema.parse({ benchmark: ' vwrl.as ' }).benchmark).toBe('VWRL.AS');
    expect(analyticsRiskQuerySchema.safeParse({ benchmark: 'bad symbol' }).success).toBe(false);
    expect(analyticsRiskQuerySchema.safeParse({ benchmark: '' }).success).toBe(false);
    expect(analyticsBenchmarkQuerySchema.parse({ range: '3M' })).toEqual({ benchmark: 'IWDA.AS', range: '3M' });
    expect(analyticsBenchmarkQuerySchema.parse({}).range).toBe('1Y');
    expect(analyticsBenchmarkQuerySchema.safeParse({ range: '10Y' }).success).toBe(false);
  });

  it('applies the goal defaults, also for empty values', () => {
    const expected = { ...DEFAULT_GOAL, reinvestDividends: true };
    expect(analyticsGoalQuerySchema.parse({})).toEqual(expected);
    expect(analyticsGoalQuerySchema.parse({ targetIncome: '', years: '', currentYieldPct: '' })).toEqual(expected);
  });

  it('coerces numbers and booleans from strings', () => {
    expect(
      analyticsGoalQuerySchema.parse({ targetIncome: '24000', dividendGrowthPct: '3.5', yieldOnNewMoneyPct: '4', monthlyContribution: '0', currentYieldPct: '2.5', years: '10', reinvestDividends: 'false' }),
    ).toEqual({ targetIncome: 24_000, dividendGrowthPct: 3.5, yieldOnNewMoneyPct: 4, monthlyContribution: 0, currentYieldPct: 2.5, years: 10, reinvestDividends: false });
  });

  it('rejects out-of-range and malformed goal parameters', () => {
    for (const bad of [
      { targetIncome: '0' },
      { targetIncome: 'abc' },
      { dividendGrowthPct: '31' },
      { dividendGrowthPct: '-1' },
      { yieldOnNewMoneyPct: '21' },
      { monthlyContribution: '-5' },
      { currentYieldPct: '51' },
      { years: '0' },
      { years: '51' },
      { years: '2.5' },
      { reinvestDividends: 'yes' },
    ]) {
      expect(analyticsGoalQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
