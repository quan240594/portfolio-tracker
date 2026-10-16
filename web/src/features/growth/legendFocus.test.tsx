import { cloneElement, type ReactElement } from 'react';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { PercentLabel } from './DynamicsChart';
import { useVisibleBenchmarks } from './growthSelection';

// jsdom has no layout: give Recharts' ResponsiveContainer a fixed size so the charts really draw.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 900, height: 300 } as object),
  };
});

/** Legend hover / keyboard preview on the Growth tab: the entry's series stays, every other line or bar fades to 25 %. */

const card = (name: string) => screen.getByRole('region', { name });
const entry = (scope: HTMLElement, name: string | RegExp) => within(within(scope).getByRole('list', { name: /series$/ })).getByRole('button', { name });
const attributes = (chart: HTMLElement, selector: string, attribute: string) => [...chart.querySelectorAll(selector)].map((el) => el.getAttribute(attribute));
const count = (values: (string | null)[], value: string) => values.filter((v) => v === value).length;
const LINES = 'path.recharts-line-curve';
const BARS = '.recharts-bar-rectangle path';

describe('Portfolio value: legend preview', () => {
  it('keeps the previewed line (the area for the portfolio) and fades the others; leaving restores', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('growth-value-chart');
    const value = card('Portfolio value');
    const strokes = () => attributes(chart, LINES, 'stroke-opacity');
    const area = () => attributes(chart, '.recharts-area-area', 'fill-opacity');
    const areaLine = () => attributes(chart, '.recharts-area-curve', 'stroke-opacity');
    expect(strokes()).toEqual(['1', '1']);
    expect(area()).toEqual(['1']);

    // the benchmark: the area and the invested line fade, the benchmark stays
    await user.hover(entry(value, /^IWDA\.AS/));
    expect(count(strokes(), '1')).toBe(1);
    expect(count(strokes(), '0.25')).toBe(1);
    expect(area()).toEqual(['0.25']);
    expect(areaLine()).toEqual(['0.25']);

    // the portfolio: the area stays, both lines fade
    await user.hover(entry(value, /^Portfolio/));
    expect(strokes()).toEqual(['0.25', '0.25']);
    expect(area()).toEqual(['1']);
    expect(areaLine()).toEqual(['1']);

    await user.hover(entry(value, /^Invested/));
    expect(count(strokes(), '1')).toBe(1);
    expect(area()).toEqual(['0.25']);

    await user.unhover(entry(value, /^Invested/));
    expect(strokes()).toEqual(['1', '1']);
    expect(area()).toEqual(['1']);
    expect(entry(value, /^Invested/)).toHaveAttribute('aria-pressed', 'true');
    expect(within(value).queryByTestId('selection-note')).toBeNull();
  });

  it('does nothing for an excluded entry, and a Tab onto an entry previews it', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('growth-value-chart');
    const value = card('Portfolio value');
    await user.click(entry(value, /^IWDA\.AS/));
    expect(entry(value, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    await user.hover(entry(value, /^IWDA\.AS/));
    expect(count(attributes(chart, LINES, 'stroke-opacity'), '0.25')).toBe(0);
    await user.unhover(entry(value, /^IWDA\.AS/));

    act(() => entry(value, /^Portfolio/).focus());
    await user.tab({ shift: true });
    await user.tab();
    expect(entry(value, /^Portfolio/)).toHaveFocus();
    expect(attributes(screen.getByTestId('growth-value-chart'), LINES, 'stroke-opacity')).toEqual(['0.25']);
    await user.tab();
    expect(entry(value, /^Invested/)).toHaveFocus();
    expect(attributes(screen.getByTestId('growth-value-chart'), LINES, 'stroke-opacity')).toEqual(['1']);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(attributes(screen.getByTestId('growth-value-chart'), LINES, 'stroke-opacity')).toEqual(['1']);
  });
});

describe('Portfolio performance: legend preview', () => {
  it('fades the portfolio line when a benchmark is previewed and the benchmark when the portfolio is', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('growth-performance-chart');
    const perf = card('Portfolio performance');
    const strokes = () => attributes(chart, LINES, 'stroke-opacity');
    expect(strokes()).toEqual(['1', '1']);
    await user.hover(entry(perf, /^IWDA\.AS/));
    expect(strokes().sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['0.25', '1']);
    await user.hover(entry(perf, /^Portfolio/));
    expect(strokes().sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['0.25', '1']);
    await user.unhover(entry(perf, /^Portfolio/));
    expect(strokes()).toEqual(['1', '1']);
  });
});

