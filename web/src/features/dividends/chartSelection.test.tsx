import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { computeDividendGrowth, computeDividendsOverview } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { getAnalyticsData } from '../../mocks/db';
import { ConsistencyCard } from './ConsistencyCard';
import { DiversificationCard } from './DiversificationCard';
import { DividendGrowthCard } from './DividendGrowthCard';
import { AverageGrowthCard, FuturePaymentsCard } from './GrowthAndFuture';
import { ReceivedCards } from './ReceivedCards';
import { YieldPayoutCard } from './YieldPayoutCard';

/** Include / exclude through the legend and the data table of every chart card of the Dividends page. */

const data = getAnalyticsData();
const overview = computeDividendsOverview(data);
const growth = computeDividendGrowth(data);
const payers = overview.holdings.filter((h) => h.forward12m > 0);

const card = (name: string) => screen.getByRole('region', { name, exact: true } as { name: string });
const legendIn = (testId: string) => screen.getByTestId(testId);
const entry = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name });
const entryNames = (scope: HTMLElement) => within(scope).getAllByRole('button').map((b) => b.textContent);
const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed');
const labelOf = (testId: string) => screen.getByTestId(testId).getAttribute('aria-label')!;
const firstRowToggle = (table: HTMLElement) => within(within(table).getAllByRole('rowheader')[0]!).getByRole('button');

/** Opens the "Show data table" disclosure of `region` and returns its (first) table. */
async function openTable(user: ReturnType<typeof userEvent.setup>, region: HTMLElement, name: string) {
  await user.click(within(region).getByText('Show data table'));
  return within(region).getByRole('table', { name });
}

describe('Yield / payout selection', () => {
  it('excludes a series or a holding, rescales the chart and can show everything again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<YieldPayoutCard />);
    const chart = await screen.findByTestId('yield-payout-chart');
    expect(chart).toHaveAccessibleName(new RegExp(`per ${payers.length} bars`));
    const region = card('Yield / payout');
    const legend = legendIn('yield-payout-legend');
    expect(entryNames(legend)).toEqual(['Yield on value', 'Yield on cost']);
    const table = await openTable(user, region, 'Dividend yield and forward annual amount');
    expect(within(table).queryByRole('button', { name: 'Per year' })).toBeNull();

    // the dots are a series of their own: legend and table header share the state
    await user.click(entry(legend, 'Yield on cost'));
    expect(pressed(entry(legend, 'Yield on cost'))).toBe('false');
    expect(pressed(within(table).getByRole('button', { name: 'Yield on cost' }))).toBe('false');
    expect(screen.getByTestId('selection-note')).toHaveTextContent('Chart shows the current selection');

    // a holding is a row
    await user.click(firstRowToggle(table));
    expect(screen.getByTestId('yield-payout-chart')).toHaveAccessibleName(new RegExp(`per ${payers.length - 1} bars`));

    await user.click(entry(legend, 'Yield on value'));
    expect(screen.getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    expect(screen.queryByTestId('yield-payout-chart')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('yield-payout-chart')).toHaveAccessibleName(new RegExp(`per ${payers.length} bars`));
    expect(pressed(entry(legend, 'Yield on cost'))).toBe('true');
  });

  it('switches to the amount series, whose column is the only one that can be excluded', async () => {
    const user = userEvent.setup();
    renderWithProviders(<YieldPayoutCard />);
    await screen.findByTestId('yield-payout-chart');
    const region = card('Yield / payout');
    const table = await openTable(user, region, 'Dividend yield and forward annual amount');
    await user.click(entry(legendIn('yield-payout-legend'), 'Yield on cost'));
    await user.click(within(region).getByRole('radio', { name: 'Amount (EUR)' }));
    // the hidden yield series left the data: it does not stay excluded
    expect(entryNames(legendIn('yield-payout-legend'))).toEqual(['Amount per year']);
    expect(within(table).getByRole('button', { name: 'Per year' })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Yield' })).toBeNull();
    expect(screen.queryByTestId('selection-note')).toBeNull();
    await user.click(entry(legendIn('yield-payout-legend'), 'Amount per year'));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
  });
});

describe('Passive income diversification selection', () => {
  it('recomputes the shares and the total in the middle without the excluded holding', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiversificationCard />);
    await screen.findByTestId('income-donut');
    const region = card('Passive income diversification');
    const legend = legendIn('income-legend');
    expect(entryNames(legend)).toHaveLength(Math.min(payers.length, 9));
    const centre = () => within(screen.getByTestId('income-donut-centre')).getByText(/€/).textContent;
    const ranked = () => within(screen.getByRole('list', { name: 'Holdings ranked by expected annual income' })).getAllByRole('listitem');
    const before = centre();
    const rowsBefore = ranked().length;
    const label = labelOf('income-donut');

    await user.click(within(legend).getAllByRole('button')[0]!);
    expect(labelOf('income-donut')).not.toBe(label);
    expect(centre()).not.toBe(before);
    expect(ranked()).toHaveLength(rowsBefore - 1);

    // the table rows are the same toggles; the excluded slice has no share
    const table = await openTable(user, region, 'Forward annual dividend income by holding');
    const firstRow = within(table).getAllByRole('row')[1]!;
    expect(pressed(within(firstRow).getByRole('button'))).toBe('false');
    expect(within(firstRow).getAllByRole('cell')[0]).toHaveTextContent('—');
    await user.click(within(firstRow).getByRole('button'));
    expect(pressed(within(legend).getAllByRole('button')[0]!)).toBe('true');
    expect(labelOf('income-donut')).toBe(label);

    for (const button of within(legend).getAllByRole('button')) await user.click(button);
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    expect(screen.queryByTestId('income-donut')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('income-donut')).toBeInTheDocument();
  });
});

