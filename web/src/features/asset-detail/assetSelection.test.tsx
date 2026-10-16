import { cloneElement, type ReactElement } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetDividendYear, AssetHistoryResponse } from '@portfolio/shared';
import { renderApp, renderWithProviders } from '../../test/utils';
import { chartSelectionSummary, selectableChartTable } from './assetChartData';
import { DividendYearChart, dividendYearLabel, selectYears, yearId, yearKind, yearSeriesKeys } from './DividendYearChart';
import { PriceChart } from './PriceChart';

// jsdom has no layout: give Recharts' ResponsiveContainer a fixed size so the charts really draw.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 900, height: 300 } as object),
  };
});

const years: AssetDividendYear[] = [
  { year: 2024, perShare: 1, payments: 4, complete: true },
  { year: 2025, perShare: 1.2, payments: 4, complete: true },
  { year: 2026, perShare: 0.6, payments: 2, complete: false },
];

const history: AssetHistoryResponse = {
  symbol: 'AAA',
  range: '1M',
  baseCurrency: 'EUR',
  currency: 'USD',
  points: [
    { date: '2026-06-01', close: 100, pct: 0 },
    { date: '2026-06-02', close: 90, pct: -10 },
  ],
  benchmarks: [{ symbol: 'IWDA.AS', available: true, comparison: null, points: [{ date: '2026-06-01', value: 1, returnPct: 0 }, { date: '2026-06-02', value: 1, returnPct: 3 }] }],
  markers: [],
  coverage: { from: '2026-06-01', limited: false },
} as unknown as AssetHistoryResponse;

const lines = (el: HTMLElement) => el.querySelectorAll('path.recharts-line-curve').length;
/** One x-axis label per year that is drawn (a stacked bar has a zero-height rectangle for the other kind of year). */
const yearsDrawn = (el: HTMLElement) => el.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value').length;
const bars = (el: HTMLElement) => el.querySelectorAll('path.recharts-rectangle').length;
const legendButton = (testId: string, name: string | RegExp) => within(screen.getByTestId(testId)).getByRole('button', { name });

describe('asset chart selection helpers', () => {
  it('names the series of a year chart that have data, and the years that stay', () => {
    expect(yearSeriesKeys(years)).toEqual(['complete', 'partial']);
    expect(yearSeriesKeys(years.slice(0, 2))).toEqual(['complete']);
    expect(yearKind(years[2]!)).toBe('partial');
    expect(yearId(years[0]!)).toBe('2024');
    const view = (hiddenRows: string[], hiddenSeries: string[]) => ({
      isRowVisible: (id: string) => !hiddenRows.includes(id),
      isSeriesVisible: (key: string) => !hiddenSeries.includes(key),
    });
    expect(selectYears(years, view([], [])).map(yearId)).toEqual(['2024', '2025', '2026']);
    expect(selectYears(years, view(['2025'], [])).map(yearId)).toEqual(['2024', '2026']);
    expect(selectYears(years, view([], ['partial'])).map(yearId)).toEqual(['2024', '2025']);
  });

  it('says "current selection" in the label only while something is excluded', () => {
    expect(dividendYearLabel(years, 'USD', 'AAA', false)).toMatch(/^Dividend per share of AAA per year: 2024 /);
    expect(dividendYearLabel(years.slice(1), 'USD', 'AAA', true)).toMatch(/^Dividend per share of AAA per year, current selection: 2025 /);
  });

  it('draws only the year bars that are shown', () => {
    const draw = (showComplete: boolean, showPartial: boolean) => {
      const { container, unmount } = renderWithProviders(<DividendYearChart byYear={years} currency="USD" showComplete={showComplete} showPartial={showPartial} label="l" />);
      const count = bars(container);
      unmount();
      return count;
    };
    expect(draw(true, true)).toBe(3);
    expect(draw(true, false)).toBe(2);
    expect(draw(false, true)).toBe(1);
  });

  it('builds the price table as series columns and plain date rows', () => {
    const perf = selectableChartTable(history, 'performance', 24);
    expect(perf.columns).toEqual([
      { key: 'price', label: 'AAA', selectable: true },
      { key: 'IWDA.AS', label: 'IWDA.AS', selectable: true },
    ]);
    expect(perf.rows[0]).toMatchObject({ header: '1 jun 2026', selectable: false });
    expect(perf.rows[0]!.id).toBe(perf.rows[0]!.header);
    const price = selectableChartTable(history, 'price', 24);
    expect(price.columns.map((c) => [c.key, c.selectable])).toEqual([
      ['price', true],
      ['change', false],
    ]);
  });

  it('summarises the lines that are left', () => {
    expect(chartSelectionSummary(history, 'performance', ['IWDA.AS'])).toBe('Price change of AAA from 1 jun 2026 to 2 jun 2026, current selection: IWDA.AS.');
    expect(chartSelectionSummary(history, 'price', ['AAA'])).toMatch(/^Closing price of AAA from /);
    expect(chartSelectionSummary({ ...history, points: [] }, 'price', [])).toBe('No price history is stored for AAA in this period.');
  });

  it('leaves the security line, its high/low labels and trade markers out when it is excluded', () => {
    const rows = [
      { date: '2026-06-01', value: 0, b0: 0 },
      { date: '2026-06-02', value: -10, b0: 3 },
    ];
    const marker = { key: 'm', type: 'BUY' as const, x: '2026-06-02', y: -10, label: 'Buy' };
    const draw = (showPrice: boolean) => {
      const { container, unmount } = renderWithProviders(
        <PriceChart rows={rows} mode="performance" benchmarks={[{ symbol: 'IWDA.AS', index: 0 }]} showPrice={showPrice} markers={[marker]} currency="USD" summary="s" symbol="AAA" />,
      );
      const result = { lines: lines(container), labels: [...container.querySelectorAll('text')].map((t) => t.textContent ?? '').filter((t) => /High|Low/.test(t)), markers: container.querySelectorAll('.recharts-reference-dot path').length };
      unmount();
      return result;
    };
    const shown = draw(true);
    expect(shown.lines).toBe(2);
    expect(shown.labels.length).toBeGreaterThan(0);
    expect(shown.markers).toBeGreaterThan(0);
    const hidden = draw(false);
    expect(hidden.lines).toBe(1);
    expect(hidden.labels).toHaveLength(0);
    expect(hidden.markers).toBe(0);
  });
});

