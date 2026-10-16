import { cloneElement, type ReactElement } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/utils';
import { ConsistencyCard } from './ConsistencyCard';
import { DiversificationCard } from './DiversificationCard';
import { DividendGrowthCard } from './DividendGrowthCard';
import { FuturePaymentsCard } from './GrowthAndFuture';
import { ReceivedCards } from './ReceivedCards';
import { YieldPayoutCard } from './YieldPayoutCard';

vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  // jsdom has no layout: give the chart a size so the bars, slices and lines are drawn
  const ResponsiveContainer = ({ children }: Readonly<{ children: ReactElement<{ width?: number; height?: number }> }>) => cloneElement(children, { width: 800, height: 300 });
  return { ...recharts, ResponsiveContainer };
});

/** Legend hover / keyboard preview: what stays and what fades in every chart of the Dividends page (drawn in jsdom through a fixed-size container). */

const legendIn = (testId: string) => screen.getByTestId(testId);
const entry = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name });
const shapes = (chart: HTMLElement, selector: string) => [...chart.querySelectorAll(selector)];
const opacities = (chart: HTMLElement, selector: string, attribute = 'fill-opacity') => shapes(chart, selector).map((el) => el.getAttribute(attribute));
const count = (values: (string | null)[], value: string) => values.filter((v) => v === value).length;
const BARS = '.recharts-bar-rectangle path';
const SLICES = 'path.recharts-sector';

describe('Dividend growth, By year: legend preview', () => {
  async function open() {
    renderWithProviders(<DividendGrowthCard />);
    const chart = await screen.findByTestId('year-compare-chart');
    await screen.findByTestId('forecast-summary');
    await vi.waitFor(() => expect(shapes(chart, BARS).length).toBeGreaterThan(0));
    return { chart: screen.getByTestId('year-compare-chart'), legend: legendIn('growth-legend') };
  }

  it('keeps a year with its forecast stack, a forecast kind in every year and fades the rest; leaving restores', async () => {
    const user = userEvent.setup();
    const { chart, legend } = await open();
    const all = shapes(chart, BARS).length;
    expect(count(opacities(chart, BARS), '1')).toBe(all);

    await user.hover(entry(legend, '2025'));
    const year = opacities(chart, BARS);
    expect(count(year, '1')).toBeGreaterThan(0);
    expect(count(year, '1') + count(year, '0.25')).toBe(all);
    expect(count(year, '0.25')).toBeGreaterThan(0);

    await user.hover(entry(legend, 'Declared (forecast)'));
    const declared = opacities(chart, BARS);
    expect(count(declared, '1')).toBeGreaterThan(0);
    expect(count(declared, '0.25')).toBe(all - count(declared, '1'));

    await user.hover(entry(legend, 'Average of years'));
    expect(count(opacities(chart, BARS), '1')).toBe(0);
    expect(opacities(chart, 'path.recharts-line-curve', 'stroke-opacity')).toEqual(['1']);

    await user.unhover(entry(legend, 'Average of years'));
    expect(count(opacities(chart, BARS), '1')).toBe(all);
    expect(opacities(chart, 'path.recharts-line-curve', 'stroke-opacity')).toEqual(['1']);
  });

  it('previews a forecast-only year as its declared and estimated bars, and nothing for an excluded entry', async () => {
    const user = userEvent.setup();
    const { chart, legend } = await open();
    const all = shapes(chart, BARS).length;
    const forecastYear = within(legend)
      .getAllByRole('button')
      .find((b) => /^\d{4} \(forecast\)$/.test(b.textContent!));
    expect(forecastYear).toBeDefined();
    await user.hover(forecastYear!);
    const kept = count(opacities(chart, BARS), '1');
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(all);

    await user.click(forecastYear!);
    await user.hover(forecastYear!);
    expect(count(opacities(chart, BARS), '0.25')).toBe(0);
  });

  it('fades the average line while a bar entry is previewed', async () => {
    const user = userEvent.setup();
    const { chart, legend } = await open();
    await user.hover(entry(legend, '2025'));
    expect(opacities(chart, 'path.recharts-line-curve', 'stroke-opacity')).toEqual(['0.25']);
  });

  it('fades the other series of the timeline', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(within(screen.getByRole('region', { name: 'Dividend growth', exact: true } as { name: string })).getByRole('radio', { name: 'Timeline' }));
    const chart = await screen.findByTestId('growth-timeline-chart');
    const legend = legendIn('growth-legend');
    await vi.waitFor(() => expect(shapes(chart, BARS).length).toBeGreaterThan(0));
    await user.hover(entry(legend, 'Trend'));
    expect(count(opacities(chart, BARS), '1')).toBe(0);
    expect(opacities(chart, 'path.recharts-line-curve', 'stroke-opacity')).toContain('1');
    expect(opacities(chart, 'path.recharts-line-curve', 'stroke-opacity')).toContain('0.25');
    await user.hover(entry(legend, 'Received'));
    expect(count(opacities(chart, BARS), '1')).toBeGreaterThan(0);
    await user.unhover(entry(legend, 'Received'));
    expect(count(opacities(chart, BARS), '0.25')).toBe(0);
    expect(count(opacities(chart, 'path.recharts-line-curve', 'stroke-opacity'), '0.25')).toBe(0);
  });
});