describe('Consistency selection', () => {
  it('leaves a badge out of the donut and recounts the holdings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConsistencyCard />);
    await screen.findByTestId('consistency-donut');
    const legend = legendIn('consistency-legend');
    const total = overview.holdings.length;
    expect(entryNames(legend)).toEqual(['Reliable (3)', 'OK (1)', 'Irregular (1)', 'New (1)']);
    expect(screen.getByTestId('consistency-donut-centre')).toHaveTextContent(`${total}holdings`);

    await user.click(entry(legend, 'Reliable (3)'));
    expect(screen.getByTestId('consistency-donut')).toHaveAccessibleName(/^Holdings by payment consistency: 1 OK, 1 Irregular, 1 New\.$/);
    expect(screen.getByTestId('consistency-donut-centre')).toHaveTextContent('3holdings');

    const region = card('Payment consistency');
    const table = await openTable(user, region, 'Consistency badge counts');
    expect(pressed(within(table).getByRole('button', { name: 'Reliable' }))).toBe('false');
    await user.click(within(table).getByRole('button', { name: 'OK' }));
    await user.click(within(table).getByRole('button', { name: 'Irregular' }));
    expect(screen.getByTestId('consistency-donut-centre')).toHaveTextContent('1holding');
    await user.click(within(table).getByRole('button', { name: 'New' }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('consistency-donut-centre')).toHaveTextContent(`${total}holdings`);
  });
});

describe('Average annual growth selection', () => {
  it('excludes a holding or the only series', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AverageGrowthCard />);
    const chart = await screen.findByTestId('growth-cagr-chart');
    const count = Number(/, (\d+) holdings:/.exec(chart.getAttribute('aria-label')!)![1]);
    const region = card('Average annual growth');
    const table = await openTable(user, region, 'Average annual dividend growth per share');
    expect(within(table).queryByRole('button', { name: 'Years measured' })).toBeNull();

    await user.click(firstRowToggle(table));
    expect(screen.getByTestId('growth-cagr-chart')).toHaveAccessibleName(new RegExp(`, ${count - 1} holdings:`));

    await user.click(entry(legendIn('growth-cagr-legend'), 'Average annual growth'));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('growth-cagr-chart')).toHaveAccessibleName(new RegExp(`, ${count} holdings:`));
  });
});

