import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarMonth } from '@portfolio/shared';
import { sp } from '../../test/utils';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { IncomeChart } from './CalendarOverview';
import { IncomeTooltip, StatusAmounts } from './IncomeTooltip';
import { incomeColours } from './calendarColours';
import { selectMonths, selectedAverage } from './incomeChartModel';

/** Include / exclude of statuses and months in the calendar income chart, through the legend and the data table. */

const monthly: CalendarMonth[] = [
  { month: '2026-09', paid: 10, declared: 0, estimated: 0, total: 10 },
  { month: '2026-10', paid: 0, declared: 20.1, estimated: 5.2, total: 25.3 },
  { month: '2026-11', paid: 0, declared: 0, estimated: 30, total: 30 },
];

const visible = (hiddenSeries: string[] = [], hiddenRows: string[] = []) => ({
  isSeriesVisible: (key: string) => !hiddenSeries.includes(key),
  isRowVisible: (id: string) => !hiddenRows.includes(id),
});

describe('selectMonths', () => {
  it('keeps every month untouched while nothing is excluded', () => {
    expect(selectMonths(monthly, visible())).toEqual(monthly);
    expect(selectMonths(monthly, visible()).every((m, i) => m === monthly[i])).toBe(true);
  });

  it('clears an excluded status and recomputes the totals from what is left', () => {
    expect(selectMonths(monthly, visible(['declared']))).toEqual([
      { month: '2026-09', paid: 10, declared: 0, estimated: 0, total: 10 },
      { month: '2026-10', paid: 0, declared: 0, estimated: 5.2, total: 5.2 },
      { month: '2026-11', paid: 0, declared: 0, estimated: 30, total: 30 },
    ]);
    expect(selectMonths(monthly, visible(['paid', 'estimated']))[1]).toMatchObject({ declared: 20.1, total: 20.1 });
  });

  it('drops excluded months', () => {
    expect(selectMonths(monthly, visible([], ['2026-10'])).map((m) => m.month)).toEqual(['2026-09', '2026-11']);
    expect(selectMonths(monthly, visible(['paid'], ['2026-09', '2026-11'])).map((m) => m.total)).toEqual([25.3]);
  });
});

describe('selectedAverage', () => {
  it('keeps the supplied average while everything is shown and averages the selection otherwise', () => {
    expect(selectedAverage(monthly, 45.08, false)).toBe(45.08);
    expect(selectedAverage(selectMonths(monthly, visible([], ['2026-10'])), 45.08, true)).toBe(20);
    expect(selectedAverage([], 45.08, true)).toBe(0);
  });
});

describe('IncomeTooltip with a selection', () => {
  const colours = incomeColours('light');
  const props = { currency: 'EUR', colours, background: '#fff', border: '#ccc', text: '#000' };

  it('lists only the statuses that are included, with the total of those', () => {
    const [, october] = selectMonths(monthly, visible(['declared']));
    render(<IncomeTooltip {...props} active payload={[{ payload: october }]} statuses={['paid', 'estimated']} />);
    const tip = screen.getByTestId('calendar-income-tooltip');
    expect(tip).toHaveTextContent('Received');
    expect(tip).toHaveTextContent('Estimated');
    expect(tip).not.toHaveTextContent('Declared');
    expect(tip).toHaveTextContent(`Total${sp('€ 5,20')}`);
  });

  it('lists every status by default', () => {
    render(<StatusAmounts row={monthly[1]!} currency="EUR" colours={colours} border="#ccc" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('IncomeChart selection', () => {
  const renderChart = () =>
    render(
      <ThemeProvider>
        <IncomeChart monthly={monthly} average={45.08} currency="EUR" />
      </ThemeProvider>,
    );
  const legend = () => screen.getByTestId('calendar-income-legend');
  const chartLabel = () => screen.getByTestId('calendar-income-chart').getAttribute('aria-label')!.replaceAll(/\s/g, ' ');

  it('shows the three statuses as toggles and the average as a plain item', () => {
    renderChart();
    expect(within(legend()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Received', 'Declared', 'Estimated']);
    expect(within(legend()).getByText('avg')).toBeInTheDocument();
    expect(within(legend()).queryByRole('button', { name: 'avg' })).toBeNull();
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });

  it('excludes a status from the legend and the table header, and rescales the label', async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividend income per month' });
    expect(within(table).queryByRole('button', { name: 'Total' })).toBeNull();

    await user.click(within(legend()).getByRole('button', { name: 'Declared' }));
    expect(within(legend()).getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(table).getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('selection-note')).toHaveTextContent('Chart shows the current selection');
    expect(chartLabel()).toContain('current selection');
    expect(chartLabel()).toContain('€ 45,20');

    // the table keeps every number: excluded cells are dimmed, not removed
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent(sp('€ 20,10'));

    await user.click(within(table).getByRole('button', { name: 'Declared' }));
    expect(within(legend()).getByRole('button', { name: 'Declared' })).toHaveAttribute('aria-pressed', 'true');
    expect(chartLabel()).toContain('over 3 months');
  });

  it('excludes a month through its row header and shows everything again', async () => {
    const user = userEvent.setup();
    renderChart();
    await user.click(screen.getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividend income per month' });
    await user.click(within(within(table).getAllByRole('rowheader')[0]!).getByRole('button'));
    expect(chartLabel()).toContain('current selection');
    expect(chartLabel()).toContain('€ 55,30');
    expect(chartLabel()).toContain('€ 27,65');
    await user.click(within(legend()).getByRole('button', { name: 'Show all' }));
    expect(chartLabel()).toContain('over 3 months');
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });

  it('replaces the chart by an empty state when every status is excluded', async () => {
    const user = userEvent.setup();
    renderChart();
    for (const name of ['Received', 'Declared', 'Estimated']) await user.click(within(legend()).getByRole('button', { name }));
    expect(screen.getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    expect(screen.queryByTestId('calendar-income-chart')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('calendar-income-chart')).toBeInTheDocument();
  });
});