describe('Dividends received: legend preview', () => {
  it('keeps the previewed status, fades the other bars and the average line, and dims the value labels a little', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedCards />);
    const chart = await screen.findByTestId('received-time-chart');
    await vi.waitFor(() => expect(shapes(chart, BARS).length).toBeGreaterThan(0));
    const legend = legendIn('received-legend');
    const all = shapes(chart, BARS).length;
    const line = () => opacities(chart, '.recharts-reference-line line', 'stroke-opacity');
    expect(line()).toEqual(['1']);

    await user.hover(entry(legend, 'Declared'));
    const bars = opacities(chart, BARS);
    expect(count(bars, '1')).toBeGreaterThan(0);
    expect(count(bars, '0.25')).toBe(all - count(bars, '1'));
    expect(line()).toEqual(['0.25']);
    expect(new Set(opacities(chart, '.recharts-label-list text', 'opacity'))).toEqual(new Set(['0.5']));

    await user.hover(entry(legend, 'avg'));
    expect(count(opacities(chart, BARS), '1')).toBe(0);
    expect(line()).toEqual(['1']);

    await user.unhover(entry(legend, 'avg'));
    expect(count(opacities(chart, BARS), '1')).toBe(all);
    expect(line()).toEqual(['1']);
  });

  it('has nothing to dim in the one-series by-holding chart, and hovering it changes nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedCards />);
    const chart = await screen.findByTestId('received-holding-chart');
    await user.hover(entry(legendIn('received-holding-chart-legend'), 'Received'));
    expect(shapes(chart, BARS).every((el) => el.getAttribute('fill-opacity') === null)).toBe(true);
  });
});

describe('Future payments: legend preview', () => {
  it('previews a status and the plain monthly average item', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FuturePaymentsCard />);
    const chart = await screen.findByTestId('future-chart');
    await vi.waitFor(() => expect(shapes(chart, BARS).length).toBeGreaterThan(0));
    const legend = legendIn('future-legend');
    const line = () => opacities(chart, '.recharts-reference-line line', 'stroke-opacity');

    await user.hover(entry(legend, 'Declared'));
    expect(count(opacities(chart, BARS), '1')).toBeGreaterThan(0);
    expect(line()).toEqual(['0.25']);

    await user.hover(within(legend).getByText('Monthly average'));
    expect(count(opacities(chart, BARS), '1')).toBe(0);
    expect(line()).toEqual(['1']);

    await user.unhover(within(legend).getByText('Monthly average'));
    expect(count(opacities(chart, BARS), '0.25')).toBe(0);
  });
});

describe('Yield / payout: legend preview', () => {
  it('fades the dots while the bars are previewed and the bars while the dots are', async () => {
    const user = userEvent.setup();
    renderWithProviders(<YieldPayoutCard />);
    const chart = await screen.findByTestId('yield-payout-chart');
    await vi.waitFor(() => expect(shapes(chart, BARS).length).toBeGreaterThan(0));
    const legend = legendIn('yield-payout-legend');
    const dots = () => opacities(chart, 'circle.recharts-dot');
    expect(new Set(dots())).toEqual(new Set(['1']));

    await user.hover(entry(legend, 'Yield on value'));
    expect(new Set(dots())).toEqual(new Set(['0.25']));
    expect(new Set(opacities(chart, BARS))).toEqual(new Set(['1']));

    await user.hover(entry(legend, 'Yield on cost'));
    expect(new Set(dots())).toEqual(new Set(['1']));
    expect(new Set(opacities(chart, BARS))).toEqual(new Set(['0.25']));

    await user.unhover(entry(legend, 'Yield on cost'));
    expect(new Set(opacities(chart, BARS))).toEqual(new Set(['1']));
  });
});

describe('Donuts: legend preview', () => {
  it('income: keeps the previewed slice and its ranked row, fades the others, and the centre stays', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiversificationCard />);
    const donut = await screen.findByTestId('income-donut');
    await vi.waitFor(() => expect(shapes(donut, SLICES).length).toBeGreaterThan(1));
    const all = shapes(donut, SLICES).length;
    const legend = legendIn('income-legend');
    const centre = screen.getByTestId('income-donut-centre').textContent;
    const rows = () => within(screen.getByRole('list', { name: 'Holdings ranked by expected annual income' })).getAllByRole('listitem');

    await user.hover(within(legend).getAllByRole('button')[1]!);
    const slices = opacities(donut, SLICES);
    expect(count(slices, '1')).toBe(1);
    expect(count(slices, '0.25')).toBe(all - 1);
    expect(rows().filter((li) => li.style.opacity === '1')).toHaveLength(1);
    expect(rows().filter((li) => li.style.opacity !== '1')).toHaveLength(all - 1);
    expect(screen.getByTestId('income-donut-centre').textContent).toBe(centre);

    await user.unhover(within(legend).getAllByRole('button')[1]!);
    expect(count(opacities(donut, SLICES), '1')).toBe(all);
    expect(rows().every((li) => li.style.opacity === '1')).toBe(true);
  });

  it('a slice that is excluded has nothing to preview', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiversificationCard />);
    const donut = await screen.findByTestId('income-donut');
    await vi.waitFor(() => expect(shapes(donut, SLICES).length).toBeGreaterThan(1));
    const first = within(legendIn('income-legend')).getAllByRole('button')[0]!;
    await user.click(first);
    await user.hover(first);
    expect(count(opacities(screen.getByTestId('income-donut'), SLICES), '0.25')).toBe(0);
  });

  it('safety: previews a badge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConsistencyCard />);
    const donut = await screen.findByTestId('consistency-donut');
    await vi.waitFor(() => expect(shapes(donut, SLICES).length).toBeGreaterThan(0));
    const buttons = within(legendIn('consistency-legend')).getAllByRole('button');
    await user.hover(buttons[0]!);
    const slices = opacities(donut, SLICES);
    expect(count(slices, '1')).toBe(1);
    expect(count(slices, '0.25')).toBe(slices.length - 1);
    await user.unhover(buttons[0]!);
    expect(count(opacities(donut, SLICES), '0.25')).toBe(0);
  });
});
