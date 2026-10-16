import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BenchmarkPoint, GoalScenario, ReturnPeriodRow } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { THEME_STORAGE_KEY } from '../../theme/ThemeProvider';
import { BenchmarkChart, benchmarkSeriesName, benchmarkSummary } from './BenchmarkChart';
import { DividendGrowthChart, hasPreviousSeries } from './DividendGrowthChart';
import { GoalChart, goalRows, goalSummary, scenarioColours, scenarioName } from './GoalChart';
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

  it('says it shows a selection when periods are excluded', () => {
    renderWithProviders(<ReturnsBarChart rows={[row('2025', -3.5), row('2026', 12)]} period="year" filtered />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/over 2 periods\. Best 2026 .*Chart shows the current selection\.$/);
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

  it('describes only the series that are drawn', () => {
    expect(benchmarkSummary(points, 'EUR', 'IWDA.AS', { portfolio: true, benchmark: false, invested: true })).toMatch(/^Portfolio value from 1 jan 2026 to 1 feb 2026: .*1\.100,00\.$/);
    expect(benchmarkSummary(points, 'EUR', 'IWDA.AS', { portfolio: false, benchmark: true, invested: false })).toMatch(/^IWDA\.AS replayed with the same cash flows ended at .*1\.050,00\.$/);
    expect(benchmarkSummary(points, 'EUR', 'IWDA.AS', { portfolio: false, benchmark: false, invested: true })).toMatch(/^Invested from 1 jan 2026 to 1 feb 2026: .*1\.000,00 to .*1\.000,00\.$/);
    expect(benchmarkSummary(points, 'EUR', 'IWDA.AS', { portfolio: false, benchmark: false, invested: false })).toBe('');
  });

  it('has a legend that excludes series and shows them again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BenchmarkChart points={points} currency="EUR" benchmark="IWDA.AS" />);
    const legend = screen.getByTestId('benchmark-legend');
    expect(within(legend).getAllByRole('button').map((b) => b.textContent)).toEqual(['Portfolio', 'IWDA.AS', 'Invested']);
    await user.click(within(legend).getByRole('button', { name: 'IWDA.AS' }));
    expect(within(legend).getByRole('button', { name: 'IWDA.AS' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('benchmark-chart')).toHaveAccessibleName(/^Portfolio value from .*1\.100,00\. Chart shows the current selection\.$/);
    await user.click(within(legend).getByRole('button', { name: 'Portfolio' }));
    await user.click(within(legend).getByRole('button', { name: 'Invested' }));
    expect(screen.getByTestId('nothing-selected')).toBeInTheDocument();
    await user.click(within(legend).getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('benchmark-chart')).toBeInTheDocument();
  });

  it('has no benchmark entry without a benchmark series', () => {
    renderWithProviders(<BenchmarkChart points={points.map((p) => ({ ...p, benchmark: null }))} currency="EUR" benchmark="X" />);
    expect(within(screen.getByTestId('benchmark-legend')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Portfolio', 'Invested']);
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

  it('describes the series that is drawn and says when it shows a selection', () => {
    const bars = [{ label: 'jan', current: 10, previous: 5 }, { label: 'feb', current: 20, previous: 15 }];
    expect(hasPreviousSeries(bars)).toBe(true);
    expect(hasPreviousSeries([{ label: 'jan', current: 1 }])).toBe(false);
    const { unmount } = renderWithProviders(<DividendGrowthChart bars={bars} currency="EUR" title="Monthly" testId="m" showCurrent={false} filtered />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Monthly: 2 periods, .*20,00 a year earlier\. Chart shows the current selection\.$/);
    unmount();
    renderWithProviders(<DividendGrowthChart bars={bars} currency="EUR" title="Monthly" testId="m" showPrevious={false} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Monthly: 2 periods, .*30,00 in total\.$/);
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

  it('describes the first scenario that is drawn when the base one is excluded, and says when it shows a selection', () => {
    expect(goalSummary([scenarios[0]!, scenarios[2]!], 1000, 'EUR')).toMatch(/in the cautious scenario, against a target of .*1\.000,00\.$/);
    expect(goalSummary([scenarios[2]!], 1000, 'EUR')).toMatch(/in the optimistic scenario/);
    expect(goalSummary([], 1000, 'EUR')).toBe('No projection available.');
    expect(Object.keys(scenarioColours(analyticsTheme('dark')))).toEqual(['cautious', 'base', 'optimistic']);
  });

  it('draws the scenarios it is given', () => {
    renderWithProviders(<GoalChart scenarios={[scenarios[1]!]} targetIncome={1000} currency="EUR" filtered />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/base scenario.*Chart shows the current selection\.$/);
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
