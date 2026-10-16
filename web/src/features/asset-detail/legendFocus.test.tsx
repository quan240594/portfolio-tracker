import { cloneElement, type ReactElement } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, renderWithProviders } from '../../test/utils';
import { DividendYearChart } from './DividendYearChart';
import { MarkerShape, PriceChart } from './PriceChart';

// jsdom has no layout: give Recharts' ResponsiveContainer a fixed size so the charts really draw.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 900, height: 300 } as object),
  };
});

/** Legend hover / keyboard preview on the asset detail charts: the entry's series stays, the rest fades to 25 %. */

const entry = (testId: string, name: string | RegExp) => within(screen.getByTestId(testId)).getByRole('button', { name });
const attributes = (chart: HTMLElement, selector: string, attribute: string) => [...chart.querySelectorAll(selector)].map((el) => el.getAttribute(attribute));
const count = (values: (string | null)[], value: string) => values.filter((v) => v === value).length;
const LINES = 'path.recharts-line-curve';
const MARKERS = '.recharts-reference-dot path';
const DOTS = '.recharts-reference-dot circle';

describe('Price history: legend preview', () => {
  it('keeps the security line with its high/low dots and labels, or a benchmark, and fades the rest; leaving restores', async () => {
    renderApp('/assets/ASML.AS?portfolio=all');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('asset-price-chart');
    const strokes = () => attributes(chart, LINES, 'stroke-opacity');
    const labels = () => new Set(attributes(chart, '.recharts-reference-dot .recharts-label', 'opacity'));
    expect(strokes()).toEqual(['1', '1']);
    expect(chart.querySelectorAll(DOTS).length).toBeGreaterThan(0);
    expect(chart.querySelectorAll(MARKERS).length).toBeGreaterThan(0);

    // a benchmark: the security line, its dots, labels and the trade markers fade
    await user.hover(entry('asset-price-legend', /^IWDA\.AS/));
    expect(count(strokes(), '1')).toBe(1);
    expect(count(strokes(), '0.25')).toBe(1);
    expect(new Set(attributes(chart, DOTS, 'fill-opacity'))).toEqual(new Set(['0.25']));
    expect(new Set(attributes(chart, MARKERS, 'fill-opacity'))).toEqual(new Set(['0.25']));
    expect(new Set(attributes(chart, MARKERS, 'stroke-opacity'))).toEqual(new Set(['0.25']));
    expect(labels()).toEqual(new Set(['0.25']));

    // the security: its markers stay, the benchmark fades
    await user.hover(entry('asset-price-legend', /^ASML\.AS/));
    expect(count(strokes(), '1')).toBe(1);
    expect(count(strokes(), '0.25')).toBe(1);
    expect(new Set(attributes(chart, DOTS, 'fill-opacity'))).toEqual(new Set(['1']));
    expect(new Set(attributes(chart, MARKERS, 'fill-opacity'))).toEqual(new Set(['1']));
    expect(labels()).toEqual(new Set(['1']));

    await user.unhover(entry('asset-price-legend', /^ASML\.AS/));
    expect(strokes()).toEqual(['1', '1']);
    expect(entry('asset-price-legend', /^ASML\.AS/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('selection-note')).toBeNull();
  });

  it('does nothing for an excluded entry, and a Tab onto an entry previews it', async () => {
    renderApp('/assets/ASML.AS?portfolio=all');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('asset-price-chart');
    await user.click(entry('asset-price-legend', /^IWDA\.AS/));
    await user.hover(entry('asset-price-legend', /^IWDA\.AS/));
    expect(count(attributes(screen.getByTestId('asset-price-chart'), LINES, 'stroke-opacity'), '0.25')).toBe(0);
    await user.unhover(entry('asset-price-legend', /^IWDA\.AS/));
    await user.click(entry('asset-price-legend', /^IWDA\.AS/));

    act(() => entry('asset-price-legend', /^ASML\.AS/).focus());
    await user.tab({ shift: true });
    await user.tab();
    expect(entry('asset-price-legend', /^ASML\.AS/)).toHaveFocus();
    expect(count(attributes(chart, LINES, 'stroke-opacity'), '0.25')).toBe(1);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(count(attributes(screen.getByTestId('asset-price-chart'), LINES, 'stroke-opacity'), '0.25')).toBe(0);
  });

  it('draws the markers and labels at full strength without a preview, and faded when a previewed line is not the security', () => {
    const rows = [
      { date: '2026-06-01', value: 0, b0: 0 },
      { date: '2026-06-02', value: -10, b0: 3 },
    ];
    const marker = { key: 'm', type: 'BUY' as const, x: '2026-06-02', y: -10, label: 'Buy' };
    const draw = (focusKey?: string | null) => {
      const { container, unmount } = renderWithProviders(
        <PriceChart rows={rows} mode="performance" benchmarks={[{ symbol: 'IWDA.AS', index: 0 }]} showPrice markers={[marker]} currency="USD" summary="s" symbol="AAA" focusKey={focusKey} />,
      );
      const result = { markers: new Set(attributes(container, MARKERS, 'fill-opacity')), lines: attributes(container, LINES, 'stroke-opacity') };
      unmount();
      return result;
    };
    expect(draw()).toEqual({ markers: new Set(['1']), lines: ['1', '1'] });
    expect(draw('price')).toEqual({ markers: new Set(['1']), lines: ['1', '0.25'] });
    expect(draw('IWDA.AS')).toEqual({ markers: new Set(['0.25']), lines: ['0.25', '1'] });
  });

  it('draws every marker shape at the given opacity', () => {
    const colors = { BUY: '#0a0', SELL: '#a00', DIVIDEND: '#fa0' };
    for (const type of ['BUY', 'SELL', 'DIVIDEND'] as const) {
      const { container, unmount } = render(
        <svg>
          <MarkerShape cx={5} cy={5} type={type} colors={colors} opacity={0.25} />
        </svg>,
      );
      expect(container.querySelector('path')).toHaveAttribute('fill-opacity', '0.25');
      expect(container.querySelector('path')).toHaveAttribute('stroke-opacity', '0.25');
      unmount();
    }
    const { container } = render(
      <svg>
        <MarkerShape cx={5} cy={5} type="BUY" colors={colors} />
      </svg>,
    );
    expect(container.querySelector('path')).toHaveAttribute('fill-opacity', '1');
  });
});

describe('Dividends per year: legend preview', () => {
  const years = [
    { year: 2024, perShare: 1, payments: 4, complete: true },
    { year: 2025, perShare: 1.2, payments: 4, complete: true },
    { year: 2026, perShare: 0.6, payments: 2, complete: false },
  ];

  it('keeps the previewed kind of year and fades the other; excluded kinds and leaving restore', async () => {
    renderApp('/assets/AAPL?portfolio=all&tab=dividends');
    const user = userEvent.setup();
    const chart = await screen.findByTestId('asset-dividend-chart');
    const bars = () => attributes(chart, '.recharts-bar-rectangle path', 'fill-opacity');
    const all = bars().length;
    expect(count(bars(), '1')).toBe(all);

    await user.hover(entry('asset-dividend-legend', 'Full year'));
    expect(count(bars(), '1')).toBe(1);
    expect(count(bars(), '0.25')).toBe(all - 1);
    expect(count(attributes(chart, '.recharts-bar-rectangle path', 'stroke-opacity'), '0.25')).toBe(all - 1);

    await user.hover(entry('asset-dividend-legend', 'Partial year'));
    expect(count(bars(), '1')).toBe(all - 1);
    expect(count(bars(), '0.25')).toBe(1);

    await user.unhover(entry('asset-dividend-legend', 'Partial year'));
    expect(count(bars(), '1')).toBe(all);

    await user.click(entry('asset-dividend-legend', 'Full year'));
    await user.hover(entry('asset-dividend-legend', 'Full year'));
    expect(count(attributes(screen.getByTestId('asset-dividend-chart'), '.recharts-bar-rectangle path', 'fill-opacity'), '0.25')).toBe(0);
  });

  it('fades the kind that is not previewed in the chart itself', () => {
    const draw = (focusKey?: string | null) => {
      const { container, unmount } = renderWithProviders(<DividendYearChart byYear={years} currency="USD" showComplete showPartial label="l" focusKey={focusKey} />);
      const bars = attributes(container, '.recharts-bar-rectangle path', 'fill-opacity');
      unmount();
      return bars;
    };
    expect(draw()).toEqual(['1', '1', '1']);
    expect(draw('partial').sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['0.25', '0.25', '1']);
    expect(draw('complete').sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['0.25', '1', '1']);
  });
});
