import { cloneElement, type ReactElement } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BENCHMARK_SYMBOLS } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { ReturnsBarChart } from '../../components/charts/ReturnsBarChart';
import { BenchmarkTab } from './BenchmarkTab';
import { DividendGrowthTab } from './DividendGrowthTab';
import { GoalTab } from './GoalTab';
import { ReturnsTab } from './ReturnsTab';

vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  // jsdom has no layout: give the chart a size so the bars and lines are drawn
  const ResponsiveContainer = ({ children }: Readonly<{ children: ReactElement<{ width?: number; height?: number }> }>) => cloneElement(children, { width: 800, height: 300 });
  return { ...recharts, ResponsiveContainer };
});

/** Legend hover / keyboard preview on the Analytics tabs: what stays at full strength and what fades (drawn in jsdom through a fixed-size container). */

const entry = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name });
const opacities = (chart: HTMLElement, selector: string, attribute: string) => [...chart.querySelectorAll(selector)].map((el) => el.getAttribute(attribute));
const count = (values: (string | null)[], value: string) => values.filter((v) => v === value).length;
const LINES = 'path.recharts-line-curve';
const BARS = '.recharts-bar-rectangle path';
const strokes = (chart: HTMLElement) => opacities(chart, LINES, 'stroke-opacity');
const fills = (chart: HTMLElement) => opacities(chart, BARS, 'fill-opacity');

describe('Benchmark tab: legend preview', () => {
  async function open() {
    renderWithProviders(<BenchmarkTab />);
    const chart = await screen.findByTestId('benchmark-chart');
    await vi.waitFor(() => expect(chart.querySelectorAll(LINES).length).toBe(3));
    return { chart, legend: screen.getByTestId('benchmark-legend') };
  }

  it('keeps the previewed line (portfolio, benchmark or invested) and fades the other two; leaving restores', async () => {
    const user = userEvent.setup();
    const { chart, legend } = await open();
    expect(strokes(chart)).toEqual(['1', '1', '1']);

    await user.hover(entry(legend, 'Portfolio'));
    expect(strokes(chart)).toEqual(['1', '0.25', '0.25']);
    await user.hover(entry(legend, BENCHMARK_SYMBOLS[0]));
    expect(strokes(chart)).toEqual(['0.25', '1', '0.25']);
    await user.hover(entry(legend, 'Invested'));
    expect(strokes(chart)).toEqual(['0.25', '0.25', '1']);
    await user.unhover(entry(legend, 'Invested'));
    expect(strokes(chart)).toEqual(['1', '1', '1']);
  });

  it('previews through the keyboard and does nothing for an excluded entry', async () => {
    const user = userEvent.setup();
    const { chart, legend } = await open();
    const invested = entry(legend, 'Invested');
    for (let i = 0; i < 10 && document.activeElement !== invested; i++) await user.tab();
    expect(invested).toHaveFocus();
    expect(strokes(chart)).toEqual(['0.25', '0.25', '1']);
    act(() => invested.blur());
    expect(strokes(chart)).toEqual(['1', '1', '1']);

    await user.click(invested);
    await user.hover(invested);
    expect(strokes(chart)).toEqual(['1', '1']);
  });

  it('ignores a touch pointer: a tap only toggles', async () => {
    const { chart, legend } = await open();
    fireEvent.pointerEnter(entry(legend, 'Portfolio'), { pointerType: 'touch' });
    expect(strokes(chart)).toEqual(['1', '1', '1']);
  });
});

