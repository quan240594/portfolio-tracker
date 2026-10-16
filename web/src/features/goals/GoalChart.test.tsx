import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultGoalSettings, goalRowsToCsv, projectGoal } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import * as form from '../management/form';
import { GOAL_SERIES, goalAxisDomain, goalChartMax, goalChartSummary, goalLineColours, goalRowIds, goalSeriesName } from './GoalChart';
import { GoalResults } from './GoalResults';

const TODAY = '2026-10-15';
const projection = projectGoal({
  settings: { ...defaultGoalSettings(TODAY), goalType: 'value', targetAmount: 20_000, targetYear: 2056, monthlyContribution: 0, reinvestDividends: false, adjustForInflation: false },
  start: { value: 10_000, income: 400, yieldPct: 4 },
  today: TODAY,
  baseCurrency: 'EUR',
});

describe('GoalChart', () => {
  it('describes the chart for assistive technology and points to the table', () => {
    renderWithProviders(<GoalResults projection={projection} />);
    expect(screen.getByRole('figure')).toHaveTextContent(/Projected portfolio value from 2026 to 2076 for three scenarios against a goal of .*20\.000 in 2056\. Achievable in 15 years \(by 2041\)\. The table below lists the same values\./);
    expect(screen.getByTestId('goal-chart')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('The dots mark the year each scenario first reaches the goal.')).toBeInTheDocument();
  });

  it('summarises income goals', () => {
    expect(goalChartSummary({ ...projection, goalType: 'income' })).toMatch(/^Projected annual income from 2026/);
  });

  it('leaves room above the highest goal, and fits the axis to what is left without the goal line', () => {
    expect(goalChartMax(projection.rows)).toBe(Math.max(...projection.rows.map((r) => r.goal)) * 1.5);
    expect(goalAxisDomain(projection.rows, ['goal', 'plan'])).toEqual([0, goalChartMax(projection.rows)]);
    expect(goalAxisDomain(projection.rows, ['plan'])).toEqual([0, 'auto']);
    expect(goalRowIds(projection)).toEqual(projection.rows.map((r) => String(r.year)));
    expect(GOAL_SERIES).toEqual(['goal', 'safe', 'alternative', 'plan']);
  });

  it('names the series', () => {
    expect(goalSeriesName('plan')).toBe('Your plan');
    expect(goalSeriesName('goal')).toBe('Goal (inflation-adjusted)');
    expect(goalSeriesName('other')).toBe('other');
  });

  it('uses distinct colours per series in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const colours = Object.values(goalLineColours(theme));
      expect(new Set(colours).size).toBe(4);
    }
  });
});

describe('Goal chart and year-by-year table selection', () => {
  const legend = () => screen.getByTestId('goal-legend');
  const table = () => screen.getByRole('table', { name: /Portfolio value per year/ });
  const verdict = () => screen.getByRole('status');

  it('has a legend entry per line; excluding the goal line leaves the verdict and the summary alone', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalResults projection={projection} />);
    expect(within(legend()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Goal (inflation-adjusted)', 'Safe', 'Alternative', 'Your plan']);
    const before = verdict().textContent;
    const summary = goalChartSummary(projection);

    await user.click(within(legend()).getByRole('button', { name: 'Goal (inflation-adjusted)' }));
    expect(within(legend()).getByRole('button', { name: 'Goal (inflation-adjusted)' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(table()).getByRole('button', { name: 'Goal' })).toHaveAttribute('aria-pressed', 'false');
    expect(verdict().textContent).toBe(before);
    expect(screen.getByRole('figure').textContent).toContain(summary);
    expect(screen.getByRole('figure')).toHaveTextContent('The chart shows the current selection.');
    expect(screen.getByTestId('goal-chart')).toBeInTheDocument();
    // the cells stay complete, they are only struck through
    const first = within(table()).getAllByRole('row')[1]!;
    expect(within(first).getAllByRole('cell')[0]).toHaveClass('line-through');
    expect(within(first).getAllByRole('cell')[0]!.textContent).not.toBe('');
  });

  it('excludes a scenario column and a year row through the table headers, and Show all resets both', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalResults projection={projection} />);
    await user.click(within(table()).getByRole('button', { name: 'Safe' }));
    expect(within(legend()).getByRole('button', { name: 'Safe' })).toHaveAttribute('aria-pressed', 'false');
    const year = projection.rows[2]!.year;
    await user.click(within(table()).getByRole('button', { name: String(year) }));
    expect(within(table()).getByRole('button', { name: String(year) })).toHaveAttribute('aria-pressed', 'false');
    expect(within(within(table()).getByRole('button', { name: String(year) }).closest('tr')!).getAllByRole('cell')[3]).toHaveClass('line-through');
    // Today and the target year are rows like any other
    expect(within(table()).getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(table()).getByText('Target year')).toBeInTheDocument();
    expect(table().querySelector('tr[aria-current="true"]')).not.toBeNull();

    await user.click(screen.getAllByRole('button', { name: 'Show all' })[0]!);
    expect(within(legend()).getByRole('button', { name: 'Safe' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(table()).getByRole('button', { name: String(year) })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });

  it('shows the empty state when every line, or every year, is excluded', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalResults projection={projection} />);
    for (const name of ['Goal (inflation-adjusted)', 'Safe', 'Alternative', 'Your plan']) await user.click(within(legend()).getByRole('button', { name }));
    expect(screen.getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    expect(screen.queryByTestId('goal-chart')).toBeNull();
    // the legend and the table stay, so it can be undone
    await user.click(within(screen.getByTestId('nothing-selected')).getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('goal-chart')).toBeInTheDocument();

    for (const row of projection.rows) await user.click(within(table()).getByRole('button', { name: row.yearOffset === 0 ? 'Today' : String(row.year) }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
  });

  it('exports every year and scenario to CSV whatever is excluded, and says so', async () => {
    const user = userEvent.setup();
    const download = vi.spyOn(form, 'downloadFile').mockImplementation(() => undefined);
    renderWithProviders(<GoalResults projection={projection} />);
    expect(screen.queryByText(/The CSV always contains/)).toBeNull();
    await user.click(within(table()).getByRole('button', { name: 'Safe' }));
    await user.click(within(table()).getByRole('button', { name: 'Today' }));
    expect(screen.getByText(/The CSV always contains every year and scenario/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(download).toHaveBeenCalledWith('goal-projection.csv', goalRowsToCsv(projection.rows), 'text/csv');
    download.mockRestore();
  });
});
