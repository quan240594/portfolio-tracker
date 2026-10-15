import { screen } from '@testing-library/react';
import { defaultGoalSettings, projectGoal } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { GoalChart, goalChartMax, goalChartSummary, goalLineColours, goalSeriesName, yearLabel } from './GoalChart';

const TODAY = '2026-10-15';
const projection = projectGoal({
  settings: { ...defaultGoalSettings(TODAY), goalType: 'value', targetAmount: 20_000, targetYear: 2056, monthlyContribution: 0, reinvestDividends: false, adjustForInflation: false },
  start: { value: 10_000, income: 400, yieldPct: 4 },
  today: TODAY,
  baseCurrency: 'EUR',
});

describe('GoalChart', () => {
  it('describes the chart for assistive technology and points to the table', () => {
    renderWithProviders(<GoalChart projection={projection} />);
    expect(screen.getByRole('figure')).toHaveTextContent(/Projected portfolio value from 2026 to 2076 for three scenarios against a goal of .*20\.000 in 2056\. Achievable in 15 years \(by 2041\)\. The table below lists the same values\./);
    expect(screen.getByTestId('goal-chart')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('The dots mark the year each scenario first reaches the goal.')).toBeInTheDocument();
  });

  it('summarises income goals', () => {
    expect(goalChartSummary({ ...projection, goalType: 'income' })).toMatch(/^Projected annual income from 2026/);
  });

  it('leaves room above the highest goal', () => {
    expect(goalChartMax(projection)).toBe(Math.max(...projection.rows.map((r) => r.goal)) * 1.5);
  });

  it('names the series and years', () => {
    expect(goalSeriesName('plan')).toBe('Your plan');
    expect(goalSeriesName('goal')).toBe('Goal (inflation-adjusted)');
    expect(goalSeriesName('other')).toBe('other');
    expect(yearLabel(2030)).toBe('2030');
  });

  it('uses distinct colours per series in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const colours = Object.values(goalLineColours(theme));
      expect(new Set(colours).size).toBe(4);
    }
  });
});
