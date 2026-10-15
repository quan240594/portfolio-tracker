import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { GoalResponse } from '@portfolio/shared';
import { API_BASE_URL } from '../config';
import { server } from '../mocks/server';
import { resetDb } from '../mocks/db';
import { gotoViaNav, renderApp, sp } from '../test/utils';

const goalsUrl = (path = '') => `${API_BASE_URL}/goals${path}`;
const VERDICT = /Achievable in \d+ years? \(by \d{4}\)|Not reached within the horizon|Goal already reached/;
/** The headline verdict (the chart's screen-reader summary repeats it). */
const verdict = () => screen.getByText(VERDICT, { selector: 'output' });

async function openGoals(route = '/goals?portfolio=default') {
  const user = userEvent.setup();
  renderApp(route);
  await screen.findByText(VERDICT, { selector: 'output' });
  return user;
}

const targetInput = () => screen.getByLabelText(/^Target (annual passive income|portfolio value)/);
const getGoal = async (query = '?portfolioId=default') => (await (await fetch(goalsUrl(query))).json()) as GoalResponse;

describe('GoalsPage', () => {
  afterEach(() => {
    server.events.removeAllListeners();
  });

  it('shows a loading region while the goal loads', async () => {
    server.use(http.get(goalsUrl(), () => new Promise(() => {})));
    renderApp('/goals?portfolio=default');
    expect(await screen.findByText('Loading your goal')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Goal settings' })).not.toBeInTheDocument();
  });

  it('shows the form, summary, chart, insights and the year-by-year table once loaded', async () => {
    renderApp('/goals?portfolio=default');
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeInTheDocument();
    expect(await screen.findByText(VERDICT, { selector: 'output' })).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Goal settings' });
    expect(within(form).getByRole('radio', { name: 'Passive income' })).toBeChecked();
    expect(within(form).getByLabelText('Target annual passive income (€)')).toHaveValue('24000');
    expect(within(form).getByText(sp('€ 2.000 per month'))).toBeInTheDocument();
    expect(within(form).getByLabelText('Monthly contribution (€)')).toHaveValue('250');
    expect(within(form).getByLabelText('Achieve by')).toHaveValue(String(new Date().getFullYear() + 30));
    expect(within(form).getByRole('button', { name: 'Reset' })).toBeDisabled();

    expect(screen.getByRole('list', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByText(/Your plan (reaches|does not reach) the goal/)).toBeInTheDocument();
    expect(screen.getByTestId('goal-chart')).toBeInTheDocument();
    expect(screen.getByRole('figure')).toHaveTextContent('The table below lists the same values');

    const table = screen.getByRole('table', { name: /Annual income per year/ });
    const headers = within(table).getAllByRole('columnheader').map((h) => sp(h.textContent ?? ''));
    expect(headers).toEqual(['Year', 'Goal', 'Contributions (€ 250/month)', 'Your plan', 'Safe', 'Alternative']);
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByRole('rowheader')).toHaveTextContent('Today');
    expect(rows.length).toBeGreaterThan(30);
    const target = rows.find((r) => r.getAttribute('aria-current') === 'true')!;
    expect(within(target).getByRole('rowheader')).toHaveTextContent(`${new Date().getFullYear() + 30}Target year`);
    expect(screen.getByText(/Forecasts are approximate/)).toBeInTheDocument();
  });

  it('marks the first year each scenario reaches the goal with a text badge', async () => {
    const user = await openGoals();
    await user.clear(targetInput());
    await user.type(targetInput(), '600');
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    await screen.findByText('Saved');
    const table = screen.getByRole('table', { name: /Annual income per year/ });
    const badges = await within(table).findAllByText('Goal reached');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(badges.length).toBeLessThanOrEqual(3);
    expect(badges[0]!.closest('td')).toHaveTextContent(/€ [\d.]+Goal reached/);
  });

  it('switches the goal type, adapting the labels, target and price return field', async () => {
    const user = await openGoals();
    await user.click(screen.getByRole('button', { name: 'Returns and inflation' }));
    expect(screen.queryByLabelText('Expected price return per year (%)')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Portfolio value' }));
    expect(screen.getByLabelText('Target portfolio value (€)')).toHaveValue('500000');
    expect(screen.getByLabelText('Expected price return per year (%)')).toHaveValue('5');
    expect(screen.getByText(/after inflation$/)).toBeInTheDocument();
    expect(await screen.findByText(/Preview of unsaved changes/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /Portfolio value per year/ })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Passive income' }));
    expect(screen.getByLabelText('Target annual passive income (€)')).toHaveValue('24000');
  });

  it('keeps a target the user typed when switching the goal type', async () => {
    const user = await openGoals();
    await user.clear(targetInput());
    await user.type(targetInput(), '1234');
    await user.click(screen.getByRole('radio', { name: 'Portfolio value' }));
    expect(screen.getByLabelText('Target portfolio value (€)')).toHaveValue('1234');
  });

  it('expands and collapses the returns and inflation section', async () => {
    const user = await openGoals();
    const toggle = screen.getByRole('button', { name: 'Returns and inflation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Dividend growth per year (%)')).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Dividend growth per year (%)')).toBeVisible();
    expect(screen.getByLabelText('Dividend yield today (%)')).toHaveAttribute('placeholder', expect.stringMatching(/^\d+,\d\d$/));
    expect(screen.getByLabelText('Dividend growth per year (%)')).toHaveValue('5');
    expect(screen.getByLabelText('Yield on new money (%)')).toHaveValue('3,5');
    expect(screen.getByLabelText('Inflation per year (%)')).toHaveValue('2');
    expect(screen.getByLabelText('Adjust goal for inflation')).toBeChecked();
    expect(screen.getByLabelText('Reinvest dividends')).toBeChecked();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles the inflation adjustment and the dividend reinvestment', async () => {
    const user = await openGoals();
    await user.click(screen.getByRole('radio', { name: 'Portfolio value' }));
    await user.click(screen.getByRole('button', { name: 'Returns and inflation' }));
    expect(screen.getByText(/after inflation$/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Adjust goal for inflation'));
    expect(screen.getByLabelText('Adjust goal for inflation')).not.toBeChecked();
    expect(screen.getByText('Not adjusted for inflation')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Reinvest dividends'));
    expect(screen.getByLabelText('Reinvest dividends')).not.toBeChecked();
    expect(await screen.findByText(/Preview of unsaved changes/)).toBeInTheDocument();
    const fieldset = screen.getByRole('group', { name: 'Goal type' });
    expect(within(fieldset).getAllByRole('radio')).toHaveLength(2);
  });

  it('shows inline errors for invalid input and does not save', async () => {
    const user = await openGoals();
    const saves: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PUT') saves.push(request.url);
    });
    await user.clear(targetInput());
    await user.tab();
    expect(await screen.findByText('Target amount must be a number between 1 and 1.000.000.000.')).toBeInTheDocument();
    expect(targetInput()).toHaveAttribute('aria-invalid', 'true');

    await user.clear(screen.getByLabelText('Monthly contribution (€)'));
    await user.type(screen.getByLabelText('Monthly contribution (€)'), 'abc');
    expect(screen.queryByText(/Monthly contribution must be/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(screen.getByText(/Monthly contribution must be a number between 0 and 1.000.000/)).toBeInTheDocument();
    expect(saves).toEqual([]);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('keeps the returns section open while one of its fields is invalid', async () => {
    const user = await openGoals();
    const toggle = screen.getByRole('button', { name: 'Returns and inflation' });
    await user.click(toggle);
    await user.clear(screen.getByLabelText('Inflation per year (%)'));
    await user.type(screen.getByLabelText('Inflation per year (%)'), '99');
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(screen.getByText(/Inflation must be a number between 0 and 30/)).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.clear(screen.getByLabelText('Inflation per year (%)'));
    await user.type(screen.getByLabelText('Inflation per year (%)'), '3');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('saves the goal, then reloads it from the server and resets it', async () => {
    const user = await openGoals();
    await user.clear(screen.getByLabelText('Monthly contribution (€)'));
    await user.type(screen.getByLabelText('Monthly contribution (€)'), '400');
    await user.clear(targetInput());
    await user.type(targetInput(), '6000');
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByText(/Preview of unsaved changes/)).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Contributions \(€\s400\/month\)/ })).toBeInTheDocument();

    const stored = await getGoal();
    expect(stored).toMatchObject({ saved: true, settings: { targetAmount: 6000, monthlyContribution: 400 } });
    // another scope is untouched
    expect((await getGoal('')).saved).toBe(false);

    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset).toBeEnabled();
    await user.click(reset);
    await waitFor(() => expect(screen.getByLabelText('Monthly contribution (€)')).toHaveValue('250'));
    expect(targetInput()).toHaveValue('24000');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect((await getGoal()).saved).toBe(false);
  });

  it('loads a saved goal when the page opens', async () => {
    await fetch(goalsUrl('?portfolioId=default'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goalType: 'value', targetAmount: 250000, targetYear: new Date().getFullYear() + 20, monthlyContribution: 500, adjustForInflation: false }),
    });
    await openGoals();
    expect(screen.getByRole('radio', { name: 'Portfolio value' })).toBeChecked();
    expect(targetInput()).toHaveValue('250000');
    expect(screen.getByText('Not adjusted for inflation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();
    expect(screen.queryByText(/Preview of unsaved changes/)).not.toBeInTheDocument();
  });

  it('previews valid unsaved changes without saving, and falls back to the saved result when they become invalid', async () => {
    const user = await openGoals();
    const posts: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST') posts.push(request.url);
    });
    const before = verdict().textContent;
    await user.clear(screen.getByLabelText('Monthly contribution (€)'));
    await user.type(screen.getByLabelText('Monthly contribution (€)'), '5000');
    expect(await screen.findByText(/Preview of unsaved changes/)).toBeInTheDocument();
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts.every((u) => u.includes('/goals/calculate') && u.includes('portfolioId=default'))).toBe(true);
    await waitFor(() => expect(verdict().textContent).not.toBe(before));
    expect((await getGoal()).saved).toBe(false);

    await user.clear(screen.getByLabelText('Monthly contribution (€)'));
    await user.type(screen.getByLabelText('Monthly contribution (€)'), 'x');
    expect(screen.queryByText(/Preview of unsaved changes/)).not.toBeInTheDocument();
    expect(verdict().textContent).toBe(before);
  });

  it('reports a failed preview', async () => {
    const user = await openGoals();
    server.use(http.post(goalsUrl('/calculate'), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));
    await user.clear(screen.getByLabelText('Monthly contribution (€)'));
    await user.type(screen.getByLabelText('Monthly contribution (€)'), '300');
    expect(await screen.findByText(/Could not calculate the preview: Boom/)).toBeInTheDocument();
  });

  it('shows the error message of a failed save and maps server field errors', async () => {
    const user = await openGoals();
    server.use(http.put(goalsUrl(), () => HttpResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid goal', details: [{ path: ['targetAmount'] }, { path: ['targetYear'] }] } }, { status: 400 })));
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(await screen.findByText('Invalid goal')).toBeInTheDocument();
    expect(screen.getByText('Target amount must be a number between 1 and 1.000.000.000.')).toBeInTheDocument();
    expect(screen.getByLabelText('Achieve by')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Target year must be a number between 1.900 and 3.000.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Monthly contribution (€)'), '0');
    expect(screen.queryByText('Invalid goal')).not.toBeInTheDocument();
  });

  it('shows progress while saving and resetting, and whether there are unsaved changes', async () => {
    server.use(
      http.put(goalsUrl(), async () => {
        await delay(150);
        return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Slow failure' } }, { status: 500 });
      }),
    );
    const user = await openGoals();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Achieve by'), String(new Date().getFullYear() + 10));
    expect(await screen.findByText('Not saved yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(await screen.findByText('Slow failure')).toBeInTheDocument();
  });

  it('shows progress while resetting and flags edits to a saved goal', async () => {
    const user = await openGoals();
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Monthly contribution (€)'), '5');
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    server.use(
      http.delete(goalsUrl(), async () => {
        await delay(150);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByRole('button', { name: 'Resetting…' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resetting…' })).not.toBeInTheDocument());
  });

  it('shows the error of a failed reset', async () => {
    const user = await openGoals();
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    server.use(http.delete(goalsUrl(), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Cannot reset' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText('Cannot reset')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the goal cannot be loaded', async () => {
    server.use(http.get(goalsUrl(), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Down' } }, { status: 500 }), { once: true }));
    const user = userEvent.setup();
    renderApp('/goals?portfolio=default');
    expect(await screen.findByText('Could not load your goal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByText(VERDICT, { selector: 'output' })).toBeInTheDocument();
  });

  it('starts from zero for a scope without holdings', async () => {
    resetDb({ empty: true });
    await openGoals('/goals?portfolio=default');
    expect(screen.getByText('There are no holdings in this scope yet, so the projection starts from zero.')).toBeInTheDocument();
  });

  it('follows the portfolio scope of the URL', async () => {
    const urls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/goals')) urls.push(request.url);
    });
    await openGoals('/goals?portfolio=trading-212');
    await openGoals('/goals?portfolio=all');
    expect(urls.some((u) => u.includes('portfolioId=trading-212'))).toBe(true);
    expect(urls.some((u) => !u.includes('portfolioId'))).toBe(true);
  });

  it('lists all parameters, scenario adjustments and the solver explanation in an expandable panel', async () => {
    const user = await openGoals();
    const summary = screen.getByText('All parameters and scenarios');
    await user.click(summary);
    const panel = summary.closest('details')!;
    expect(panel).toHaveAttribute('open');
    const table = within(panel).getByRole('table', { name: 'Parameters used per scenario' });
    expect(within(table).getAllByRole('row').map((r) => within(r).queryAllByRole('rowheader')[0]?.textContent).filter(Boolean)).toEqual(['Your plan', 'Safe', 'Alternative']);
    expect(within(panel).getByText(/Dividend cuts and market crashes are not modelled/)).toBeInTheDocument();
    expect(within(panel).getByText(/Safe: \u22122 points price return/)).toBeInTheDocument();
    expect(within(panel).getByText(/found by bisection/)).toBeInTheDocument();
    expect(within(panel).getByText(/For passive-income goals the price return plays no role/)).toBeInTheDocument();
  });

  it('explains the value-goal model in the parameters panel', async () => {
    const user = await openGoals();
    await user.click(screen.getByRole('radio', { name: 'Portfolio value' }));
    await user.click(screen.getByText('All parameters and scenarios'));
    expect(await screen.findByText(/Price return only applies to portfolio-value goals/)).toBeInTheDocument();
  });

  it('downloads the table as CSV', async () => {
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:goal';
      }),
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('goal-projection.csv');
    });
    const user = await openGoals();
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(click).toHaveBeenCalledOnce();
    const text = await blobs[0]!.text();
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('year,goal,contributions,your_plan,safe,alternative');
    expect(lines[1]).toMatch(/^\d{4},24000,0,\d+(\.\d+)?,\d+(\.\d+)?,\d+(\.\d+)?$/);
    expect(lines.length).toBeGreaterThan(30);
  });

  it('is reachable from the main navigation', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await gotoViaNav(user, 'Goals');
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeInTheDocument();
    await screen.findByText(VERDICT, { selector: 'output' });
    await waitFor(() => expect(document.title).toBe('Goals · Portfolio Tracker'));
  });
});

