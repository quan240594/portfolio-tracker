import { cloneElement, type ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import type { GrowthMonthRow, HoldingPerformanceRow } from '@portfolio/shared';
import { renderWithProviders, sp } from '../../test/utils';
import { THEME_STORAGE_KEY } from '../../theme/ThemeProvider';
import { DynamicsChart, PercentLabel, dynamicsTooltip, signedLabel } from './DynamicsChart';
import { ChartLegend, GrowthChart, growthTooltip } from './GrowthChart';
import { BarValueLabel, HoldingsChart, holdingsTooltip } from './HoldingsChart';
import type { GrowthRow } from './growthFormat';

// jsdom has no layout: give Recharts' ResponsiveContainer a fixed size so the charts really draw.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => cloneElement(children, { width: 900, height: 300 } as object),
  };
});

const rows: GrowthRow[] = Array.from({ length: 40 }, (_, i) => ({
  date: new Date(Date.UTC(2025, 0, 1 + i * 10)).toISOString().slice(0, 10),
  value: 1000 + i * 10,
  invested: 1000,
  returnPct: i / 4,
  v0: 1000 + i * 8,
  r0: i / 5,
}));

describe('GrowthChart', () => {
  it('draws the value area, the invested line and a benchmark with a text summary', () => {
    const { container } = renderWithProviders(<GrowthChart rows={rows} benchmarks={[{ symbol: 'IWDA.AS', index: 0 }]} kind="value" currency="EUR" summary="Summary text" testId="chart" />);
    expect(screen.getByRole('img', { name: 'Summary text' })).toBe(screen.getByTestId('chart'));
    expect(container.querySelectorAll('path.recharts-line-curve')).toHaveLength(2);
    expect(container.querySelector('path.recharts-area-area')).not.toBeNull();
    // one tick per month, never a repeated month label
    const ticks = [...container.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')].map((t) => t.textContent);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('draws the return lines with a zero line, in dark mode too', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { container } = renderWithProviders(
      <GrowthChart rows={rows.slice(0, 5)} benchmarks={[{ symbol: 'A', index: 0 }]} kind="return" currency="EUR" summary="s" testId="chart" />,
    );
    expect(container.querySelectorAll('path.recharts-line-curve')).toHaveLength(2);
    expect(container.querySelector('.recharts-reference-line')).not.toBeNull();
    expect(container.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick-value')[0]?.textContent).toMatch(/%$/);
  });

  it('formats tooltips as money or percentage', () => {
    expect(sp(growthTooltip(true, 'EUR')(1234.5, 'Portfolio')[0])).toBe('€ 1.234,50');
    expect(growthTooltip(false, 'EUR')(2.5, 'IWDA.AS')).toEqual(['+2,50%', 'IWDA.AS']);
  });
});

describe('ChartLegend', () => {
  it('lists the series with details and a dashed marker', () => {
    render(
      <ChartLegend
        items={[
          { key: 'a', color: '#111', label: 'Portfolio', detail: '€ 1 → € 2' },
          { key: 'b', color: '#222', label: 'Invested', dashed: true },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('€ 1 → € 2')).toBeInTheDocument();
    expect(items[1]!.firstElementChild).toHaveStyle({ borderTopStyle: 'dashed' });
  });
});

const months: GrowthMonthRow[] = [
  { month: '2026-01', portfolioPct: 4.2, benchmarks: { IWDA: 3 } },
  { month: '2026-02', portfolioPct: -1.7, benchmarks: { IWDA: null } },
  { month: '2026-03', portfolioPct: 0, benchmarks: {} },
];

describe('DynamicsChart', () => {
  it('labels every month with sign and arrow and adds a benchmark bar', () => {
    const { container } = renderWithProviders(<DynamicsChart months={months} benchmarks={[{ symbol: 'IWDA', index: 0 }]} summary="Monthly summary" />);
    expect(screen.getByRole('img', { name: 'Monthly summary' })).toBeInTheDocument();
    const labels = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(['▲ +4,2%', '▼ −1,7%', '■ 0,0%']));
    expect(container.querySelectorAll('.recharts-bar').length).toBe(2);
  });

  it('works without benchmarks', () => {
    const { container } = renderWithProviders(<DynamicsChart months={months} benchmarks={[]} summary="s" />);
    expect(container.querySelectorAll('.recharts-bar')).toHaveLength(1);
  });

  it('formats labels and tooltips', () => {
    expect(signedLabel(2.34)).toBe('▲ +2,3%');
    expect(signedLabel(-2.345, 2)).toBe('▼ −2,35%');
    expect(dynamicsTooltip(1.5, 'Portfolio')).toEqual(['▲ +1,50%', 'Portfolio']);
  });

  it('places the value label above positive and below negative bars', () => {
    const { container } = render(
      <svg>
        <PercentLabel x={10} y={50} width={20} height={30} value={3} gain="green" loss="red" />
        <PercentLabel x={10} y={80} width={20} height={-30} value={-3} gain="green" loss="red" />
      </svg>,
    );
    const [up, down] = [...container.querySelectorAll('text')];
    expect(up).toHaveAttribute('fill', 'green');
    expect(Number(up!.getAttribute('y'))).toBeLessThan(50);
    expect(up).toHaveAttribute('x', '20');
    expect(down).toHaveAttribute('fill', 'red');
    expect(Number(down!.getAttribute('y'))).toBeGreaterThan(80);
  });
});

const holdings: HoldingPerformanceRow[] = [
  { symbol: 'BTC', name: 'Bitcoin', returnPct: 86.3, gain: 100, from: '2025-01-01', sincePurchase: false },
  { symbol: 'KO', name: 'Coca-Cola', returnPct: -6.2, gain: -10, from: '2025-01-01', sincePurchase: true },
];

describe('HoldingsChart', () => {
  it('draws one bar per holding with labelled values', () => {
    const { container } = renderWithProviders(<HoldingsChart rows={holdings} summary="Holdings summary" />);
    expect(screen.getByRole('img', { name: 'Holdings summary' })).toBeInTheDocument();
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(2);
    const labels = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(['▲ +86,30%', '▼ −6,20%']));
    expect(holdingsTooltip(3)).toEqual(['▲ +3,00%', 'Return']);
  });

  it('anchors value labels at the end of the bar, left of negative bars', () => {
    const { container } = render(
      <svg>
        <BarValueLabel x={100} y={10} width={50} height={20} value={5} gain="g" loss="l" />
        <BarValueLabel x={100} y={40} width={-50} height={20} value={-5} gain="g" loss="l" />
      </svg>,
    );
    const [pos, neg] = [...container.querySelectorAll('text')];
    expect(pos).toHaveAttribute('text-anchor', 'start');
    expect(Number(pos!.getAttribute('x'))).toBeGreaterThan(150);
    expect(neg).toHaveAttribute('text-anchor', 'end');
    expect(Number(neg!.getAttribute('x'))).toBeLessThan(50);
  });
});
