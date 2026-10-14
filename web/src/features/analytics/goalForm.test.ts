import { DEFAULT_GOAL_FORM, parseGoalForm } from './goalForm';

describe('parseGoalForm', () => {
  it('accepts the defaults, with Dutch decimals, and leaves the starting yield to the API', () => {
    expect(DEFAULT_GOAL_FORM.dividendGrowthPct).toBe('5');
    expect(DEFAULT_GOAL_FORM.yieldOnNewMoneyPct).toBe('3,5');
    expect(parseGoalForm(DEFAULT_GOAL_FORM)).toEqual({
      params: { targetIncome: 12_000, dividendGrowthPct: 5, yieldOnNewMoneyPct: 3.5, monthlyContribution: 250, years: 30, reinvestDividends: true },
    });
  });

  it('reads typed values and an explicit starting yield', () => {
    const result = parseGoalForm({
      targetIncome: '24.000,50',
      dividendGrowthPct: '4,5',
      yieldOnNewMoneyPct: '4',
      monthlyContribution: '0',
      currentYieldPct: '2,75',
      years: '10',
      reinvestDividends: false,
    });
    expect(result).toEqual({
      params: { targetIncome: 24_000.5, dividendGrowthPct: 4.5, yieldOnNewMoneyPct: 4, monthlyContribution: 0, currentYieldPct: 2.75, years: 10, reinvestDividends: false },
    });
  });

  it('reports every invalid field once, with its allowed range', () => {
    const result = parseGoalForm({ ...DEFAULT_GOAL_FORM, targetIncome: 'abc', dividendGrowthPct: '45', years: '2,5', monthlyContribution: '-1', yieldOnNewMoneyPct: '', currentYieldPct: '99' });
    expect(result).toEqual({
      errors: {
        targetIncome: 'Target annual income must be a number between 1 and 1.000.000.000.',
        dividendGrowthPct: 'Dividend growth must be a number between 0 and 30.',
        years: 'Horizon must be a whole number between 1 and 50.',
        monthlyContribution: 'Monthly contribution must be a number between 0 and 10.000.000.',
        currentYieldPct: 'Starting yield must be a number between 0 and 50.',
      },
    });
  });
});
