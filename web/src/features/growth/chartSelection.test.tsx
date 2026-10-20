import { cloneElement, type ReactElement } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HoldingPerformanceRow } from '@portfolio/shared';
import { renderApp, sp } from '../../test/utils';
import { dynamicsSeries } from './DynamicsCard';
import { holdingsSummary } from './HoldingsCard';
import { performanceSeries } from './PerformanceCard';
import { valueSeries } from './ValueCard';
import { legendEntries, selectionSummary, seriesKeys, shownLabels, visibleBenchmarks, type LineSeries } from './growthSelection';

// jsdom has no layout: give Recharts' ResponsiveContainer a fixed size so the charts really draw.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 900, height: 300 } as object),
  };
});

const card = (name: string) => screen.getByRole('region', { name });
const lines = (chart: HTMLElement) => chart.querySelectorAll('path.recharts-line-curve').length;
/** The legend entry of a card (the table headers carry the same names). */
const toggle = (scope: HTMLElement, name: string | RegExp) => within(within(scope).getByRole('list', { name: /series$/ })).getByRole('button', { name });

describe('growth selection helpers', () => {
  const series: LineSeries[] = [
    { key: 'portfolio', label: 'Portfolio', color: '#111', detail: '+1%' },
    { key: 'IWDA.AS', label: 'IWDA.AS', color: '#222', dashed: true },
  ];
  const view = (hidden: string[]) => ({ isSeriesVisible: (key: string) => !hidden.includes(key) });

  it('turns series into legend entries with line or square swatches, and into keys', () => {
    const entries = legendEntries(series);
    expect(entries.map((e) => [e.key, e.label, e.detail])).toEqual([
      ['portfolio', 'Portfolio', '+1%'],
      ['IWDA.AS', 'IWDA.AS', undefined],
    ]);
    expect(legendEntries(series, 'square')).toHaveLength(2);
    expect(seriesKeys(series)).toEqual(['portfolio', 'IWDA.AS']);
  });

  it('keeps the visible benchmarks and the labels that are left', () => {
    const bench = [
      { symbol: 'A', index: 0 },
      { symbol: 'B', index: 1 },
    ];
    expect(visibleBenchmarks(bench, view(['A']))).toEqual([{ symbol: 'B', index: 1 }]);
    expect(shownLabels(series, view(['portfolio']))).toEqual(['IWDA.AS']);
    expect(selectionSummary('Portfolio value', 'from 01-01-2026 to 02-01-2026', ['Portfolio', 'B'])).toBe('Portfolio value from 01-01-2026 to 02-01-2026, current selection: Portfolio, B.');
  });

  it('keeps the colour of a benchmark by its index, whatever else is shown', () => {
    const colours = dynamicsSeries(
      [
        { symbol: 'A', index: 0 },
        { symbol: 'C', index: 2 },
      ],
      'light',
    ).map((s) => s.color);
    expect(colours[1]).not.toBe(colours[2]);
    expect(dynamicsSeries([{ symbol: 'C', index: 2 }], 'light')[1]!.color).toBe(colours[2]);
    expect(dynamicsSeries([], 'dark').map((s) => s.key)).toEqual(['portfolio']);
  });

  it('describes the holdings that are drawn', () => {
    const rows: HoldingPerformanceRow[] = [
      { symbol: 'BTC', name: 'Bitcoin', returnPct: 10, gain: 1, from: '2025-01-01', sincePurchase: false },
      { symbol: 'KO', name: 'Coca-Cola', returnPct: -5, gain: -1, from: '2025-01-01', sincePurchase: false },
    ];
    expect(holdingsSummary(rows, false)).toBe('Return per holding over the selected range, 2 holdings. Best BTC ▲ +10,00%, worst KO ▼ −5,00%.');
    expect(holdingsSummary(rows.slice(1), true)).toContain('1 holdings, current selection');
    expect(holdingsSummary([], true)).toBe('No holdings selected.');
  });

  it('exposes the series of the cards for the default data', () => {
    const period = { from: '2025-01-01', to: '2026-01-01', startValue: 100, endValue: 120, invested: 100, gain: 20, returnPct: 20 };
    const data = {
      baseCurrency: 'EUR',
      benchmarks: [
        { symbol: 'IWDA.AS', available: true, points: [{ date: '2025-01-01', value: 100, returnPct: 0 }, { date: '2026-01-01', value: 110, returnPct: 10 }] },
        { symbol: 'GONE', available: false, points: [] },
      ],
    } as unknown as Parameters<typeof valueSeries>[0];
    expect(valueSeries(data, period, 'light').map((s) => s.key)).toEqual(['portfolio', 'invested', 'IWDA.AS']);
    expect(performanceSeries(data, period, true, 'light').map((s) => s.key)).toEqual(['portfolio', 'IWDA.AS']);
    expect(performanceSeries(data, period, false, 'dark').map((s) => s.key)).toEqual(['portfolio']);
  });
});