describe('Asset detail: include and exclude series and rows', () => {
  it('the price chart hides the security or a benchmark from the legend and the table, and the empty state offers Show all', async () => {
    renderApp('/assets/ASML.AS?portfolio=all');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('asset-price-chart');
    expect(lines(chart)).toBe(2);
    expect(screen.getByRole('list', { name: 'Trade markers' })).toBeInTheDocument();

    await user.click(legendButton('asset-price-legend', /^IWDA\.AS/));
    expect(lines(screen.getByTestId('asset-price-chart'))).toBe(1);
    expect(screen.getByTestId('asset-price-chart')).toHaveAccessibleName(/^Price change of ASML\.AS from .* to .*, current selection: ASML\.AS\.$/);
    expect(screen.getByTestId('selection-note')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Data table' }));
    const table = screen.getByRole('table', { name: 'ASML.AS price change over time' });
    expect(within(table).getByRole('button', { name: 'IWDA.AS' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(table).queryAllByRole('rowheader').flatMap((h) => within(h).queryAllByRole('button'))).toHaveLength(0);
    await user.click(within(table).getByRole('button', { name: 'ASML.AS' }));
    await user.click(screen.getByRole('button', { name: 'Data table' }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Trade markers' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(lines(screen.getByTestId('asset-price-chart'))).toBe(2);
    expect(screen.queryByTestId('selection-note')).toBeNull();
    expect(screen.getByRole('list', { name: 'Trade markers' })).toBeInTheDocument();
  });

  it('the price view has one series; excluding it leaves the empty state', async () => {
    renderApp('/assets/ASML.AS?portfolio=all');
    const user = userEvent.setup();
    await screen.findByTestId('asset-price-chart');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Chart type' })).getByRole('radio', { name: 'Price' }));
    await user.click(legendButton('asset-price-legend', /^ASML\.AS/));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
  });

  it('the dividends per year chart drops a year or a kind of year, in sync with the table', async () => {
    // the mock data has one full year (2025) and three partial ones
    renderApp('/assets/AAPL?portfolio=all&tab=dividends');
    const user = userEvent.setup();
    const all = yearsDrawn(await screen.findByTestId('asset-dividend-chart'));
    expect(all).toBe(4);

    await user.click(legendButton('asset-dividend-legend', 'Partial year'));
    expect(yearsDrawn(screen.getByTestId('asset-dividend-chart'))).toBe(1);
    expect(screen.getByTestId('asset-dividend-chart')).toHaveAccessibleName(/^Dividend per share of AAPL per year, current selection: 2025 /);

    await user.click(screen.getByRole('button', { name: 'Data table' }));
    const table = screen.getByRole('table', { name: 'Dividend per share of AAPL per year' });
    expect(within(table).getByRole('button', { name: 'Partial year' })).toHaveAttribute('aria-pressed', 'false');
    // the only full year is excluded as a row: no year is left to draw
    await user.click(within(within(table).getByRole('rowheader', { name: '2025' })).getByRole('button'));
    await user.click(screen.getByRole('button', { name: 'Data table' }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'show all' }));
    expect(yearsDrawn(screen.getByTestId('asset-dividend-chart'))).toBe(all);

    await user.click(screen.getByRole('button', { name: 'Data table' }));
    await user.click(within(within(screen.getByRole('table', { name: 'Dividend per share of AAPL per year' })).getByRole('rowheader', { name: '2024' })).getByRole('button'));
    await user.click(screen.getByRole('button', { name: 'Data table' }));
    expect(yearsDrawn(screen.getByTestId('asset-dividend-chart'))).toBe(all - 1);

    await user.click(legendButton('asset-dividend-legend', 'Full year'));
    await user.click(legendButton('asset-dividend-legend', 'Partial year'));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
  });
});
