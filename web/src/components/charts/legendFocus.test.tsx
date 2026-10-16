import { cloneElement, type ReactElement } from 'react';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AllocationSlice } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { AllocationDonut } from './AllocationDonut';
import { ValueChart } from './ValueChart';

vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  // jsdom has no layout: give the chart a size so the lines and slices are drawn
  const ResponsiveContainer = ({ children }: Readonly<{ children: ReactElement<{ width?: number; height?: number }> }>) => cloneElement(children, { width: 800, height: 300 });
  return { ...recharts, ResponsiveContainer };
});

/** Legend hover / keyboard preview on the Dashboard charts. */

const entry = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name });
const opacities = (chart: HTMLElement, selector: string, attribute: string) => [...chart.querySelectorAll(selector)].map((el) => el.getAttribute(attribute));

describe('ValueChart: legend preview', () => {
  const points = [
    { date: '2024-01-01', value: 1000, invested: 900 },
    { date: '2024-06-01', value: 1200, invested: 1000 },
  ];
  const area = (chart: HTMLElement) => ({
    fill: opacities(chart, '.recharts-area-area', 'fill-opacity'),
    stroke: opacities(chart, '.recharts-area-curve', 'stroke-opacity'),
    line: opacities(chart, 'path.recharts-line-curve', 'stroke-opacity'),
  });

  it('keeps the value area, or the invested line, and fades the other; leaving restores', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ValueChart currency="EUR" points={points} />);
    const chart = screen.getByTestId('value-chart');
    const legend = screen.getByTestId('value-legend');
    expect(area(chart)).toEqual({ fill: ['1'], stroke: ['1'], line: ['1'] });

    await user.hover(entry(legend, 'Value'));
    expect(area(chart)).toEqual({ fill: ['1'], stroke: ['1'], line: ['0.25'] });
    await user.hover(entry(legend, 'Invested'));
    expect(area(chart)).toEqual({ fill: ['0.25'], stroke: ['0.25'], line: ['1'] });
    await user.unhover(entry(legend, 'Invested'));
    expect(area(chart)).toEqual({ fill: ['1'], stroke: ['1'], line: ['1'] });
  });

  it('previews through the keyboard and does nothing for an excluded entry', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ValueChart currency="EUR" points={points} />);
    const chart = screen.getByTestId('value-chart');
    const value = entry(screen.getByTestId('value-legend'), 'Value');
    await user.tab();
    expect(value).toHaveFocus();
    expect(area(chart).line).toEqual(['0.25']);
    act(() => value.blur());
    expect(area(chart).line).toEqual(['1']);

    await user.click(entry(screen.getByTestId('value-legend'), 'Invested'));
    await user.hover(value);
    expect(area(chart)).toEqual({ fill: ['1'], stroke: ['1'], line: [] });
  });
});

describe('AllocationDonut: legend preview', () => {
  const slices: AllocationSlice[] = [
    { key: 'STOCK', label: 'STOCK', value: 5000, weight: 0.5 },
    { key: 'ETF', label: 'ETF', value: 3000, weight: 0.3 },
    { key: 'CASH', label: 'CASH', value: 2000, weight: 0.2 },
  ];
  const fills = () => opacities(screen.getByTestId('allocation-donut'), 'path.recharts-sector', 'fill-opacity');

  it('keeps the previewed slice, fades the others and keeps the centre text, the table and the legend', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AllocationDonut currency="EUR" slices={slices} />);
    const legend = screen.getByTestId('allocation-legend');
    const centre = screen.getByTestId('allocation-donut-centre').textContent;
    const table = screen.getByRole('table', { name: 'Allocation by category' }).textContent;
    expect(fills()).toEqual(['1', '1', '1']);

    await user.hover(entry(legend, 'ETF'));
    expect(fills()).toEqual(['0.25', '1', '0.25']);
    expect(screen.getByTestId('allocation-donut-centre').textContent).toBe(centre);
    expect(screen.getByRole('table', { name: 'Allocation by category' }).textContent).toBe(table);
    await user.unhover(entry(legend, 'ETF'));
    expect(fills()).toEqual(['1', '1', '1']);
  });

  it('previews through the keyboard, ignores an excluded slice and follows the slices that are left', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AllocationDonut currency="EUR" slices={slices} />);
    const legend = screen.getByTestId('allocation-legend');
    const stock = entry(legend, 'Stock');
    for (let i = 0; i < 10 && document.activeElement !== stock; i++) await user.tab();
    expect(stock).toHaveFocus();
    expect(fills()).toEqual(['1', '0.25', '0.25']);
    act(() => stock.blur());
    expect(fills()).toEqual(['1', '1', '1']);

    await user.click(stock);
    await user.hover(stock);
    expect(fills()).toEqual(['1', '1']);
    await user.hover(entry(legend, 'Cash'));
    expect(fills()).toEqual(['0.25', '1']);
  });
});