describe('Growth tab: include and exclude series and rows', () => {
  it('the value card hides a benchmark, keeps the headline whole, and Show all brings it back', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('growth-value-chart');
    const value = card('Portfolio value');
    const headline = (await screen.findByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by /)).textContent;
    expect(lines(chart)).toBe(2);
    expect(within(value).queryByTestId('selection-note')).toBeNull();

    await user.click(toggle(value, /^IWDA\.AS/));
    expect(toggle(value, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    expect(lines(screen.getByTestId('growth-value-chart'))).toBe(1);
    expect(within(value).getByTestId('selection-note')).toHaveTextContent('Chart shows the current selection');
    expect(screen.getByTestId('growth-value-chart')).toHaveAccessibleName(/^Portfolio value from .* to .*, current selection: Portfolio, Invested\.$/);
    // the headline describes the whole portfolio and the benchmark stays selected in the picker
    expect(screen.getByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by /).textContent).toBe(headline);
    expect(within(card('Benchmarks')).getByText('IWDA.AS')).toBeInTheDocument();

    await user.click(toggle(value, /^Invested/));
    await user.click(toggle(value, /^Portfolio/));
    expect(within(value).getByTestId('nothing-selected')).toHaveTextContent('Nothing selected: show all');
    expect(screen.queryByTestId('growth-value-chart')).toBeNull();
    await user.click(within(value).getByRole('button', { name: 'show all' }));
    expect(lines(screen.getByTestId('growth-value-chart'))).toBe(2);
    expect(toggle(value, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    expect(within(value).queryByTestId('selection-note')).toBeNull();
  });

  it('the value table toggles the series from its column headers; dates are plain row headers', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    await screen.findByTestId('growth-value-chart');
    const value = card('Portfolio value');
    await user.click(within(value).getByRole('button', { name: 'Data table' }));
    const table = within(value).getByRole('table', { name: 'Portfolio value over time' });
    expect(within(table).queryAllByRole('rowheader').flatMap((h) => within(h).queryAllByRole('button'))).toHaveLength(0);
    expect(table).toHaveAccessibleDescription('Click a column or row header to include or exclude it from the chart');
    await user.click(within(table).getByRole('button', { name: 'IWDA.AS' }));
    expect(within(table).getByRole('button', { name: 'IWDA.AS' })).toHaveAttribute('aria-pressed', 'false');
    expect(toggle(value, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    // the table keeps every number, dimmed
    expect(within(table).getAllByRole('row')).toHaveLength(25);
    expect(within(table).getAllByRole('row')[1]!.lastElementChild).toHaveClass('line-through');
    await user.click(within(value).getAllByRole('button', { name: 'Show all' })[0]!);
    await user.click(within(value).getByRole('button', { name: 'Data table' }));
    expect(screen.getByTestId('growth-value-chart')).toBeInTheDocument();
    expect(lines(screen.getByTestId('growth-value-chart'))).toBe(2);
  });

  it('the performance card drops a benchmark; turning Compare off forgets it', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('growth-performance-chart');
    const perf = card('Portfolio performance');
    expect(lines(chart)).toBe(2);
    await user.click(toggle(perf, /^IWDA\.AS/));
    expect(lines(screen.getByTestId('growth-performance-chart'))).toBe(1);
    expect(screen.getByTestId('growth-performance-chart')).toHaveAccessibleName(/current selection: Portfolio\.$/);
    await user.click(toggle(perf, /^Portfolio/));
    expect(within(perf).getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(within(perf).getAllByRole('button', { name: 'Show all' })[0]!);
    expect(lines(screen.getByTestId('growth-performance-chart'))).toBe(2);

    // a benchmark that leaves the chart (Compare off) is forgotten: it is back when Compare is switched on again
    await user.click(toggle(perf, /^IWDA\.AS/));
    const compare = screen.getAllByRole('checkbox', { name: 'Compare' })[0]!;
    await user.click(compare);
    await user.click(compare);
    expect(toggle(perf, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    expect(lines(screen.getByTestId('growth-performance-chart'))).toBe(2);
  });

  it('the dynamics card excludes the portfolio bars, a benchmark and single months from the table', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const dynamics = card('Dynamics of portfolio returns');
    const chart = await within(dynamics).findByTestId('growth-dynamics-chart');
    const groups = (el: HTMLElement) => el.querySelectorAll('.recharts-bar').length;
    const bars = (el: HTMLElement) => el.querySelectorAll('.recharts-bar-rectangle').length;
    expect(groups(chart)).toBe(2);
    const all = bars(chart);

    await user.click(toggle(dynamics, /^Portfolio/));
    expect(groups(screen.getByTestId('growth-dynamics-chart'))).toBe(1);
    expect(screen.getByTestId('growth-dynamics-chart')).toHaveAccessibleName(/^Monthly returns of IWDA\.AS over \d+ months, current selection\.$/);
    await user.click(toggle(dynamics, /^Portfolio/));

    await user.click(within(dynamics).getByRole('button', { name: 'View details' }));
    const table = within(dynamics).getByRole('table', { name: 'Monthly returns, newest first' });
    const first = within(table).getAllByRole('rowheader')[0]!;
    await user.click(within(first).getByRole('button'));
    expect(within(first).getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    expect(bars(screen.getByTestId('growth-dynamics-chart'))).toBeLessThan(all);
    expect(screen.getByTestId('growth-dynamics-chart')).toHaveAccessibleName(/current selection\. Best month/);
    expect(within(dynamics).getByTestId('selection-note')).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: 'IWDA.AS' }));
    await user.click(toggle(dynamics, /^Portfolio/));
    expect(within(dynamics).getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(within(dynamics).getByRole('button', { name: 'show all' }));
    expect(bars(screen.getByTestId('growth-dynamics-chart'))).toBe(all);
    expect(within(dynamics).queryByTestId('selection-note')).toBeNull();
  });

  it('the holdings card excludes holdings from bars and table, and the single series from the legend', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const holdings = card('Holdings performance');
    const chart = await within(holdings).findByTestId('growth-holdings-chart');
    const bars = (el: HTMLElement) => el.querySelectorAll('.recharts-bar-rectangle').length;
    const all = bars(chart);
    expect(all).toBeGreaterThan(1);

    await user.click(within(holdings).getByRole('radio', { name: 'Table' }));
    const table = within(holdings).getByRole('table', { name: 'Return per holding, best first' });
    const row = within(table).getAllByRole('rowheader')[0]!;
    const symbol = row.textContent!;
    await user.click(within(row).getByRole('button'));
    await user.click(within(holdings).getByRole('radio', { name: 'Bars' }));
    expect(bars(screen.getByTestId('growth-holdings-chart'))).toBe(all - 1);
    expect(screen.getByTestId('growth-holdings-chart')).toHaveAccessibleName(/current selection\. Best /);
    expect(screen.getByTestId('growth-holdings-chart').getAttribute('aria-label')).not.toContain(`Best ${symbol}`);

    await user.click(toggle(holdings, /^Return per holding/));
    expect(within(holdings).getByTestId('nothing-selected')).toBeInTheDocument();
    // the table stays, so the selection can be undone there
    await user.click(within(holdings).getByRole('radio', { name: 'Table' }));
    expect(within(holdings).getByRole('table', { name: 'Return per holding, best first' })).toBeInTheDocument();
    await user.click(within(holdings).getAllByRole('button', { name: 'Show all' })[0]!);
    await user.click(within(holdings).getByRole('radio', { name: 'Bars' }));
    await waitFor(() => expect(bars(screen.getByTestId('growth-holdings-chart'))).toBe(all));
    expect(sp(within(holdings).getByRole('list', { name: 'Holdings performance series' }).textContent!)).toContain('Return per holding');
  });
});