describe('Future payments selection', () => {
  it('excludes a status or a month and recomputes the average line', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FuturePaymentsCard />);
    await screen.findByTestId('future-chart');
    expect(labelOf('future-chart')).toMatch(/^Expected dividends per month over the next 12 months/);
    const legend = legendIn('future-legend');
    // the average line is shown but is not a control
    expect(within(legend).getByText('Monthly average')).toBeInTheDocument();
    expect(entryNames(legend)).toEqual(['Declared', 'Estimated']);
    expect(screen.getByText('The dashed line is the monthly average.')).toBeInTheDocument();

    await user.click(entry(legend, 'Declared'));
    expect(labelOf('future-chart')).toMatch(/^Expected dividends for the 12 selected months, .* \(current selection\)\.$/);
    expect(screen.getByText('The dashed line is the monthly average of the current selection.')).toBeInTheDocument();
    // the headline keeps describing the whole portfolio
    expect(screen.getByTestId('future-total')).toHaveTextContent('€');

    const table = await openTable(user, card('Future payments'), 'Expected dividends per month');
    await user.click(firstRowToggle(table));
    expect(labelOf('future-chart')).toContain('the 11 selected months');
    await user.click(within(table).getByRole('button', { name: 'Estimated' }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(labelOf('future-chart')).toMatch(/^Expected dividends per month/);
  });
});

describe('Dividends received selection', () => {
  it('excludes statuses, periods and the average line, and keeps the headline', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedCards />);
    const total = await screen.findByTestId('received-total');
    const headline = total.textContent;
    const region = card('Dividends received');
    const legend = legendIn('received-legend');
    expect(entryNames(legend)).toEqual(['Received', 'Declared', 'Estimated', 'avg']);
    expect(labelOf('received-time-chart')).toContain('upcoming');

    await user.click(entry(legend, 'Estimated'));
    const selected = labelOf('received-time-chart');
    expect(selected).toMatch(/^Dividends received over time, current selection: \d+ bars/);
    expect(selected).not.toContain('upcoming');
    expect(screen.getByTestId('received-average-note')).toHaveTextContent('in the current selection');
    expect(screen.getByTestId('received-total').textContent).toBe(headline);

    // a period is a row
    const table = await openTable(user, region, 'Dividends received and upcoming per period');
    const bars = Number(/: (\d+) bars/.exec(selected)![1]);
    await user.click(firstRowToggle(table));
    expect(labelOf('received-time-chart')).toContain(`${bars - 1} bars`);

    // without received amounts no average can be drawn
    await user.click(entry(legend, 'Received'));
    expect(screen.getByTestId('received-average-note')).toHaveTextContent('No completed month in the current selection, so there is no average line.');
    await user.click(entry(legend, 'Received'));
    await user.click(entry(legend, 'avg'));
    expect(pressed(entry(legend, 'avg'))).toBe('false');
    expect(labelOf('received-time-chart')).not.toContain('average');

    await user.click(within(table).getByRole('button', { name: 'Received' }));
    await user.click(within(table).getByRole('button', { name: 'Declared' }));
    // Estimated and avg were excluded before: every series is now
    expect(screen.getAllByTestId('nothing-selected')[0]).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'show all' })[0]!);
    expect(screen.getByTestId('received-time-chart')).toBeInTheDocument();
  });

  it('only offers the received series when the future is not included', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedCards />);
    await screen.findByTestId('received-total');
    const legend = legendIn('received-legend');
    await user.click(entry(legend, 'Declared'));
    await user.click(screen.getByRole('checkbox', { name: 'Include future payments' }));
    expect(entryNames(legendIn('received-legend'))).toEqual(['Received', 'avg']);
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });

  it('excludes a holding from the by-holding chart', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedCards />);
    const chart = await screen.findByTestId('received-holding-chart');
    const count = Number(/: (\d+) bars/.exec(chart.getAttribute('aria-label')!)![1]);
    const region = card('Dividends received by holding');
    const table = await openTable(user, region, 'Dividends received per holding');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Holding', 'Received']);
    await user.click(firstRowToggle(table));
    expect(screen.getByTestId('received-holding-chart')).toHaveAccessibleName(new RegExp(`: ${count - 1} bars`));
    await user.click(entry(legendIn('received-holding-chart-legend'), 'Received'));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
  });
});

