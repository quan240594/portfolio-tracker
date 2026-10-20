import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AllocationSlice } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { THEME_STORAGE_KEY } from '../../theme/ThemeProvider';
import { AllocationDonut } from './AllocationDonut';
import { DividendBarChart } from './DividendBarChart';
import { ValueChart, valueSummary } from './ValueChart';
import { chartTheme, SERIES_COLORS } from './palette';
import {
  compactMoneyTick,
  dateLabel,
  dateTickFormatter,
  dividendSeriesName,
  moneyTooltip,
  monthLabel,
  valueSeriesName,
} from './chartFormatters';

describe('chart formatters', () => {
  it('formats compact money ticks in the given currency', () => {
    expect(compactMoneyTick('EUR')(1_250_000)).toBe('€\u00a01,3\u00a0mln.');
    expect(compactMoneyTick('USD')(-1500)).toBe('\u2212US$\u00a01,5K');
  });

  it('uses day/month ticks for short ranges and month/year ticks for long ranges', () => {
    const short = dateTickFormatter([{ date: '2024-01-01' }, { date: '2024-03-01' }]);
    expect(short('2024-02-15')).toBe('15 Feb');
    const long = dateTickFormatter([{ date: '2023-01-01' }, { date: '2024-03-01' }]);
    expect(long('2024-02-15')).toBe('Feb 24');
    expect(dateTickFormatter([])('2024-02-15')).toBe('15 Feb');
  });

  it('formats tooltip labels', () => {
    expect(dateLabel('2024-03-05')).toBe('05-03-2024');
    expect(monthLabel('2024-11')).toBe('Nov 24');
  });

  it('maps series keys to human names', () => {
    expect(valueSeriesName('value')).toBe('Value');
    expect(valueSeriesName('invested')).toBe('Invested');
    expect(dividendSeriesName('received')).toBe('Received');
    expect(dividendSeriesName('upcoming')).toBe('Upcoming');
  });

  it('formats tooltip values as money with a mapped or raw series name', () => {
    expect(moneyTooltip('EUR', valueSeriesName)('1234.5', 'value')).toEqual(['€\u00a01.234,50', 'Value']);
    expect(moneyTooltip('EUR')(10, 'Stocks')).toEqual(['€\u00a010,00', 'Stocks']);
  });
});

describe('chartTheme', () => {
  it('returns distinct light and dark palettes', () => {
    const light = chartTheme('light');
    const dark = chartTheme('dark');
    expect(light.tooltipBg).toBe('#ffffff');
    expect(dark.tooltipBg).toBe('#0f172a');
    for (const key of Object.keys(light) as (keyof typeof light)[]) {
      if (key !== 'invested' && key !== 'axis') expect(dark[key]).not.toBe(light[key]);
    }
  });
});

const slice = (i: number): AllocationSlice => ({ key: `k${i}`, label: `Label ${i}`, value: 100 - i, weight: (100 - i) / 1000 });

