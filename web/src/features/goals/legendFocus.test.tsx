import { cloneElement, type ReactElement } from 'react';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultGoalSettings, projectGoal } from '@portfolio/shared';
import { renderWithProviders } from '../../test/utils';
import { GoalResults } from './GoalResults';

vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  // jsdom has no layout: give the chart a size so the lines and dots are drawn
  const ResponsiveContainer = ({ children }: Readonly<{ children: ReactElement<{ width?: number; height?: number }> }>) => cloneElement(children, { width: 800, height: 300 });
  return { ...recharts, ResponsiveContainer };
});

/** Legend hover / keyboard preview on the Goals chart: goal, safe, alternative and plan lines (the dots belong to their line). */

const TODAY = '2026-10-15';
const projection = projectGoal({
  settings: { ...defaultGoalSettings(TODAY), goalType: 'value', targetAmount: 20_000, targetYear: 2056, monthlyContribution: 0, reinvestDividends: false, adjustForInflation: false },
  start: { value: 10_000, income: 400, yieldPct: 4 },
  today: TODAY,
  baseCurrency: 'EUR',
});

const entry = (name: string) => within(screen.getByTestId('goal-legend')).getByRole('button', { name });
const chart = () => screen.getByTestId('goal-chart');
const opacities = (selector: string, attribute: string) => [...chart().querySelectorAll(selector)].map((el) => el.getAttribute(attribute));
// drawn in the order of the legend: goal, safe, alternative, plan
const lines = () => opacities('path.recharts-line-curve', 'stroke-opacity');
const dots = () => opacities('.recharts-reference-dot-dot', 'fill-opacity');

describe('Goals chart: legend preview', () => {
  it('keeps the previewed line and its goal-reached dot, fades the other lines and dots; leaving restores', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalResults projection={projection} />);
    const reached = projection.scenarios.filter((s) => s.reachedYear !== null).length;
    expect(reached).toBeGreaterThan(0);
    expect(lines()).toEqual(['1', '1', '1', '1']);
    expect(dots()).toHaveLength(reached);

    await user.hover(entry('Safe'));
    expect(lines()).toEqual(['0.25', '1', '0.25', '0.25']);
    expect(dots().filter((v) => v === '1')).toHaveLength(projection.scenarios.some((s) => s.id === 'safe' && s.reachedYear !== null) ? 1 : 0);
    expect(dots().filter((v) => v === '0.25')).toHaveLength(dots().length - (dots().filter((v) => v === '1')).length);

    await user.hover(entry('Your plan'));
    expect(lines()).toEqual(['0.25', '0.25', '0.25', '1']);
    await user.hover(entry('Goal (inflation-adjusted)'));
    expect(lines()).toEqual(['1', '0.25', '0.25', '0.25']);
    // the goal has no dot of its own: every dot fades
    expect(dots().every((v) => v === '0.25')).toBe(true);

    await user.unhover(entry('Goal (inflation-adjusted)'));
    expect(lines()).toEqual(['1', '1', '1', '1']);
    expect(dots().every((v) => v === '1')).toBe(true);
  });

  it('leaves the verdict, the summary and the insights alone', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalResults projection={projection} />);
    const before = screen.getByRole('region', { name: 'Goal summary' }).textContent;
    const insights = screen.getByRole('list', { name: 'Insights' }).textContent;
    await user.hover(entry('Alternative'));
    expect(screen.getByRole('region', { name: 'Goal summary' }).textContent).toBe(before);
    expect(screen.getByRole('list', { name: 'Insights' }).textContent).toBe(insights);
    expect(entry('Alternative')).toHaveAttribute('aria-pressed', 'true');
  });

  it('previews through the keyboard and does nothing for an excluded entry', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GoalResults projection={projection} />);
    const safe = entry('Safe');
    for (let i = 0; i < 30 && document.activeElement !== safe; i++) await user.tab();
    expect(safe).toHaveFocus();
    expect(lines()).toEqual(['0.25', '1', '0.25', '0.25']);
    act(() => safe.blur());
    expect(lines()).toEqual(['1', '1', '1', '1']);

    await user.click(safe);
    await user.hover(safe);
    expect(lines()).toEqual(['1', '1', '1']);
    await user.hover(entry('Your plan'));
    expect(lines()).toEqual(['0.25', '0.25', '1']);
  });
});