describe('Dividend growth selection', () => {
  const years = [...new Set(growth.byMonth.map((m) => m.month.slice(0, 4)))].sort((a, b) => a.localeCompare(b)).slice(-3);

  it('excludes a year (and its forecast), a forecast kind, the average and a month in the grouped chart', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('year-compare-chart');
    await screen.findByTestId('forecast-summary');
    const region = card('Dividend growth');
    const legend = legendIn('growth-legend');
    const names = entryNames(legend);
    expect(names).toEqual(expect.arrayContaining([...years, 'Declared (forecast)', 'Estimated (forecast)', 'Average of years']));
    expect(labelOf('year-compare-chart')).toContain(`compared for ${years.join(', ')}`);

    const newest = years.at(-1)!;
    await user.click(entry(legend, newest));
    expect(pressed(entry(legend, newest))).toBe('false');
    const after = labelOf('year-compare-chart');
    expect(after).toContain(`compared for ${years.slice(0, -1).join(', ')}.`);
    expect(after).toContain('Current selection.');

    // the year is a column of the table as well; a month is a row
    const table = await openTable(user, region, 'Dividends received per calendar month and year');
    expect(pressed(within(table).getByRole('button', { name: newest }))).toBe('false');
    await user.click(firstRowToggle(table));
    await user.click(entry(legend, 'Average of years'));
    expect(labelOf('year-compare-chart')).not.toContain('average of the years');
    await user.click(entry(legend, 'Declared (forecast)'));
    await user.click(entry(legend, 'Estimated (forecast)'));
    for (const year of years.slice(0, -1)) await user.click(entry(legend, year));
    // only the forecast-only year entry can be left
    const forecastEntry = names.find((n) => n.endsWith('(forecast)') && /^\d{4}/.test(n));
    if (forecastEntry) await user.click(entry(legend, forecastEntry));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'show all' })[0]!);
    expect(labelOf('year-compare-chart')).toContain(`compared for ${years.join(', ')}`);
  });

  it('draws no average of the years once every year is excluded', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('year-compare-chart');
    const legend = legendIn('growth-legend');
    expect(labelOf('year-compare-chart')).toContain('average of the years');
    for (const year of years) await user.click(entry(legend, year));
    expect(labelOf('year-compare-chart')).not.toContain('average of the years');
  });

  it('excludes series and months in the timeline', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthCard />);
    await screen.findByTestId('forecast-summary');
    await user.click(screen.getByRole('radio', { name: 'Timeline' }));
    await screen.findByTestId('growth-timeline-chart');
    const legend = legendIn('growth-legend');
    expect(entryNames(legend)).toEqual(['Received', 'Declared (forecast)', 'Estimated (forecast)', '12-month average', 'Trend', 'Trend (projected)']);

    await user.click(entry(legend, 'Trend'));
    await user.click(entry(legend, 'Trend (projected)'));
    await user.click(entry(legend, '12-month average'));
    expect(screen.getByTestId('selection-note')).toBeInTheDocument();
    expect(labelOf('growth-timeline-chart')).toMatch(/with forecast bars and a trend line\. current selection$/);

    const region = card('Dividend growth');
    const table = await openTable(user, region, 'Dividends received, forecast and trend per month');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Received', 'Declared', 'Estimated', 'Trend']);
    expect(pressed(within(table).getByRole('button', { name: 'Trend' }))).toBe('false');
    const firstMonth = within(table).getAllByRole('rowheader')[0]!.textContent!;
    await user.click(firstRowToggle(table));
    expect(labelOf('growth-timeline-chart')).not.toContain(`from ${firstMonth}`);

    await user.click(entry(legend, 'Received'));
    await user.click(entry(legend, 'Declared (forecast)'));
    await user.click(entry(legend, 'Estimated (forecast)'));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'show all' })[0]!);
    expect(screen.getByTestId('growth-timeline-chart')).toBeInTheDocument();
  });
});
