import { screen } from '@testing-library/react';
import type { BenchmarkPoint, GoalScenario, ReturnPeriodRow } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { THEME_STORAGE_KEY } from '../../theme/ThemeProvider';
import { BenchmarkChart, benchmarkSeriesName } from './BenchmarkChart';
import { DividendGrowthChart } from './DividendGrowthChart';
import { GoalChart, goalRows, scenarioName } from './GoalChart';
import { ReturnsBarChart, returnsTooltip } from './ReturnsBarChart';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';

const row = (period: string, twrPct: number): ReturnPeriodRow => ({
  period,
  start: `${period}-01-01`,
  end: `${period}-12-31`,
  twrPct,
  irrPct: null,
  startValue: 100,
  endValue: 110,
  contributions: 0,
  income: 0,
  gain: 10,
});

describe('ReturnsBarChart', () => {
  it('summarises best and worst period for assistive technology', () => {
    renderWithProviders(<ReturnsBarChart rows={[row('2024', 5), row('2025', -3.5), row('2026', 12)]} period="year" />);
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      'Time-weighted return per year over 3 periods. Best 2026 +12,00%, worst 2025 \u22123,50%.',
    );
    expect(screen.getByTestId('returns-chart')).toBeInTheDocument();
  });

  it('formats the tooltip', () => {
    expect(returnsTooltip(4.5)).toEqual(['+4,50%', 'Time-weighted return']);
  });
});

describe('BenchmarkChart', () => {
  const points: BenchmarkPoint[] = [
    { date: '2026-01-01', portfolio: 1000, benchmark: 1000, invested: 1000 },
    { date: '2026-02-01', portfolio: 1100, benchmark: 1050, invested: 1000 },
  ];

  it('describes both paths', () => {
    renderWithProviders(<BenchmarkChart points={points} currency="EUR" benchmark="IWDA.AS" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(
      /^Portfolio value from 1 jan 2026 to 1 feb 2026: .*1\.000,00 to .*1\.100,00, against IWDA\.AS replayed with the same cash flows: .*1\.050,00\.$/,
    );
  });

  it('describes only the portfolio when the benchmark is missing, and an empty series', () => {
    const { unmount } = renderWithProviders(<BenchmarkChart points={points.map((p) => ({ ...p, benchmark: null }))} currency="EUR" benchmark="X" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('against');
    unmount();
    renderWithProviders(<BenchmarkChart points={[]} currency="EUR" benchmark="X" />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'No history available.');
  });

  it('names series', () => {
    const name = benchmarkSeriesName('IWDA.AS');
    expect([name('portfolio'), name('benchmark'), name('invested')]).toEqual(['Portfolio', 'IWDA.AS', 'Invested']);
  });
});

describe('DividendGrowthChart', () => {
  it('renders one or two series', () => {
    const { unmount } = renderWithProviders(
      <DividendGrowthChart bars={[{ label: '2025', current: 100 }, { label: '2026', current: 150 }]} currency="EUR" title="Per year" testId="year" />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Per year: 2 periods, .*250,00 in total\.$/);
    unmount();
    renderWithProviders(<DividendGrowthChart bars={[{ label: 'jan', current: 10, previous: 5 }]} currency="EUR" title="Monthly" testId="month" />);
    expect(screen.getByTestId('month')).toBeInTheDocument();
  });
});

describe('GoalChart', () => {
  const scenario = (id: GoalScenario['id'], incomes: number[]): GoalScenario => ({
    id,
    label: id,
    dividendGrowthPct: 5,
    yieldOnNewMoneyPct: 3.5,
    yearsToGoal: null,
    points: incomes.map((income, year) => ({ year, income, contributed: 0 })),
  });
  const scenarios = [scenario('cautious', [100, 150]), scenario('base', [100, 200]), scenario('optimistic', [100, 250])];

  it('pivots scenarios into one row per year', () => {
    expect(goalRows(scenarios)).toEqual([
      { year: 0, cautious: 100, base: 100, optimistic: 100 },
      { year: 1, cautious: 150, base: 200, optimistic: 250 },
    ]);
    expect(goalRows([])).toEqual([]);
    expect(goalRows([scenario('base', [1, 2]), { ...scenario('cautious', [1]) }])[1]).toEqual({ year: 1, base: 2, cautious: 0 });
  });

  it('summarises the base scenario against the target', () => {
    renderWithProviders(<GoalChart scenarios={scenarios} targetIncome={1000} currency="EUR" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Projected annual passive income over 1 years: .*200,00 in the base scenario, against a target of .*1\.000,00\.$/);
  });

  it('copes without scenarios and names them', () => {
    renderWithProviders(<GoalChart scenarios={[]} targetIncome={1} currency="EUR" />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'No projection available.');
    expect([scenarioName('cautious'), scenarioName('base'), scenarioName('optimistic'), scenarioName('x')]).toEqual(['Cautious', 'Base', 'Optimistic', 'x']);
  });
});

describe('analyticsTheme', () => {
  it('has light and dark palettes', () => {
    const light = analyticsTheme('light');
    const dark = analyticsTheme('dark');
    expect(light.gain).not.toBe(dark.gain);
    expect(light.value).toBe('#4f46e5');
    expect(tooltipStyle(dark)).toMatchObject({ background: dark.tooltipBg, borderRadius: 8 });
    expect(THEME_STORAGE_KEY).toBeTruthy();
  });
});