describe('Returns tab: legend preview', () => {
  it('keeps every bar while the only series is previewed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReturnsTab />);
    const chart = await screen.findByTestId('returns-chart');
    await vi.waitFor(() => expect(chart.querySelectorAll(BARS).length).toBeGreaterThan(0));
    const all = chart.querySelectorAll(BARS).length;
    await user.hover(entry(screen.getByTestId('returns-legend'), 'Return (TWR)'));
    expect(count(fills(chart), '1')).toBe(all);
    expect(screen.getByTestId('returns-chart')).toBe(chart);
  });

  it('fades bars that do not belong to the previewed entry', () => {
    const rows = [
      { period: '2025', start: '2025-01-01', end: '2025-12-31', twrPct: 5, irrPct: null, startValue: 100, endValue: 110, contributions: 0, income: 0, gain: 10 },
      { period: '2026', start: '2026-01-01', end: '2026-12-31', twrPct: -2, irrPct: null, startValue: 110, endValue: 100, contributions: 0, income: 0, gain: -10 },
    ];
    const { unmount } = renderWithProviders(<ReturnsBarChart rows={rows} period="year" focusKey="twrPct" />);
    expect(fills(screen.getByTestId('returns-chart'))).toEqual(['1', '1']);
    unmount();
    renderWithProviders(<ReturnsBarChart rows={rows} period="year" focusKey="other" />);
    expect(fills(screen.getByTestId('returns-chart'))).toEqual(['0.25', '0.25']);
  });
});

describe('Dividend growth tab: legend preview', () => {
  it('fades the series that is not previewed in the month chart; the year chart has one series', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendGrowthTab />);
    const monthChart = await screen.findByTestId('dividend-month-chart');
    const yearChart = screen.getByTestId('dividend-year-chart');
    await vi.waitFor(() => expect(monthChart.querySelectorAll(BARS).length).toBeGreaterThan(0));
    const monthLegend = screen.getByTestId('dividend-month-chart-legend');
    const all = monthChart.querySelectorAll(BARS).length;

    await user.hover(entry(monthLegend, 'This period'));
    expect(count(fills(monthChart), '1')).toBeGreaterThan(0);
    expect(count(fills(monthChart), '0.25')).toBeGreaterThan(0);
    expect(count(fills(monthChart), '1') + count(fills(monthChart), '0.25')).toBe(all);
    const kept = count(fills(monthChart), '1');

    await user.hover(entry(monthLegend, 'A year earlier'));
    expect(count(fills(monthChart), '1')).toBe(all - kept);
    // the other chart has a preview of its own
    expect(count(fills(yearChart), '0.25')).toBe(0);

    await user.hover(entry(screen.getByTestId('dividend-year-chart-legend'), 'Received'));
    expect(count(fills(yearChart), '0.25')).toBe(0);
    await user.unhover(entry(monthLegend, 'A year earlier'));
    expect(count(fills(monthChart), '0.25')).toBe(0);
  });
});

describe('Income goal tab: legend preview', () => {
  it('keeps the previewed scenario, fades the others and leaves the table and the target alone', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalTab />);
    const table = await screen.findByRole('table', { name: 'Projection per scenario' });
    const chart = screen.getByTestId('goal-chart');
    await vi.waitFor(() => expect(chart.querySelectorAll(LINES).length).toBe(3));
    const legend = screen.getByTestId('goal-legend');
    const tableText = table.textContent;

    await user.hover(entry(legend, 'Base'));
    expect(strokes(chart)).toEqual(['0.25', '1', '0.25']);
    expect(opacities(chart, '.recharts-reference-line-line', 'stroke-opacity')).not.toContain('0.25');
    expect(table.textContent).toBe(tableText);
    await user.hover(entry(legend, 'Optimistic'));
    expect(strokes(chart)).toEqual(['0.25', '0.25', '1']);
    await user.unhover(entry(legend, 'Optimistic'));
    expect(strokes(chart)).toEqual(['1', '1', '1']);
  });

  it('does nothing for an excluded scenario, and a table row toggles the same entry', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalTab />);
    const table = await screen.findByRole('table', { name: 'Projection per scenario' });
    const chart = screen.getByTestId('goal-chart');
    await vi.waitFor(() => expect(chart.querySelectorAll(LINES).length).toBe(3));
    const legend = screen.getByTestId('goal-legend');

    await user.click(within(table).getByRole('button', { name: /Optimistic/ }));
    await user.hover(entry(legend, 'Optimistic'));
    expect(strokes(chart)).toEqual(['1', '1']);
    await user.hover(entry(legend, 'Cautious'));
    expect(strokes(chart)).toEqual(['1', '0.25']);
  });
});
