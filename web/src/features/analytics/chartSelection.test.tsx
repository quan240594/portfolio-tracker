import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BENCHMARK_SYMBOLS, computeDividendGrowth, computeReturns } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { getAnalyticsData } from '../../mocks/db';
import { BenchmarkTab } from './BenchmarkTab';
import { DividendGrowthTab } from './DividendGrowthTab';
import { GoalTab } from './GoalTab';
import { ReturnsTab } from './ReturnsTab';

/** Include / exclude through the legend and the data table of the chart tabs of the Analytics page. */

const data = getAnalyticsData();
const returnsYear = computeReturns(data, 'year');
const growth = computeDividendGrowth(data);

const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed');
const names = (scope: HTMLElement) => within(scope).getAllByRole('button').map((b) => b.textContent);

describe('Returns tab selection', () => {
  it('excludes a period through its row header and the series through the legend; the table keeps every period', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReturnsTab />);
    const table = await screen.findByRole('table', { name: 'Returns per year, newest first' });
    const legend = screen.getByTestId('returns-legend');
    const periods = returnsYear.rows.slice(-10).length;
    expect(screen.getByTestId('returns-chart')).toHaveAccessibleName(new RegExp(`over ${periods} periods`));
    expect(within(table).getAllByRole('rowheader')).toHaveLength(periods);
    expect(within(table).queryByRole('button', { name: 'IRR' })).toBeNull();

    await user.click(within(within(table).getAllByRole('rowheader')[0]!).getByRole('button'));
    expect(screen.getByTestId('returns-chart')).toHaveAccessibleName(new RegExp(`over ${periods - 1} periods.*Chart shows the current selection`));
    expect(within(table).getAllByRole('rowheader')).toHaveLength(periods);
    expect(screen.getByTestId('selection-note')).toBeInTheDocument();

    expect(names(legend)).toEqual(['Return (TWR)', 'Show all']);
    await user.click(within(legend).getByRole('button', { name: 'Return (TWR)' }));
    expect(pressed(within(table).getByRole('button', { name: 'Return (TWR)' }))).toBe('false');
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    expect(screen.queryByTestId('returns-chart')).toBeNull();
    await user.click(within(legend).getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('returns-chart')).toHaveAccessibleName(new RegExp(`over ${periods} periods\\.[^C]*$`));
  });

  it('has no IRR toggle and follows another granularity', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReturnsTab />);
    await screen.findByRole('table', { name: 'Returns per year, newest first' });
    await user.click(screen.getByRole('radio', { name: 'Quarter' }));
    const table = await screen.findByRole('table', { name: 'Returns per quarter, newest first' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Return (TWR)', 'Gain', 'End value']);
  });
});

describe('Dividend growth tab selection', () => {
  it('excludes a year through the table and the series through the legend, for the year and for the month chart', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthTab />);
    const yearTable = await screen.findByRole('table', { name: 'Dividends per year' });
    const yearLegend = screen.getByTestId('dividend-year-chart-legend');
    const monthLegend = screen.getByTestId('dividend-month-chart-legend');
    expect(names(yearLegend)).toEqual(['Received']);
    expect(names(monthLegend)).toEqual(['A year earlier', 'This period']);
    const years = growth.byYear.length;
    expect(screen.getByTestId('dividend-year-chart')).toHaveAccessibleName(new RegExp(`${years} periods`));

    await user.click(within(within(yearTable).getAllByRole('rowheader')[0]!).getByRole('button'));
    expect(screen.getByTestId('dividend-year-chart')).toHaveAccessibleName(new RegExp(`${years - 1} periods.*Chart shows the current selection`));
    // the month chart has a selection of its own
    expect(screen.getByTestId('dividend-month-chart')).not.toHaveAccessibleName(/current selection/);

    await user.click(within(yearLegend).getByRole('button', { name: 'Received' }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    expect(screen.queryByTestId('dividend-year-chart')).toBeNull();
    await user.click(within(yearLegend).getByRole('button', { name: 'Show all' }));

    await user.click(within(monthLegend).getByRole('button', { name: 'A year earlier' }));
    expect(screen.getByTestId('dividend-month-chart')).toHaveAccessibleName(/This period|in total/);
    expect(screen.getByTestId('dividend-month-chart')).toHaveAccessibleName(/current selection/);
    const monthTable = screen.getByRole('table', { hidden: true, name: 'Monthly dividends compared with a year earlier' });
    expect(pressed(within(monthTable).getByRole('button', { hidden: true, name: 'A year earlier' }))).toBe('false');
    await user.click(within(monthTable).getAllByRole('rowheader', { hidden: true })[0]!.querySelector('button')!);
    await user.click(within(monthLegend).getAllByRole('button', { name: 'Show all' })[0]!);
    expect(screen.getByTestId('dividend-month-chart')).not.toHaveAccessibleName(/current selection/);
  });
});

describe('Income goal tab selection', () => {
  it('toggles a scenario through the legend and the scenario table rows alike', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalTab />);
    const table = await screen.findByRole('table', { name: 'Projection per scenario' });
    const legend = screen.getByTestId('goal-legend');
    expect(names(legend)).toEqual(['Cautious', 'Base', 'Optimistic']);
    expect(within(table).queryByRole('button', { name: 'Time to goal' })).toBeNull();

    await user.click(within(legend).getByRole('button', { name: 'Base' }));
    expect(pressed(within(table).getByRole('button', { name: /Base/ }))).toBe('false');
    expect(screen.getByTestId('goal-chart')).toHaveAccessibleName(/cautious scenario.*Chart shows the current selection/);
    // the whole table stays
    expect(within(table).getAllByRole('rowheader')).toHaveLength(3);

    await user.click(within(table).getByRole('button', { name: /Cautious/ }));
    await user.click(within(table).getByRole('button', { name: /Optimistic/ }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(within(screen.getByTestId('nothing-selected')).getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('goal-chart')).not.toHaveAccessibleName(/current selection/);
  });
});

describe('Benchmark tab selection', () => {
  it('has a legend with the portfolio, the benchmark and the invested amount', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BenchmarkTab />);
    const chart = await screen.findByTestId('benchmark-chart');
    expect(chart).toBeInTheDocument();
    const legend = screen.getByTestId('benchmark-legend');
    expect(names(legend)).toEqual(['Portfolio', BENCHMARK_SYMBOLS[0], 'Invested']);
    await user.click(within(legend).getByRole('button', { name: 'Invested' }));
    expect(screen.getByTestId('benchmark-chart')).toHaveAccessibleName(/current selection/);
    // the comparison figures describe the whole period
    expect(screen.getByText('Your return (TWR)')).toBeInTheDocument();
  });
});
