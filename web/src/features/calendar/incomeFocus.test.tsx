import { cloneElement, type ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarMonth } from '@portfolio/shared';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { IncomeChart, incomeBars } from './CalendarOverview';
import { incomeColours } from './calendarColours';

vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  // jsdom has no layout: give the chart a size so the bars and the lines are drawn
  const ResponsiveContainer = ({ children }: Readonly<{ children: ReactElement<{ width?: number; height?: number }> }>) => cloneElement(children, { width: 800, height: 300 });
  return { ...recharts, ResponsiveContainer };
});

/** Legend hover / keyboard preview of the Calendar income chart: the status (or the average line) stays, the rest fades. */

const monthly: CalendarMonth[] = [
  { month: '2026-09', paid: 10, declared: 0, estimated: 0, total: 10 },
  { month: '2026-10', paid: 5, declared: 20, estimated: 5, total: 30 },
  { month: '2026-11', paid: 0, declared: 12, estimated: 30, total: 42 },
];

const BARS = '.recharts-bar-rectangle path';
const legend = () => screen.getByTestId('calendar-income-legend');
const entry = (name: string) => within(legend()).getByRole('button', { name });
const chart = () => screen.getByTestId('calendar-income-chart');
const opacities = (selector: string, attribute = 'fill-opacity') => [...chart().querySelectorAll(selector)].map((el) => el.getAttribute(attribute));
const count = (values: (string | null)[], value: string) => values.filter((v) => v === value).length;
const line = () => opacities('.recharts-reference-line line', 'stroke-opacity');
const labels = () => new Set(opacities('.recharts-label-list text', 'opacity'));

function renderChart() {
  render(
    <ThemeProvider>
      <IncomeChart monthly={monthly} average={27.33} currency="EUR" />
    </ThemeProvider>,
  );
}

describe('incomeBars', () => {
  const colours = incomeColours('light');

  it('draws the included statuses in stacking order at full strength while nothing is previewed', () => {
    const bars = incomeBars(colours, ['paid', 'estimated'], null);
    expect(bars.map((b) => b.props.dataKey)).toEqual(['paid', 'estimated']);
    expect(bars.map((b) => [b.props.fillOpacity, b.props.strokeOpacity])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(bars[1]!.props.strokeDasharray).toBe('4 2');
    expect(bars[0]!.props.strokeDasharray).toBeUndefined();
  });

  it('fades every status but the previewed one, and every status for the average line', () => {
    expect(incomeBars(colours, ['paid', 'declared', 'estimated'], 'declared').map((b) => b.props.fillOpacity)).toEqual([0.25, 1, 0.25]);
    expect(incomeBars(colours, ['paid', 'declared', 'estimated'], 'declared').map((b) => b.props.strokeOpacity)).toEqual([0.25, 1, 0.25]);
    expect(incomeBars(colours, ['paid', 'declared'], 'avg').map((b) => b.props.fillOpacity)).toEqual([0.25, 0.25]);
  });
});

describe('IncomeChart: legend preview', () => {
  it('keeps the previewed status, fades the other bars, the average line and (a little) the value labels; leaving restores', async () => {
    const user = userEvent.setup();
    renderChart();
    await vi.waitFor(() => expect(opacities(BARS).length).toBeGreaterThan(0));
    const all = opacities(BARS).length;
    expect(count(opacities(BARS), '1')).toBe(all);
    expect(line()).toEqual(['1']);
    expect(labels()).toEqual(new Set(['1']));

    await user.hover(entry('Declared'));
    const hovered = opacities(BARS);
    expect(count(hovered, '1')).toBeGreaterThan(0);
    expect(count(hovered, '0.25')).toBe(all - count(hovered, '1'));
    expect(line()).toEqual(['0.25']);
    expect(labels()).toEqual(new Set(['0.5']));

    await user.hover(entry('Received'));
    expect(count(opacities(BARS), '1')).toBeGreaterThan(0);

    await user.unhover(entry('Received'));
    expect(count(opacities(BARS), '1')).toBe(all);
    expect(line()).toEqual(['1']);
    expect(labels()).not.toContain('0.5');
  });

  it('previews the plain average item: the line and its label stay, every bar fades', async () => {
    const user = userEvent.setup();
    renderChart();
    await vi.waitFor(() => expect(opacities(BARS).length).toBeGreaterThan(0));
    const all = opacities(BARS).length;
    await user.hover(within(legend()).getByText('avg'));
    expect(count(opacities(BARS), '0.25')).toBe(all);
    expect(line()).toEqual(['1']);
    expect(chart().querySelector('.recharts-reference-line text')).toHaveAttribute('opacity', '1');
    await user.unhover(within(legend()).getByText('avg'));
    expect(count(opacities(BARS), '1')).toBe(all);
  });

  it('previews from the keyboard and ends the preview on blur', async () => {
    const user = userEvent.setup();
    renderChart();
    await vi.waitFor(() => expect(opacities(BARS).length).toBeGreaterThan(0));
    await user.tab();
    expect(entry('Received')).toHaveFocus();
    expect(count(opacities(BARS), '0.25')).toBeGreaterThan(0);
    await user.tab();
    expect(entry('Declared')).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(count(opacities(BARS), '0.25')).toBe(0);
  });

  it('does nothing for an excluded status, and a click still toggles it back', async () => {
    const user = userEvent.setup();
    renderChart();
    await vi.waitFor(() => expect(opacities(BARS).length).toBeGreaterThan(0));
    await user.click(entry('Declared'));
    expect(entry('Declared')).toHaveAttribute('aria-pressed', 'false');
    await user.hover(entry('Declared'));
    expect(count(opacities(BARS), '0.25')).toBe(0);
    expect(line()).toEqual(['1']);
    await user.hover(entry('Estimated'));
    expect(count(opacities(BARS), '0.25')).toBeGreaterThan(0);
    await user.click(entry('Declared'));
    expect(entry('Declared')).toHaveAttribute('aria-pressed', 'true');
  });

  it('never changes what is included or the chart text alternative', async () => {
    const user = userEvent.setup();
    renderChart();
    const label = chart().getAttribute('aria-label');
    await user.hover(entry('Estimated'));
    expect(chart().getAttribute('aria-label')).toBe(label);
    expect(screen.queryByTestId('selection-note')).toBeNull();
    expect(entry('Received')).toHaveAttribute('aria-pressed', 'true');
  });
});
