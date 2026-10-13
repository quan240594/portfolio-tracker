import { screen, within } from '@testing-library/react';
import type { AllocationSlice } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { THEME_STORAGE_KEY } from '../../theme/ThemeProvider';
import { AllocationDonut } from './AllocationDonut';
import { DividendBarChart } from './DividendBarChart';
import { ValueChart } from './ValueChart';
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
    expect(short('2024-02-15')).toBe('15 feb');
    const long = dateTickFormatter([{ date: '2023-01-01' }, { date: '2024-03-01' }]);
    expect(long('2024-02-15')).toBe('feb 24');
    expect(dateTickFormatter([])('2024-02-15')).toBe('15 feb');
  });

  it('formats tooltip labels', () => {
    expect(dateLabel('2024-03-05')).toBe('5 mrt 2024');
    expect(monthLabel('2024-11')).toBe('nov 24');
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
  it('lists slices with prettified labels, compact values and weights', () => {
    renderWithProviders(
      <AllocationDonut
        currency="EUR"
        slices={[
          { key: 'STOCK', label: 'STOCK', value: 7500, weight: 0.75 },
          { key: 'ETF', label: 'ETF', value: 2500, weight: 0.25 },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Stock');
    expect(items[0]).toHaveTextContent('€ 7,5K');
    expect(items[0]).toHaveTextContent('75,0%');
    // Short acronyms stay upper-case.
    expect(items[1]).toHaveTextContent('ETF');
  });

  it('collapses the long tail into "Other" and cycles the palette', () => {
    const slices = Array.from({ length: 10 }, (_, i) => slice(i));
    renderWithProviders(<AllocationDonut currency="EUR" slices={slices} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(8);
    const other = items[7]!;
    expect(other).toHaveTextContent('Other');
    // 93 + 92 + 91 = 276; weights 0.093 + 0.092 + 0.091 = 27.6%
    expect(other).toHaveTextContent('€ 276');
    expect(other).toHaveTextContent('27,6%');
    expect(within(items[0]!).getByText('Label 0').previousSibling).toHaveStyle({ background: SERIES_COLORS[0] });
  });

  it('renders in dark mode', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderWithProviders(<AllocationDonut currency="EUR" slices={[slice(1)]} />);
    expect(screen.getByText('Label 1')).toBeInTheDocument();
  });
});

describe('ValueChart', () => {
  it('summarises the series for screen readers', () => {
    renderWithProviders(
      <ValueChart
        currency="EUR"
        points={[
          { date: '2024-01-01', value: 1000, invested: 900 },
          { date: '2024-06-01', value: 1200, invested: 1000 },
        ]}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: 'Portfolio value from 1 jan 2024 to 1 jun 2024: €\u00a01.000,00 to €\u00a01.200,00; invested €\u00a01.000,00.',
      }),
    ).toBeInTheDocument();
  });

  it('describes an empty series', () => {
    renderWithProviders(<ValueChart currency="EUR" points={[]} />);
    expect(screen.getByRole('img', { name: 'No history available.' })).toBeInTheDocument();
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