describe('AllocationDonut', () => {
  const two: AllocationSlice[] = [
    { key: 'STOCK', label: 'STOCK', value: 7500, weight: 0.75 },
    { key: 'ETF', label: 'ETF', value: 2500, weight: 0.25 },
  ];
  const legend = () => screen.getByTestId('allocation-legend');
  const table = () => screen.getByRole('table', { name: 'Allocation by category' });
  const rowOf = (name: string) => within(table()).getByRole('button', { name }).closest('tr')!;

  it('lists slices in the legend and the table with prettified labels, compact values and weights', () => {
    renderWithProviders(<AllocationDonut currency="EUR" slices={two} />);
    expect(within(legend()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Stock', 'ETF']);
    expect(rowOf('Stock')).toHaveTextContent('€ 7,5K');
    expect(rowOf('Stock')).toHaveTextContent('75,0%');
    // Short acronyms stay upper-case.
    expect(rowOf('ETF')).toHaveTextContent('25,0%');
    expect(screen.getByTestId('allocation-donut')).toHaveAccessibleName('Allocation by category: Stock 75,0%, ETF 25,0%.');
    expect(screen.getByTestId('allocation-donut-centre')).toHaveTextContent('€ 10Ktotal');
  });

  it('collapses the long tail into "Other" and keeps colours by position', () => {
    const slices = Array.from({ length: 10 }, (_, i) => slice(i));
    renderWithProviders(<AllocationDonut currency="EUR" slices={slices} dimension="Sector" />);
    expect(within(legend()).getAllByRole('button')).toHaveLength(8);
    const other = within(screen.getByRole('table', { name: 'Allocation by sector' })).getByRole('button', { name: 'Other' }).closest('tr')!;
    // 93 + 92 + 91 = 276; weights 0.093 + 0.092 + 0.091 = 27.6%
    expect(other).toHaveTextContent('€ 276');
    expect(other).toHaveTextContent('27,6%');
    expect(within(legend()).getByRole('button', { name: 'Label 0' }).querySelector('span[aria-hidden]')).toHaveStyle({ background: SERIES_COLORS[0] });
    expect(screen.getByRole('columnheader', { name: 'Sector' })).toBeInTheDocument();
  });

  it('excludes a slice through the legend or its table row, recomputes the shares and the middle, and shows all again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AllocationDonut currency="EUR" slices={[...two, { key: 'CASH', label: 'CASH', value: 2500, weight: 0.2 }]} />);
    await user.click(within(legend()).getByRole('button', { name: 'Stock' }));
    expect(within(legend()).getByRole('button', { name: 'Stock' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(table()).getByRole('button', { name: 'Stock' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('selection-note')).toHaveTextContent('Chart shows the current selection');
    // the two slices that are left share 100%
    expect(rowOf('ETF')).toHaveTextContent('50,0%');
    expect(rowOf('Stock')).toHaveTextContent('—');
    expect(rowOf('Stock')).toHaveTextContent('€ 7,5K');
    expect(screen.getByTestId('allocation-donut')).toHaveAccessibleName('Allocation by category: ETF 50,0%, Cash 50,0%.');
    expect(screen.getByTestId('allocation-donut-centre')).toHaveTextContent('€ 5Kselected');

    await user.click(within(table()).getByRole('button', { name: 'Stock' }));
    expect(within(legend()).getByRole('button', { name: 'Stock' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('selection-note')).toBeNull();
    await user.click(within(legend()).getByRole('button', { name: 'ETF' }));
    await user.click(within(table()).getByRole('button', { name: 'Cash' }));
    await user.click(screen.getAllByRole('button', { name: 'Show all' })[0]!);
    expect(within(legend()).getByRole('button', { name: 'ETF' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the empty state when every slice is excluded, keeping legend and table to undo it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AllocationDonut currency="EUR" slices={two} />);
    await user.click(within(legend()).getByRole('button', { name: 'Stock' }));
    await user.click(within(legend()).getByRole('button', { name: 'ETF' }));
    expect(screen.getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    expect(screen.queryByTestId('allocation-donut')).toBeNull();
    await user.click(within(screen.getByTestId('nothing-selected')).getByRole('button', { name: 'show all' }));
    expect(screen.getByTestId('allocation-donut')).toBeInTheDocument();
  });

  it('renders in dark mode', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderWithProviders(<AllocationDonut currency="EUR" slices={[slice(1)]} />);
    expect(within(legend()).getByRole('button', { name: 'Label 1' })).toBeInTheDocument();
  });
});

describe('ValueChart', () => {
  const points = [
    { date: '2024-01-01', value: 1000, invested: 900 },
    { date: '2024-06-01', value: 1200, invested: 1000 },
  ];

  it('summarises the series for screen readers', () => {
    renderWithProviders(<ValueChart currency="EUR" points={points} />);
    expect(
      screen.getByRole('img', {
        name: 'Portfolio value from 01-01-2024 to 01-06-2024: €\u00a01.000,00 to €\u00a01.200,00; invested €\u00a01.000,00.',
      }),
    ).toBeInTheDocument();
  });

  it('describes an empty series', () => {
    renderWithProviders(<ValueChart currency="EUR" points={[]} />);
    expect(screen.getByRole('img', { name: 'No history available.' })).toBeInTheDocument();
  });

  it('names only the series that are shown', () => {
    expect(valueSummary(points, 'EUR', { value: true, invested: false })).toBe('Portfolio value from 01-01-2024 to 01-06-2024: €\u00a01.000,00 to €\u00a01.200,00.');
    expect(valueSummary(points, 'EUR', { value: false, invested: true })).toBe('Invested from 01-01-2024 to 01-06-2024: €\u00a0900,00 to €\u00a01.000,00.');
    expect(valueSummary([], 'EUR', { value: false, invested: true })).toBe('No history available.');
  });

  it('excludes a series through its legend entry and shows everything again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ValueChart currency="EUR" points={points} />);
    const legend = screen.getByTestId('value-legend');
    expect(within(legend).getAllByRole('button').map((b) => b.textContent)).toEqual(['Value', 'Invested']);
    await user.click(within(legend).getByRole('button', { name: 'Invested' }));
    expect(within(legend).getByRole('button', { name: 'Invested' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('value-chart')).toHaveAccessibleName(/^Portfolio value from .*1\.200,00\. Chart shows the current selection\.$/);
    expect(screen.getByTestId('selection-note')).toHaveTextContent('Chart shows the current selection');

    await user.click(within(legend).getByRole('button', { name: 'Value' }));
    expect(screen.getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    expect(screen.queryByTestId('value-chart')).toBeNull();
    await user.click(within(legend).getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('value-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });
});

describe('DividendBarChart', () => {
  it('labels the chart with the filled month count and total', () => {
    renderWithProviders(
      <DividendBarChart
        currency="EUR"
        monthly={[
          { month: '2024-01', received: 10, upcoming: 0 },
          { month: '2024-03', received: 0, upcoming: 5.5 },
        ]}
      />,
    );
    expect(
      screen.getByRole('img', { name: 'Monthly dividends across 3 months, totalling €\u00a015,50 received and upcoming.' }),
    ).toBeInTheDocument();
  });
});