describe('Dynamics of portfolio returns: legend preview', () => {
  it('keeps the previewed bars and fades the other series and the value labels', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const dynamics = card('Dynamics of portfolio returns');
    const chart = await within(dynamics).findByTestId('growth-dynamics-chart');
    const fills = () => attributes(chart, BARS, 'fill-opacity');
    const all = fills().length;
    expect(count(fills(), '1')).toBe(all);
    const labels = () => new Set(attributes(chart, '.recharts-label-list text', 'opacity'));
    expect(labels()).toEqual(new Set(['1']));

    await user.hover(entry(dynamics, /^IWDA\.AS/));
    expect(count(fills(), '1')).toBeGreaterThan(0);
    expect(count(fills(), '0.25')).toBeGreaterThan(0);
    expect(count(fills(), '1') + count(fills(), '0.25')).toBe(all);
    expect(count(attributes(chart, BARS, 'stroke-opacity'), '0.25')).toBe(count(fills(), '0.25'));
    expect(labels()).toEqual(new Set(['0.25']));

    await user.hover(entry(dynamics, /^Portfolio/));
    expect(count(fills(), '1')).toBeGreaterThan(0);
    expect(count(fills(), '0.25')).toBeGreaterThan(0);
    expect(labels()).toEqual(new Set(['1']));

    await user.unhover(entry(dynamics, /^Portfolio/));
    expect(count(fills(), '1')).toBe(all);
    expect(labels()).toEqual(new Set(['1']));
  });

  it('an excluded series has nothing to preview', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const dynamics = card('Dynamics of portfolio returns');
    const chart = await within(dynamics).findByTestId('growth-dynamics-chart');
    await user.click(entry(dynamics, /^IWDA\.AS/));
    await user.hover(entry(dynamics, /^IWDA\.AS/));
    expect(count(attributes(chart, BARS, 'fill-opacity'), '0.25')).toBe(0);
    await user.hover(entry(dynamics, /^Portfolio/));
    expect(count(attributes(screen.getByTestId('growth-dynamics-chart'), BARS, 'fill-opacity'), '0.25')).toBe(0);
  });
});

describe('Holdings performance: legend preview', () => {
  it('has one series that covers every bar, so hovering it changes nothing', async () => {
    renderApp('/analytics');
    const user = userEvent.setup();
    const holdings = card('Holdings performance');
    const chart = await within(holdings).findByTestId('growth-holdings-chart');
    const before = attributes(chart, BARS, 'fill-opacity');
    await user.hover(entry(holdings, /^Return per holding/));
    expect(attributes(chart, BARS, 'fill-opacity')).toEqual(before);
    expect(count(before, '0.25')).toBe(0);
  });
});

describe('growth preview helpers', () => {
  it('renders the percent label at the given opacity, full strength by default', () => {
    const { container } = render(
      <svg>
        <PercentLabel x={0} y={0} width={10} height={20} value={2} gain="#0a0" loss="#a00" />
      </svg>,
    );
    expect(container.querySelector('text')).toHaveAttribute('opacity', '1');
    const faded = render(
      <svg>
        <PercentLabel x={0} y={0} width={10} height={20} value={-2} gain="#0a0" loss="#a00" opacity={0.25} />
      </svg>,
    );
    expect(faded.container.querySelector('text')).toHaveAttribute('opacity', '0.25');
  });

  it('keeps the same visible-benchmark array while only the preview changes', () => {
    const bench = [
      { symbol: 'A', index: 0 },
      { symbol: 'B', index: 1 },
    ];
    const visible = (key: string) => key !== 'A';
    const { result, rerender } = renderHook(({ isSeriesVisible }) => useVisibleBenchmarks(bench, { isSeriesVisible }), { initialProps: { isSeriesVisible: visible } });
    const first = result.current;
    expect(first).toEqual([{ symbol: 'B', index: 1 }]);
    rerender({ isSeriesVisible: visible });
    expect(result.current).toBe(first);
    rerender({ isSeriesVisible: (key: string) => key !== 'B' });
    expect(result.current).toEqual([{ symbol: 'A', index: 0 }]);
  });
});
